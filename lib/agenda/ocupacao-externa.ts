/**
 * A ocupação do Google Agenda que a TELA da Agenda mostra — uma leitura só.
 *
 * ─── Por que este módulo existe ─────────────────────────────────────────────
 *
 * A mesma ocupação era lida em DOIS lugares, com a MESMA consulta copiada: a
 * semente do servidor (`app/app/agenda/page.tsx`) e a resposta da rota
 * (`app/api/v1/agenda/agendamentos/route.ts`). Duas cópias da mesma regra
 * divergem no dia em que só uma delas muda — é o defeito da issue #525.
 *
 * ─── O recorte é INTERSEÇÃO de intervalos ───────────────────────────────────
 *
 * O motor de disponibilidade (`fn_agenda_ocupacao_google_do_dono`, migration
 * 0260) considera o compromisso ocupado quando `starts_at < fim AND ends_at >
 * inicio` — sobreposição real de intervalos. A tela comparava só o COMEÇO
 * (`starts_at >= inicio AND starts_at < fim`), então o compromisso que ATRAVESSA
 * o limite do recorte — 23:30 de ontem até 00:30 de hoje, pedindo o recorte de
 * hoje — sumia da grade enquanto o motor o recusava marcar: a tela mostrava
 * livre o horário que a marcação recusa. Quem mede os dois lados é
 * `tests/unit/agenda-recorte-do-google-atravessa-o-limite.test.ts`.
 *
 * ─── O que o bloco devolvido descreve ───────────────────────────────────────
 *
 * A FATIA VISÍVEL dentro do recorte pedido. `GradeDaAgenda` atribui cada bloco à
 * coluna do dia pelo seu INÍCIO (`isSameDay(comeca, coluna)`): devolver o
 * instante cru de um evento que começa antes do recorte jogaria o bloco para
 * fora de toda coluna desenhada — a tela ficaria vazia de novo, agora por outro
 * motivo. Fatiar no limite do recorte é o que faz a tela desenhar a ocupação que
 * o motor já recusava.
 *
 * Mesma decisão do motor, um limite a mais: um compromisso que ACABA exatamente
 * no começo do recorte não ocupa nenhum minuto dele, e um que COMEÇA exatamente
 * no fim também não — as duas comparações são estritas.
 *
 * ─── O que fica de fora ─────────────────────────────────────────────────────
 *
 * `transparent` no Google é "livre": o evento existe e não ocupa. `cancelled`
 * não aconteceu. Trazer os dois como bloco diria que o horário está tomado
 * quando a própria pessoa marcou que não está — o mesmo filtro que a coleta do
 * motor aplica.
 *
 * ─── A ocupação é lida PELA FUNÇÃO DO DONO, não pelo embed da sessão ───────
 *
 * ⚠️ ESTE ARQUIVO JÁ LEU `calendar_selected_external_events` com o embed
 * `calendar_connections!inner`, pela SESSÃO de quem abriu a tela. A RLS de
 * `calendar_connections` (`calendar_connections_dono_ou_manager_read`, em
 * `supabase/baseline.sql`) só libera `user_id = auth.uid()` ou
 * `fn_role_at_least(organization_id, 'manager')` — então, para a recepção, a
 * conexão da médica ficava escondida e a grade desenhava LIVRE todo compromisso
 * dela. O motor de disponibilidade, não: ele pergunta a
 * `fn_agenda_ocupacao_google_do_dono` (migration 0260), que é `security definer`
 * e entrega a ocupação a todo membro da organização. A recepção via a vaga
 * aberta, tentava marcar, e a marcação recusava com "fora dos horários que você
 * publicou" — o motivo errado.
 *
 * Agora a tela pergunta ONDE O MOTOR PERGUNTA, com `p_owner` explícito: a
 * resposta não depende de QUEM OLHA. Quem chama passa a lista de donos —
 * `donosDaAgenda()` (`lib/agenda/donos-da-agenda.ts`), que também decide o
 * alcance do Prestador (só a própria agenda). São N chamadas, uma por dono.
 *
 * Os filtros de `transparent`/`cancelled` ficam DESTE lado: a função devolve os
 * dois campos e quem lê decide — a mesma regra da coleta do motor
 * (`coletaOQueOcupa`).
 *
 * Porte de melgarafael/DeskcommCRM 42c558397 (issue #896, item 3).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Um compromisso externo como a tela o desenha: rótulo, dono e a fatia do recorte. */
export interface BlocoExternoDaTela {
  id: string;
  /** `calendar_connections.user_id` — a agenda dona do compromisso. */
  donoId: string | null;
  /** ISO — começo da fatia visível (nunca antes de `de`). */
  iniciaEm: string;
  /** ISO — fim da fatia visível (nunca depois de `ate`). */
  terminaEm: string;
}

export interface RecorteDaAgenda {
  organizationId: string;
  /** ISO — começo do recorte pedido pela tela. */
  de: string;
  /** ISO — fim do recorte pedido pela tela (o motor também trata o fim como exclusivo). */
  ate: string;
}

