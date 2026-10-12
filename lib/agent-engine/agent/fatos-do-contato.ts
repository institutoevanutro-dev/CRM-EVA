/**
 * OS FATOS DA AGENDA DESTE CONTATO, EM TEXTO, PARA O CLASSIFICADOR DO ROTEADOR.
 *
 * ─── O que faltava ──────────────────────────────────────────────────────────
 *
 * O classificador recebia só a mensagem. "Quero marcar um retorno" de quem
 * nunca pisou na clínica e de quem consultou na semana passada chegavam iguais,
 * e ele não tinha como distinguir paciente novo de antigo (medido em
 * 11/10/2026). O que separa os dois não está na mensagem: está na agenda.
 *
 * ─── A armadilha herdada de compromissos-do-contato.ts ──────────────────────
 *
 * No motor, `leadId` É o `contact_id`. O parâmetro aqui se chama `contactId`, e
 * quem chama tem de olhar para o valor antes de passar.
 *
 * ─── O que entra no texto, e o que nunca entra ──────────────────────────────
 *
 * Data local, nome do tipo (ou título) e situação. Nada de nome do contato,
 * telefone, notas ou link de reunião: o classificador escolhe um agente, não
 * atende ninguém. Cancelado e falta ficam fora dos passados, senão quem só
 * desmarcou viraria "já é paciente".
 *
 * A situação sai por extenso, e passado não é sinônimo de realizado: quem
 * marcou e nunca veio fica `confirmed` para sempre, e "confirmado, sem desfecho
 * registrado" não pode ser lido como atendimento que aconteceu.
 *
 * O título é texto livre e pode trazer o nome do contato (evento vindo do
 * Google, por exemplo). Ele só serve de tipo no compromisso importado do
 * histórico, que guarda ali o nome do procedimento; nos demais, "atendimento".
 */
import type { Queryable } from "../queue/queue";
import { isoLocalComOffset } from "@/lib/tempo/agora";
import { FUSO_PADRAO, fusoValido } from "@/lib/tempo/fusos";

export const MAXIMO_DE_ANTERIORES = 5;
export const MAXIMO_DE_FUTUROS = 3;

/** O título é texto livre de quem cadastrou: cabe numa linha e não passa disto. */
const MAXIMO_DO_TIPO = 80;

export interface FatoDeAgenda {
  /** Nome do tipo, ou título, ou "atendimento". */
  tipo: string;
  starts_at: string | Date;
  time_zone?: string | null;
  status: string;
}

export interface FatosDoContato {
  /** Até MAXIMO_DE_ANTERIORES + 1: a linha extra só sinaliza que houve corte. */
  anteriores: FatoDeAgenda[];
  /** Até MAXIMO_DE_FUTUROS + 1. */
  futuros: FatoDeAgenda[];
}

// `to_jsonb(a)->>'history_import_key'` e não a coluna direta: mesma leitura de
// lib/agenda/importar-historico.ts, que não quebra num banco sem a coluna.
const PROJECAO = (quando: Quando) => `select '${quando}'::text as quando, a.id, coalesce(
              nullif(btrim(t.name), ''),
              case when to_jsonb(a)->>'history_import_key' is not null then nullif(btrim(a.title), '') end,
              'atendimento'
            ) as tipo,
            a.starts_at, a.time_zone, a.status
       from calendar_appointments a
       -- o filtro de organização do tipo é defesa em profundidade
       left join calendar_event_types t
         on t.id = a.event_type_id and t.organization_id = a.organization_id
      where a.organization_id = $1
        and a.contact_id = $2`;

type Quando = "passado" | "futuro";

/**
 * As duas metades numa consulta só: uma conexão do pool por turno, não duas.
 * Cada metade tem seu teto e sua ordem; o `order by` de fora repete essa ordem,
 * porque `union all` não promete devolver as linhas na ordem das metades.
 */
