import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";

const linhaSchema = z.strictObject({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  contact_id: z.uuid(),
  title: z.string().trim().min(1).max(200),
  starts_at: z.iso.datetime({ offset: true }),
  ends_at: z.iso.datetime({ offset: true }),
  status: z.enum(["pending", "confirmed", "completed", "no_show", "cancelled"]),
}).refine(r => Date.parse(r.ends_at) > Date.parse(r.starts_at), "Período inválido");
export const historicoSchema = z.strictObject({
  organization_id: z.uuid(),
  owner_user_id: z.uuid(),
  actor_user_id: z.uuid(),
  rows: z.array(linhaSchema).min(1).max(2000),
}).refine(x => new Set(x.rows.map(r => r.key)).size === x.rows.length, "Chave repetida no arquivo");

type Resultado = { linha: number; resultado: "novo" | "existente" | "conflito"; id?: string };
type Existente = { id: string; history_import_key: string | null; contact_id: string | null;
  starts_at: Date; ends_at: Date; status: string; title: string; owner_user_id: string | null };

/** Uma transação por arquivo. Não usa o handler de agendamento vivo (envia eventos).
 * Os contatos devem vir conferidos; não há inferência por nome/telefone nem criação de pessoas.
 */
export async function importarHistorico(pool: pg.Pool, input: unknown, aplicar = false): Promise<Resultado[]> {
  const dados = historicoSchema.parse(input);
  const db = await pool.connect();
  // Quem falha dentro da transação sai do pool COM erro e é descartado.
  let erroNaTransacao: Error | undefined;
  try {
    await db.query("begin");
    await db.query("set local lock_timeout = '5s'");
    await db.query("set local statement_timeout = '30s'");
    const { rows: [role] } = await db.query<{ permitido: boolean }>(
      "select rolsuper or rolbypassrls as permitido from pg_roles where rolname=current_user");
    if (!role?.permitido) throw new Error("Importação exige conexão administrativa");
    const { rows: [ator] } = await db.query(
      "select 1 from user_organizations where organization_id=$1 and user_id=$2 and revoked_at is null and accepted_at is not null and role in ('admin','manager')",
      [dados.organization_id, dados.actor_user_id]);
    if (!ator) throw new Error("Ator não é gestor ativo desta organização");
    const { rows: [dono] } = await db.query(
      "select 1 from user_organizations where organization_id=$1 and user_id=$2 and revoked_at is null and accepted_at is not null",
      [dados.organization_id, dados.owner_user_id]);
    if (!dono) throw new Error("Responsável não pertence à organização");
    const { rows: [clock] } = await db.query<{ now: Date }>("select now()");
    if (dados.rows.some(r => Date.parse(r.ends_at) > clock!.now.getTime()))
      throw new Error("Histórico aceita apenas compromissos encerrados no tempo");
    // ponytail: trava global curta para impedir corrida com cadastro normal; lotes até 2000.
    // Se importações frequentes disputarem a agenda, usar uma trava compartilhada por dono em TODOS os escritores.
    if (aplicar) await db.query("lock table calendar_appointments in share row exclusive mode");
    const contatos = [...new Set(dados.rows.map(r => r.contact_id))];
    const { rows: validos } = await db.query<{ id: string }>(
      "select id from contacts where organization_id=$1 and id=any($2::uuid[]) and not is_anonymized and is_merged_into is null for no key update",
      [dados.organization_id, contatos]);
    if (validos.length !== contatos.length) throw new Error("Contato ausente, mesclado, anonimizado ou de outra organização");
    const inicio = new Date(Math.min(...dados.rows.map(r => Date.parse(r.starts_at))));
    const fim = new Date(Math.max(...dados.rows.map(r => Date.parse(r.ends_at))));
    const { rows: existentes } = await db.query<Existente>(
      `select id,to_jsonb(a)->>'history_import_key' as history_import_key,contact_id,starts_at,ends_at,status,title,owner_user_id
       from calendar_appointments a where organization_id=$1 and
       (to_jsonb(a)->>'history_import_key'=any($2::text[]) or (owner_user_id=$3 and ends_at>$4 and starts_at<$5))`,
      [dados.organization_id, dados.rows.map(r => r.key), dados.owner_user_id, inicio, fim]);
    const resultados: Resultado[] = [];
    for (const [index, r] of dados.rows.entries()) {
      const start = Date.parse(r.starts_at), end = Date.parse(r.ends_at);
      const candidatos = existentes.filter(e => e.history_import_key === r.key ||
        (e.owner_user_id === dados.owner_user_id && e.starts_at.getTime() < end && e.ends_at.getTime() > start));
      const igual = candidatos.length === 1 && candidatos[0]!.contact_id === r.contact_id &&
        candidatos[0]!.owner_user_id === dados.owner_user_id && candidatos[0]!.starts_at.getTime() === start &&
        candidatos[0]!.ends_at.getTime() === end && candidatos[0]!.status === r.status &&
        // Origem já importada também precisa conservar procedimento/título.
        (candidatos[0]!.history_import_key === null || candidatos[0]!.title === r.title);
      const resultado = candidatos.length ? igual ? "existente" : "conflito" : "novo";
      const id = candidatos[0]?.id ?? randomUUID();
      resultados.push({ linha: index + 1, resultado, ...(resultado === "existente" ? { id } : {}) });
      if (resultado !== "novo") continue;
      // Inclui o próprio arquivo na comparação, mesmo na prévia sem escrita.
      existentes.push({ id, history_import_key: r.key, contact_id: r.contact_id, starts_at: new Date(start),
        ends_at: new Date(end), status: r.status, title: r.title, owner_user_id: dados.owner_user_id });
    }
    if (!aplicar) { await db.query("rollback"); return resultados; }
    if (resultados.some(r => r.resultado === "conflito")) throw new Error("Conflitos na prévia; nenhuma linha foi importada");
    const lote = randomUUID();
    for (const [index, r] of dados.rows.entries()) {
      if (resultados[index]!.resultado !== "novo") continue;
      const { rows: [criado] } = await db.query<{ id: string }>(
        `insert into calendar_appointments(organization_id,owner_user_id,contact_id,title,starts_at,ends_at,status,
         source,history_import_key,created_by_kind,created_by_user_id,time_zone,cancelled_at,cancellation_reason)
         values($1,$2,$3,$4,$5,$6,$7,'historical_import',$8,'user',$9,'America/Sao_Paulo',
          case when $7='cancelled' then now() else null end,
          case when $7='cancelled' then 'Cancelamento informado na origem; data exata não disponível.' else null end) returning id`,
        [dados.organization_id, dados.owner_user_id, r.contact_id, r.title, r.starts_at, r.ends_at, r.status, r.key, dados.actor_user_id]);
      resultados[index]!.id = criado!.id;
      await db.query(`insert into api_audit_log(organization_id,actor_user_id,action,resource_type,resource_id,metadata,bypassed_rls)
       values($1,$2,'agenda.historico_importado','calendar_appointment',$3,$4::jsonb,true)`,
        [dados.organization_id,dados.actor_user_id,criado!.id,JSON.stringify({ lote, origem: "script:importar-agenda-historica", chave: r.key })]);
    }
    await db.query("commit");
    return resultados;
  } catch (error) {
    erroNaTransacao = error instanceof Error ? error : new Error(String(error));
    await db.query("rollback");
    throw error;
  } finally { db.release(erroNaTransacao); }
}
