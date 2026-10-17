import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * O NEGÓCIO DIZ POR ONDE O CLIENTE CHEGOU (migration 0379).
 *
 * Duas metades, contra o schema real:
 *   1. o CÓDIGO: o negócio que nasce de uma conversa do Instagram grava
 *      `crm_leads.source = 'instagram'`, e o de WhatsApp continua 'whatsapp';
 *   2. o SQL do apêndice do baseline (o que o update.sh reaplica): corrige só
 *      o negócio que nasceu de conversa do Instagram com `source = 'whatsapp'`
 *      exato, e não toca origem digitada, importada, de anúncio, de outra
 *      organização nem negócio sem a atividade de nascimento pelo canal.
 *
 * Portado do projeto original (DeskcommCRM, PR #2199 de @paulolimajr77).
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});
const db = pgComoSupabase(pool);

const ORG = "0379a000-0000-4000-8000-000000000001";
const OUTRA_ORG = "0379a000-0000-4000-8000-000000000002";

const MARCA = "-- ---- origem do negócio segue o canal da conversa (migration 0379) ----";
function blocoDoBaseline(): string | null {
  const texto = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const inicio = texto.indexOf(MARCA);
  if (inicio === -1) return null;
  const resto = texto.slice(inicio + MARCA.length);
  const fim = resto.indexOf("\n-- ---- ");
  return resto.slice(0, fim === -1 ? undefined : fim);
}
const BLOCO = blocoDoBaseline();

async function criarOrg(id: string, slug: string): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, $2, 'Origem LTDA', 'Origem') on conflict (id) do nothing`,
    [id, slug],
  );
}

async function sessao(org: string, tipo: "whatsapp" | "instagram", nome: string): Promise<string> {
  const { rows } =
    tipo === "instagram"
      ? await pool.query<{ id: string }>(
          `insert into channel_sessions (organization_id, provider, status, webhook_secret_encrypted, ig_account_id, ig_username)
           values ($1, 'meta_instagram', 'WORKING', decode('00','hex'), $2, $3) returning id`,
          [org, `1784140${String(Math.floor(Math.random() * 1e10)).padStart(10, "0")}`, nome],
        )
      : await pool.query<{ id: string }>(
          `insert into channel_sessions (organization_id, waha_session_name, status, webhook_secret_encrypted)
           values ($1, $2, 'WORKING', decode('00','hex')) returning id`,
          [org, `origem-0379-${nome}`],
        );
  return rows[0]!.id;
}

async function contato(org: string, nome: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, source) values ($1, $2, 'manual') returning id`,
    [org, nome],
  );
  return rows[0]!.id;
}