export async function fatosDoContato(
  db: Queryable,
  organizationId: string,
  contactId: string,
  agora: Date,
): Promise<FatosDoContato> {
  const { rows } = await db.query<FatoDeAgenda & { quando: Quando }>(
    `select quando, tipo, starts_at, time_zone, status from (
       (${PROJECAO("passado")}
          and a.ends_at < $3
          and a.status not in ('cancelled', 'no_show')
        order by a.starts_at desc, a.id
        limit $4)
       union all
       (${PROJECAO("futuro")}
          and a.ends_at >= $3
          and a.status in ('pending', 'confirmed')
        order by a.starts_at asc, a.id
        limit $5)
     ) f
     order by quando,
              case when quando = 'passado' then starts_at end desc,
              case when quando = 'futuro' then starts_at end asc,
              id`,
    [organizationId, contactId, agora.toISOString(), MAXIMO_DE_ANTERIORES + 1, MAXIMO_DE_FUTUROS + 1],
  );
  const metade = (q: Quando): FatoDeAgenda[] =>
    rows
      .filter((r) => r.quando === q)
      .map(({ tipo, starts_at, time_zone, status }) => ({ tipo, starts_at, time_zone, status }));
  return { anteriores: metade("passado"), futuros: metade("futuro") };
}

/**
 * A situação, dita com o sentido que ela tem em cada metade. Status fora do
 * mapa sai como veio do banco: não se inventa situação.
 */
const SITUACAO: Record<Quando, Record<string, string>> = {
  passado: {
    completed: "realizado",
    confirmed: "confirmado, sem desfecho registrado",
    pending: "pendente, sem desfecho registrado",
  },
  futuro: {
    confirmed: "confirmado",
    pending: "aguardando confirmação",
  },
};

function linha(fatos: readonly FatoDeAgenda[], maximo: number, quando: Quando): string {
  if (fatos.length === 0) return "nenhum";
  const itens = fatos.slice(0, maximo).map((f) => {
    const fuso = f.time_zone && fusoValido(f.time_zone) ? f.time_zone : FUSO_PADRAO;
    // O driver pg devolve Date; a data é a de parede no fuso da reserva, não a
    // do processo (UTC). dd/mm/aaaa montado das partes, sem nomear idioma: isto
    // é texto de prompt, não interface, e o formato não pode variar.
    const [ano, mes, dia] = isoLocalComOffset(new Date(f.starts_at), fuso).slice(0, 10).split("-");
    const data = `${dia}/${mes}/${ano}`;
    // Quebra de linha no título abriria uma "linha nova" dentro do prompt do
    // classificador. Uma linha só, cortada.
    const tipo = f.tipo.replace(/\s+/g, " ").trim().slice(0, MAXIMO_DO_TIPO) || "atendimento";
    return `${data} ${tipo} (${SITUACAO[quando][f.status] ?? f.status})`;
  });
  // Cortar em silêncio faria o classificador tomar a lista por completa.
  return itens.join("; ") + (fatos.length > maximo ? " (há mais, não listados)" : "");
}

/**
 * O bloco em texto. Ao contrário de `renderCompromissos`, NÃO fica vazio quando
 * não há nada: para o classificador, "sem atendimentos" é justamente o fato que
 * separa o paciente novo do antigo.
 */
export function renderFatosDoContato(fatos: FatosDoContato): string {
  const cabecalho = "Fatos do CRM sobre este contato (agenda):";
  if (fatos.anteriores.length === 0 && fatos.futuros.length === 0) {
    return `${cabecalho}\n- Sem atendimentos registrados na agenda.`;
  }
  return [
    cabecalho,
    `- Compromissos passados (não cancelados): ${linha(fatos.anteriores, MAXIMO_DE_ANTERIORES, "passado")}`,
    `- Compromissos futuros: ${linha(fatos.futuros, MAXIMO_DE_FUTUROS, "futuro")}`,
  ].join("\n");
}

/** Lê e escreve. É o que o roteador chama. */
export async function buildFatosDoContato(
  db: Queryable,
  organizationId: string,
  contactId: string,
  agora: Date,
): Promise<string> {
  return renderFatosDoContato(await fatosDoContato(db, organizationId, contactId, agora));
}
