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
 * atende ninguém. Cancelado e falta ficam fora dos anteriores, senão quem só
 * desmarcou viraria "já é paciente".
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
const PROJECAO = `select coalesce(
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

export async function fatosDoContato(
  db: Queryable,
  organizationId: string,
  contactId: string,
  agora: Date,
): Promise<FatosDoContato> {
  const instante = agora.toISOString();
  const [anteriores, futuros] = await Promise.all([
    db.query<FatoDeAgenda>(
      `${PROJECAO}
        and a.ends_at < $3
        and a.status not in ('cancelled', 'no_show')
      order by a.starts_at desc, a.id
      limit $4`,
      [organizationId, contactId, instante, MAXIMO_DE_ANTERIORES + 1],
    ),
    db.query<FatoDeAgenda>(
      `${PROJECAO}
        and a.ends_at >= $3
        and a.status in ('pending', 'confirmed')
      order by a.starts_at asc, a.id
      limit $4`,
      [organizationId, contactId, instante, MAXIMO_DE_FUTUROS + 1],
    ),
  ]);
  return { anteriores: anteriores.rows, futuros: futuros.rows };
}

function linha(fatos: readonly FatoDeAgenda[], maximo: number): string {
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
    return `${data} ${tipo} (${f.status})`;
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
    `- Atendimentos anteriores: ${linha(fatos.anteriores, MAXIMO_DE_ANTERIORES)}`,
    `- Compromissos futuros: ${linha(fatos.futuros, MAXIMO_DE_FUTUROS)}`,
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
