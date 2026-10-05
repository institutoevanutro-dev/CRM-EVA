/**
 * O importador só grava onde a pessoa DISSE que ia gravar. `anunciarDestino`
 * informa; isto RECUSA: host diferente do `--destino`, banco ausente, banco
 * misto (local × remoto) ou banco de outro projeto do Supabase da nuvem.
 */
import { destinoEhLocal } from "../../scripts/lib/env-de-teste";

export type VereditoDoDestino = { ok: true } | { ok: false; motivo: string };

export function conferirDestino(apiUrl: string, dbUrl: string, informado: string | undefined): VereditoDoDestino {
  if (!informado) return { ok: false, motivo: "falta --destino <host do Supabase> (ex.: --destino abcd.supabase.co)" };
  let api: URL;
  let db: URL;
  try {
    api = new URL(apiUrl);
  } catch {
    return { ok: false, motivo: "NEXT_PUBLIC_SUPABASE_URL ilegível" };
  }
  const host = api.hostname.toLowerCase();
  if (host !== informado.trim().toLowerCase())
    return { ok: false, motivo: `o ambiente aponta para ${host}, não para ${informado}` };
  if (!dbUrl) return { ok: false, motivo: "SUPABASE_DB_URL ausente — o importador grava direto no Postgres" };
  try {
    db = new URL(dbUrl);
  } catch {
    return { ok: false, motivo: "SUPABASE_DB_URL ilegível" };
  }
  if (destinoEhLocal(apiUrl) !== destinoEhLocal(dbUrl))
    return { ok: false, motivo: `destino misto: a API vai para ${host} e o Postgres para ${db.hostname}` };
  // Supabase da nuvem: o projeto aparece no host direto (db.<ref>.supabase.co)
  // ou no usuário do pooler (postgres.<ref>). Igualdade exata, nunca "contém".
  const ref = /^([a-z0-9]+)\.supabase\.co$/.exec(host)?.[1];
  if (
    ref &&
    db.hostname.toLowerCase() !== `db.${ref}.supabase.co` &&
    decodeURIComponent(db.username).toLowerCase() !== `postgres.${ref}`
  )
    return { ok: false, motivo: `o Postgres (${db.hostname}) não é o do projeto ${ref}` };
  return { ok: true };
}
