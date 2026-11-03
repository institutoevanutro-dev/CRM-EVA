import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { hashKey } from "@tanstack/react-query";
import type {
  ConversationsFilters,
  ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";
import { comandoDaConversa, type ComandoDoBanco } from "@/lib/inbox/comando-da-conversa";
import { CONVERSATION_TERMINAL_STATUSES } from "@/lib/schemas/messaging";
import { marcadoresEscolhidos } from "@/lib/inbox/marcador-da-conversa";

/**
 * O EVENTO DE UMA CONVERSA ENTRA NA LISTA QUE JÁ ESTÁ NA TELA (#2366).
 *
 * Portado do projeto original (DeskcommCRM, PR #3806 de @webtecnica), adaptado.
 *
 * ─── O defeito que este arquivo fecha ───────────────────────────────────────
 * Uma conversa muda sem mensagem nova (lida por outra recepção, encerrada,
 * etiquetada, ocultada), o Realtime entrega um `UPDATE` de
 * `public.conversations`, e o inbox tratava TODO evento como "a lista inteira
 * está velha": busca completa. Para um evento que mudou UMA linha, a tela
 * refazia a lista — com a linha afetada mostrando os valores VELHOS até a
 * resposta chegar.
 *
 * ─── O que este arquivo resolve, e o que devolve ao servidor ────────────────
 * O evento traz a linha (`new`). Quando ela já está na lista aberta e o evento
 * responde sozinho se ela continua na aba, a linha muda no LUGAR dela (ordem,
 * seleção e rolagem ficam) e nada é buscado. Em todo o resto
 * `aplicarAtualizacaoNaLista` devolve `false` e a recarga agrupada de sempre
 * acontece:
 *  - INSERT/DELETE, e conversa que não está na lista (pode ter ENTRADO na aba);
 *  - busca da lista em voo: a resposta foi pedida ANTES do evento e, ao chegar,
 *    apagaria a linha mesclada;
 *  - o que muda a ordem ou o que a rota resolve (`pedeOServidor`);
 *  - busca, etiqueta e a aba Ocultos (`julgarAtualizacao` → `indecidivel`);
 *  - a pausa curta do automático perto do fim, na Fila e no Automático.
 *
 * É conservador de propósito: errar para o lado do servidor custa uma busca;
 * errar para o outro deixa na tela um estado que o servidor não tem.
 */

/** Uma página da lista, como o `useInfiniteQuery` a guarda. */
interface PaginaDaLista {
  data: ConversationWithContact[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

type ListaEmCache = InfiniteData<PaginaDaLista>;

/**
 * Os embeds que a ROTA resolve e o evento de `conversations` não carrega: mesclar
 * por cima apagaria o nome do cliente e o número do canal da linha.
 *
 * `assigned_to_user_name` NÃO está aqui: no fork é coluna (migration 0202), que
 * `fn_conversation_assign` grava no MESMO UPDATE do dono — o evento a traz junto.
 * `etapa_atual` (resolvida na rota) e `comando_da_conversa` (campo calculado,
 * migration 0203) nunca vêm no evento; ausente não sobrescreve, então ficam os
 * valores em cache.
 */
const RESOLVIDOS_NA_ROTA = new Set(["contacts", "channel_sessions"]);

/**
 * OS CAMPOS QUE O EVENTO NÃO SABE APLICAR — mudou um deles, a recarga decide.
 *
 *  - a ORDEM da lista é da rota: `last_message_at` desc fora da Fila,
 *    `awaiting_since` asc na Fila, com desempate por `id` e cursor. Mesclar no
 *    lugar deixaria a conversa que acabou de receber mensagem na posição velha;
 *  - `contact_id`: a rota monta o embed do contato a partir dele, e "Juntar
 *    fichas" o troca;
 *  - `channel_session_id`: a rota monta o embed do canal a partir dele;
 *  - `bot_silenced_until`: passar para a equipe e devolver ao automático mexem
 *    também em `contacts.force_human`, para TODAS as conversas do contato
 *    (`lib/agent-engine/agent/human-handoff.ts` liga a trava no contato e cala uma
 *    conversa só; `lib/escalacao/retomada.ts` atualiza a conversa e limpa a trava
 *    num UPDATE de `contacts` à parte) — e este canal só escuta `conversations`.
 */
const CAMPOS_DO_SERVIDOR = [
  "last_message_at",
  "awaiting_since",
  "last_inbound_at",
  "last_outbound_at",
  "contact_id",
  "channel_session_id",
  "bot_silenced_until",
] as const;

/**
 * A atualização pede o servidor?
 *
 * Linha cujo contato em cache está com a equipe (`force_human`) ou descadastrado
 * (`is_blocked`) vai sempre: `comandoDaConversa` decide quem responde a partir
 * desses dois fatos do CONTATO, e nenhum evento de `conversations` diz se eles
 * mudaram — "Devolver ao automático" limpa `force_human` num UPDATE que este
 * canal nunca vê.
 */
export function pedeOServidor(
  anterior: ConversationWithContact,
  atualizacao: Record<string, unknown>,
): boolean {
  if (anterior.contacts?.force_human === true || anterior.contacts?.is_blocked === true) return true;
  return CAMPOS_DO_SERVIDOR.some((campo) => {
    const valor = atualizacao[campo];
    if (valor === undefined) return false;
    return valor !== (anterior as unknown as Record<string, unknown>)[campo];
  });
}

/**
 * A linha de `conversations` que um evento do Realtime entrega — só para
 * `UPDATE`, e só com `id`.
 *
 * INSERT e DELETE ficam de fora de propósito: os dois mudam QUAIS conversas
 * pertencem à lista, e é exatamente o que o cliente não tem como decidir. A
 * entrega sintética `{ tipo: "reassinado" }` (canal que voltou) não tem
 * `eventType` e também cai aqui — ela pede a recarga inteira.
 */
export function conversaAtualizada(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const evento = payload as { eventType?: unknown; table?: unknown; new?: unknown };
  if (evento.eventType !== "UPDATE") return null;
  if (typeof evento.table === "string" && evento.table !== "conversations") return null;
  const linha = evento.new;
  if (!linha || typeof linha !== "object") return null;
  const id = (linha as { id?: unknown }).id;
  if (typeof id !== "string" || id.length === 0) return null;
  return linha as Record<string, unknown>;
}

/**
 * A linha em cache com os valores do evento por cima — mantendo o que o evento
 * não sabe (`RESOLVIDOS_NA_ROTA`).
 *
 * `undefined` não sobrescreve: no payload do Realtime, ausente significa "não veio
 * nesta entrega" (coluna TOAST sem mudança, payload cortado), nunca "foi apagado".
 */
export function mesclarConversa(
  anterior: ConversationWithContact,
  atualizacao: Record<string, unknown>,
): ConversationWithContact {
  const mesclada: Record<string, unknown> = { ...anterior };
  for (const [campo, valor] of Object.entries(atualizacao)) {
    if (valor === undefined || RESOLVIDOS_NA_ROTA.has(campo)) continue;
    mesclada[campo] = valor;
  }
  return mesclada as unknown as ConversationWithContact;
}

/** O que a atualização faz com a conversa, do ponto de vista do filtro da aba. */
export type Julgamento = "fica" | "sai" | "indecidivel";

/**
 * A FOLGA DO RELÓGIO: uma pausa que termina depois de `agora - 10 min` fica com o
 * servidor.
 *
 * `comandoDaConversa` lê o relógio do NAVEGADOR; a rota compara com o `now()` do
 * banco (migration 0203). As pausas por resposta da equipe duram de 5 min a 24 h
 * (`lib/escalacao/pausa-por-resposta-humana.ts`), então o fim de uma delas cai a
 * toda hora dentro da janela em que um PC adiantado já a dá por vencida — e
 * tiraria da Fila um paciente que o servidor ainda mostra esperando. Pausa vencida
 * há mais que a folga é decidida aqui: a coluna guarda pausas vencidas por muito
 * tempo, e mandá-las todas ao servidor anularia o ganho na Fila.
 */
const FOLGA_DO_RELOGIO_MS = 10 * 60_000;

/**
 * A conversa ainda pertence a esta lista depois da atualização?
 *
 * A régua é a MESMA dos filtros que a rota pede ao banco
 * (`app/api/v1/conversations/_handler.ts`), aplicada sobre o par (linha em cache,
 * evento). Onde o evento não responde, `indecidivel`: chutar "fica" seria a tela
 * afirmando um estado que não é o do servidor.
 */
export function julgarAtualizacao(
  anterior: ConversationWithContact,
  atualizacao: Record<string, unknown>,
  filtros: ConversationsFilters,
  agora: Date = new Date(),
): Julgamento {
  // Busca livre e etiqueta: a busca olha o contato e o marcador olha TAMBÉM
  // `contacts.tags_do_contato`. Nenhum dos dois está no evento de `conversations`.
  if (filtros.search?.trim()) return "indecidivel";
  const marcadores = marcadoresEscolhidos(
    typeof filtros.tag === "string" ? [filtros.tag] : (filtros.tag ?? []),
  );
  if (marcadores.length > 0) return "indecidivel";
  // A aba Ocultos (migration 0372) mostra o que a equipe tirou do Inbox; quem
  // entra e sai dela é o servidor que decide.
  if (filtros.ocultos) return "indecidivel";

  const atual = mesclarConversa(anterior, atualizacao);

  // Contato oculto do Inbox: toda aba normal o esconde (`semContatoOculto`).
  if (atual.contato_oculto === true) return "sai";

  if (filtros.status) {
    // `readonly string[]` e não o tipo do filtro: a linha do evento chega como
    // `string`, e o que se compara aqui é o VALOR, não o vocabulário.
    const aceitos: readonly string[] =
      typeof filtros.status === "string" ? [filtros.status] : filtros.status;
    if (!aceitos.includes(atual.status)) return "sai";
  }
  // A régua do `exclude_finished` é a da rota (`CONVERSATION_TERMINAL_STATUSES`),
  // não `STATUS_ENCERRADOS`: esse responde "quem manda" e inclui `resolved`, que a
  // rota NÃO esconde.
  const terminais: readonly string[] = CONVERSATION_TERMINAL_STATUSES;
  if (filtros.exclude_finished && terminais.includes(atual.status)) return "sai";

  if (filtros.assigned_to === "me") {
    // Na rota do fork, Minhas é só `assigned_to_user_id = eu`: o dono em cache é
    // sempre quem olha, e "sai" seria decidível. Dono trocado fica com o servidor
    // de propósito — ele confirma a transferência.
    if (atual.assigned_to_user_id !== anterior.assigned_to_user_id) return "indecidivel";
  } else if (filtros.assigned_to === "unassigned") {
    if (atual.assigned_to_user_id != null) return "sai";
  } else if (filtros.assigned_to) {
    if (atual.assigned_to_user_id !== filtros.assigned_to) return "sai";
  }

  if (filtros.unread && (atual.unread_count_for_assignee ?? 0) <= 0) return "sai";
  if (filtros.channel_session_id && atual.channel_session_id !== filtros.channel_session_id) {
    return "sai";
  }
  if (filtros.canal && atual.channel !== filtros.canal) return "sai";

  if (filtros.comando && filtros.comando.length > 0) {
    const fim =
      typeof atual.bot_silenced_until === "string" ? Date.parse(atual.bot_silenced_until) : NaN;
    if (Number.isFinite(fim) && fim > agora.getTime() - FOLGA_DO_RELOGIO_MS) return "indecidivel";
    // `comandoDaConversa` é a régua única de "quem manda" (a linha da lista usa a
    // MESMA). O fato org-wide vai `undefined` = "não sei", que a função trata
    // assumindo que há automático — e a Fila de uma org sem automático pede
    // `aguardando` e `automatico` juntos (`comandosDaFila`), então a ambiguidade
    // não muda a resposta.
    const { comando } = comandoDaConversa(
      {
        status: String(atual.status),
        assigned_to_user_id: atual.assigned_to_user_id ?? null,
        assigned_to_user_name: atual.assigned_to_user_name ?? null,
        assignee_kind: atual.assignee_kind ?? null,
        bot_silenced_until: atual.bot_silenced_until ?? null,
        force_human: atual.contacts?.force_human ?? null,
        is_blocked: atual.contacts?.is_blocked ?? null,
      },
      agora,
    );
    // `ninguem` é o mesmo balde do `automatico` no vocabulário do banco.
    const noVocabularioDoBanco: ComandoDoBanco =
      comando.quem === "ninguem" ? "automatico" : comando.quem;
    if (!filtros.comando.includes(noVocabularioDoBanco)) return "sai";
  }

  return "fica";
}

/** A lista com a linha trocada no LUGAR dela — ou removida, quando ela sai da aba. */
function mesclarPaginas(
  listas: ListaEmCache | undefined,
  atualizacao: Record<string, unknown>,
  julgamento: Exclude<Julgamento, "indecidivel">,
): ListaEmCache | undefined {
  if (!listas) return listas;
  const id = atualizacao.id as string;
  return {
    ...listas,
    pages: listas.pages.map((pagina) => {
      const indice = pagina.data.findIndex((c) => c.id === id);
      if (indice < 0) return pagina;
      const anterior = pagina.data[indice];
      if (!anterior) return pagina;
      if (julgamento === "sai") return { ...pagina, data: pagina.data.filter((c) => c.id !== id) };
      const data = pagina.data.slice();
      data[indice] = mesclarConversa(anterior, atualizacao);
      return { ...pagina, data };
    }),
  };
}

/**
 * Aplica o evento na lista que está na tela.
 *
 * Devolve `true` quando o evento foi resolvido SEM rede; o chamador só chama a
 * recarga quando isto devolve `false` (ver o cabeçalho do arquivo).
 */
export function aplicarAtualizacaoNaLista(
  qc: QueryClient,
  chaveAtiva: readonly unknown[],
  filtrosAtivos: ConversationsFilters,
  payload: unknown,
): boolean {
  const atualizacao = conversaAtualizada(payload);
  if (!atualizacao) return false;
  const id = atualizacao.id as string;

  const naAtiva = qc
    .getQueryData<ListaEmCache>(chaveAtiva)
    ?.pages.flatMap((p) => p.data)
    .find((c) => c.id === id);
  if (!naAtiva) return false;
  // Busca em voo (a lista, o "Carregar mais", a rede de 45 s): a resposta dela
  // foi pedida antes deste evento e, ao chegar, sobrescreveria a mescla.
  if (qc.isFetching({ queryKey: ["conversations"] }) > 0) return false;
  if (pedeOServidor(naAtiva, atualizacao)) return false;
  const julgamento = julgarAtualizacao(naAtiva, atualizacao, filtrosAtivos);
  if (julgamento === "indecidivel") return false;

  qc.setQueryData<ListaEmCache>(chaveAtiva, (listas) =>
    mesclarPaginas(listas, atualizacao, julgamento),
  );

  // As OUTRAS abas em cache ficam marcadas como velhas, sem julgar cada uma: a
  // que voltar a ser aberta se recarrega. O `refetchType` padrão (`active`) não
  // custa GET no uso normal — a única lista ativa é esta, excluída aqui — e
  // cobre a troca de aba: o `onChange` do canal é trocado num efeito
  // (`useRealtimeChannel`), então um evento pode chegar com a aba ANTERIOR
  // nesta chamada; aí a lista que acabou de ficar ativa se recarrega.
  const ativa = hashKey(chaveAtiva);
  void qc.invalidateQueries({ queryKey: ["conversations"], predicate: (q) => q.queryHash !== ativa });

  // A conversa aberta, quando está em cache (fora dele o updater devolve
  // `undefined` e nada é criado): o cabeçalho não pode ler o estado anterior ao
  // evento. Mesma linha, mesma mescla, zero rede.
  qc.setQueryData<ConversationWithContact>(["conversation", id], (aberta) =>
    aberta ? mesclarConversa(aberta, atualizacao) : aberta,
  );

  return true;
}