export interface LeituraDaOcupacaoExterna {
  blocos: BlocoExternoDaTela[];
  /**
   * Mensagem do banco, quando a leitura falha. A decisão de derrubar ou não a
   * tela é de QUEM chama: na rota, sem ocupação a grade fica pobre e sem
   * agendamento ela fica errada — o `warn` fica lá; na semente, a página segue.
   *
   * Pode vir ACOMPANHADO de blocos: a falha de um dono não derruba a ocupação
   * dos outros (são N leituras).
   */
  erro: string | null;
}

/**
 * A linha como `fn_agenda_ocupacao_google_do_dono` a entrega. Não há `id`: a
 * função devolve OCUPAÇÃO (início, fim, transparência, situação), nunca a
 * identidade do compromisso. O identificador da tela é derivado (ver abaixo).
 */
interface LinhaDaOcupacaoDoGoogle {
  starts_at: string;
  ends_at: string;
  transparency?: string | null;
  status?: string | null;
}

const instante = (iso: string): number => new Date(iso).getTime();

/** O mais TARDE dos dois instantes — o começo da fatia visível. */
const maisTarde = (a: string, b: string): string => (instante(a) >= instante(b) ? a : b);

/** O mais CEDO dos dois instantes — o fim da fatia visível. */
const maisCedo = (a: string, b: string): string => (instante(a) <= instante(b) ? a : b);

/**
 * A ocupação do Google de CADA dono da lista, fatiada no recorte.
 *
 * Leitura única de propósito: a semente e a rota pedem a MESMA coisa, e a
 * resposta é a mesma. Lista de donos vazia devolve zero blocos e NÃO é erro.
 */
export async function lerOcupacaoExterna(
  supabase: SupabaseClient,
  recorte: RecorteDaAgenda,
  donos: readonly string[],
): Promise<LeituraDaOcupacaoExterna> {
  if (donos.length === 0) return { blocos: [], erro: null };

  // INTERSEÇÃO de intervalos — a MESMA conta do motor, feita do lado de lá pela
  // função: ocupa o recorte o compromisso que COMEÇA antes do fim E TERMINA
  // depois do começo (issue #525).
  const leituras = await Promise.all(
    donos.map(async (dono) => {
      const { data, error } = await supabase.rpc("fn_agenda_ocupacao_google_do_dono", {
        p_org: recorte.organizationId,
        p_owner: dono,
        p_de: recorte.de,
        p_ate: recorte.ate,
      });
      return { dono, linhas: (data ?? []) as unknown as LinhaDaOcupacaoDoGoogle[], error };
    }),
  );

  // Um dono que falha NÃO apaga a ocupação dos outros: a grade inteira parecer
  // livre de novo é exatamente o defeito que esta leitura existe para consertar.
  const falhou = leituras.find((leitura) => leitura.error);

  const blocos: BlocoExternoDaTela[] = leituras
    .filter((leitura) => !leitura.error)
    .flatMap(({ dono, linhas }) =>
      linhas
        // `transparent` no Google é "livre": existe e não ocupa. `cancelled` não
        // aconteceu. Mesmo filtro da coleta do motor — a regra é uma só.
        .filter((linha) => linha.transparency !== "transparent" && linha.status !== "cancelled")
        .map((linha) => ({
          // DERIVADO: a função não devolve `id`. Dono + fatia visível bastam
          // para a chave do React — dois blocos do mesmo dono com a MESMA fatia
          // são indistinguíveis na tela por definição.
          id: `${dono}:${fatiaDe(linha.starts_at, recorte)}:${fatiaAte(linha.ends_at, recorte)}`,
          donoId: dono,
          // A FATIA VISÍVEL: o bloco não começa antes do recorte nem termina
          // depois dele. `GradeDaAgenda` atribui cada bloco à coluna do dia pelo
          // INÍCIO — com o instante cru, o compromisso que vem de ontem cairia
          // fora de toda coluna desenhada e sumiria da tela de novo.
          iniciaEm: fatiaDe(linha.starts_at, recorte),
          terminaEm: fatiaAte(linha.ends_at, recorte),
        })),
    );

  // São N respostas, uma por dono: quem desenha casa bloco com coluna pelo
  // INÍCIO, então a lista sai ordenada por ele.
  blocos.sort((a, b) => instante(a.iniciaEm) - instante(b.iniciaEm));

  return { blocos, erro: falhou?.error?.message ?? null };
}

/**
 * O começo da fatia visível — nunca antes do começo do recorte.
 *
 * `toISOString()` porque o limite do recorte é texto de QUEM CHAMOU: a rota
 * aceita `2026-09-16T00:00:00-03:00`, e devolver esse literal faria a mesma
 * resposta misturar dois formatos de data.
 */
const fatiaDe = (inicio: string, recorte: RecorteDaAgenda): string =>
  new Date(maisTarde(inicio, recorte.de)).toISOString();

/** O fim da fatia visível — nunca depois do fim do recorte. */
const fatiaAte = (fim: string, recorte: RecorteDaAgenda): string =>
  new Date(maisCedo(fim, recorte.ate)).toISOString();