async function conversa(org: string, contatoId: string, sessaoId: string, canal: "whatsapp" | "instagram") {
  const { rows } = await pool.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id, channel, status)
     values ($1, $2, $3, $4, 'open') returning id`,
    [org, contatoId, sessaoId, canal],
  );
  return rows[0]!.id;
}

async function origemDoNegocio(leadId: string): Promise<string> {
  const { rows } = await pool.query<{ source: string }>("select source from crm_leads where id = $1", [leadId]);
  return rows[0]!.source;
}

/**
 * Um negócio "como a versão antiga deixava": nasce pelo código (atividade
 * `lead_created` de `canal.ingest` apontando para a conversa) e tem o `source`
 * forçado para o valor que se quer testar.
 */
async function negocioAntigo(org: string, canal: "whatsapp" | "instagram", sourceGravado: string, sessaoId: string) {
  const c = await contato(org, `Paciente Ficticio ${canal} ${sourceGravado}`);
  const conv = await conversa(org, c, sessaoId, canal);
  const r = await garantirLeadDaConversa(db, {
    organizationId: org,
    contactId: c,
    conversationId: conv,
    nomeDoContato: null,
  });
  if (!r.criado) throw new Error(`negócio não nasceu: ${JSON.stringify(r)}`);
  await pool.query("update crm_leads set source = $2 where id = $1", [r.leadId, sourceGravado]);
  return r.leadId;
}

let IG: string;
let WA: string;
let IG_OUTRA: string;

beforeAll(async () => {
  await criarOrg(ORG, "origem-0379");
  await criarOrg(OUTRA_ORG, "origem-0379-outra");
  IG = await sessao(ORG, "instagram", "clinica_ficticia");
  WA = await sessao(ORG, "whatsapp", "wa");
  IG_OUTRA = await sessao(OUTRA_ORG, "instagram", "outra_ficticia");
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG, OUTRA_ORG]]);
  await pool.end();
});

describe("o código: o negócio nasce com o canal da conversa", () => {
  it("conversa do Instagram → source 'instagram'", async () => {
    const c = await contato(ORG, "Paciente Ficticio Direct");
    const conv = await conversa(ORG, c, IG, "instagram");
    const r = await garantirLeadDaConversa(db, { organizationId: ORG, contactId: c, conversationId: conv, nomeDoContato: null });
    expect(r.criado, JSON.stringify(r)).toBe(true);
    if (!r.criado) return;
    expect(await origemDoNegocio(r.leadId)).toBe("instagram");
  });

  it("CONTROLE: conversa do WhatsApp continua 'whatsapp'", async () => {
    const c = await contato(ORG, "Paciente Ficticio Zap");
    const conv = await conversa(ORG, c, WA, "whatsapp");
    const r = await garantirLeadDaConversa(db, { organizationId: ORG, contactId: c, conversationId: conv, nomeDoContato: null });
    expect(r.criado, JSON.stringify(r)).toBe(true);
    if (!r.criado) return;
    expect(await origemDoNegocio(r.leadId)).toBe("whatsapp");
  });
});

describe("o apêndice do baseline: corrige o que já nasceu errado, e só isso", () => {
  it("o instrumento acha o bloco (sem ele o caso passaria medindo nada)", () => {
    expect(BLOCO, "bloco da 0379 não encontrado no baseline.sql").not.toBeNull();
  });

  it("Instagram com 'whatsapp' vira 'instagram'; o resto fica como está; reaplicar não muda nada", async () => {
    const corrigir = await negocioAntigo(ORG, "instagram", "whatsapp", IG);
    const zapDeVerdade = await negocioAntigo(ORG, "whatsapp", "whatsapp", WA);
    // Origem que alguém digitou ou importou não é a origem que o código gravava.
    const digitado = await negocioAntigo(ORG, "instagram", "Whatsapp", IG);
    const anuncio = await negocioAntigo(ORG, "instagram", "meta_ads", IG);
    const planilha = await negocioAntigo(ORG, "instagram", "importacao_planilha", IG);
    const doOperador = await negocioAntigo(ORG, "instagram", "whatsapp_operador", IG);
    const daOutraOrg = await negocioAntigo(OUTRA_ORG, "instagram", "whatsapp", IG_OUTRA);

    // Negócio sem a atividade de nascimento pelo canal (criado à mão).
    const { rows: funil } = await pool.query<{ pipeline_id: string; stage_id: string }>(
      "select pipeline_id, stage_id from crm_leads where id = $1",
      [corrigir],
    );
    const { rows: manual } = await pool.query<{ id: string }>(
      `insert into crm_leads (organization_id, pipeline_id, stage_id, title, source)
       values ($1, $2, $3, 'Negocio manual ficticio', 'whatsapp') returning id`,
      [ORG, funil[0]!.pipeline_id, funil[0]!.stage_id],
    );
    const semAtividade = manual[0]!.id;

    await pool.query(BLOCO!);

    expect(await origemDoNegocio(corrigir)).toBe("instagram");
    expect(await origemDoNegocio(daOutraOrg), "o critério vale em qualquer organização").toBe("instagram");
    expect(await origemDoNegocio(zapDeVerdade)).toBe("whatsapp");
    expect(await origemDoNegocio(digitado)).toBe("Whatsapp");
    expect(await origemDoNegocio(anuncio)).toBe("meta_ads");
    expect(await origemDoNegocio(planilha)).toBe("importacao_planilha");
    expect(await origemDoNegocio(doOperador)).toBe("whatsapp_operador");
    expect(await origemDoNegocio(semAtividade)).toBe("whatsapp");

    // Idempotente: a segunda passada (o próximo update.sh) não acha nada.
    const segunda = await pool.query(BLOCO!);
    expect(segunda.rowCount ?? 0).toBe(0);
  });
});
