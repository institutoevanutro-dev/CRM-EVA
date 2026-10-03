import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, seedGov } from "./gov-helpers";

/**
 * A VIRADA DE is_anonymized ALCANÇA lead_notes, ai_agent_runs.tool_calls E lead_state (migration 0309).
 *
 * Portado do projeto original (DeskcommCRM PR 1973 de @webtecnica; lá, 0494).
 * Neste fork nenhum caminho de anonimização tocava essas fontes. Prova pelo
 * COMPORTAMENTO, no Postgres real: a virada redige as três do alvo, o vizinho
 * fica intacto, a segunda passagem não reescreve, e a cura (lida do arquivo)
 * alcança quem já era anonimizado e poupa o que veio depois de `anonymized_at`.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
afterAll(() => pool.end());
const q = (text: string, args: unknown[] = []) => pool.query(text, args);

const ORG = GOV_ORG;
const ALVO = randomUUID();
const VIZINHO = randomUUID();
const JA_ANONIMIZADO = randomUUID();
const AGENTE = randomUUID();
const VERSAO = randomUUID();

const TOOL_CALLS = [
  {
    step: 1,
    text: "buscando lead de Bruno",
    tool_calls: [
      { tool_name: "crm_get_lead", args: { name: "Bruno" }, result: { phone: "5511999990000" } },
      { tool_name: "crm_create_activity", args: { note: "cliente Bruno quer orçamento" } },
    ],
  },
];

async function semear(contato: string, criadoEm = "now()") {
  await q(
    `insert into lead_notes(organization_id,contact_id,headline,body,embedding,created_at)
     values($1,$2,'memória sobre Bruno','nome do contato: Bruno','[0.1,0.2]'::jsonb,${criadoEm})`,
    [ORG, contato],
  );
  await q(
    `insert into lead_state(organization_id,contact_id,stage,next_action,qualification,updated_at)
     values($1,$2,'qualifying','ligar para Bruno','{"contato":"Bruno"}'::jsonb,${criadoEm})
     on conflict (organization_id, contact_id) do nothing`,
    [ORG, contato],
  );
  await q(
    `insert into ai_agent_runs(organization_id,agent_id,agent_version_id,contact_id,status,tool_calls,created_at)
     values($1,$2,$3,$4,'completed',$5::jsonb,${criadoEm})`,
    [ORG, AGENTE, VERSAO, contato, JSON.stringify(TOOL_CALLS)],
  );
}

/** Tudo do contato que ainda nomeia a pessoa, por fonte. */
async function residuo(contato: string): Promise<string> {
  const { rows } = await q(
    `select coalesce(string_agg(onde, ',' order by onde), '') r from (
       select 'lead_notes' onde from lead_notes
        where contact_id = $1 and (body ilike '%Bruno%' or headline ilike '%Bruno%' or embedding is not null)
       union
       select 'lead_state' from lead_state
        where contact_id = $1 and (next_action is not null or qualification <> '{}'::jsonb)
       union
       select 'tool_calls' from ai_agent_runs
        where contact_id = $1 and tool_calls::text ilike '%Bruno%'
     ) x`,
    [contato],
  );
  return rows[0].r;
}

async function toolCalls(contato: string): Promise<unknown> {
  const { rows } = await q("select tool_calls from ai_agent_runs where contact_id = $1 order by created_at limit 1", [contato]);
  return rows[0].tool_calls;
}

beforeAll(async () => {
  seedGov();
  await q("insert into ai_agents(id,organization_id,name,system_prompt) values($1,$2,'Agente LGPD 0309','s')", [AGENTE, ORG]);
  await q(
    `insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status)
     values($1,$2,$3,1,'s','anthropic','claude-sonnet-4-6',$4,'published')`,
    [VERSAO, ORG, AGENTE, GOV_SESSION],
  );
  for (const c of [ALVO, VIZINHO]) {
    await q("insert into contacts(id,organization_id,name,display_name) values($1,$2,'Bruno','Bruno')", [c, ORG]);
    await semear(c);
  }
  // Anonimizado há uma hora, ANTES do gatilho: resíduo de duas horas atrás.
  await q(
    "insert into contacts(id,organization_id,display_name,is_anonymized,anonymized_at) values($1,$2,'Anon',true,now() - interval '1 hour')",
    [JA_ANONIMIZADO, ORG],
  );
  await semear(JA_ANONIMIZADO, "now() - interval '2 hours'");
});

describe("LGPD: a virada de is_anonymized alcança memória, ferramentas e estado da lead (0309)", () => {
  it("antes: as três fontes guardam o nome nos três contatos (controle positivo)", async () => {
    for (const c of [ALVO, VIZINHO, JA_ANONIMIZADO]) expect(await residuo(c)).toBe("lead_notes,lead_state,tool_calls");
  });

  it("⭐ virar is_anonymized (o UPDATE do botão) redige as três fontes do alvo", async () => {
    await q("update contacts set name = null, is_anonymized = true, anonymized_at = now() where id = $1 and organization_id = $2", [
      ALVO,
      ORG,
    ]);
    expect(await residuo(ALVO)).toBe("");
    expect(await toolCalls(ALVO)).toEqual([
      {
        step: 1,
        redacted: true,
        tool_calls: [{ tool_name: "crm_get_lead" }, { tool_name: "crm_create_activity" }],
      },
    ]);
  });

  it("o vizinho na mesma org fica intacto — filtro por contato", async () => {
    expect(await residuo(VIZINHO)).toBe("lead_notes,lead_state,tool_calls");
  });

  it("a função de redação tolera forma inesperada e é idempotente", async () => {
    const casos: Array<[unknown, unknown]> = [
      [[], []],
      [{ x: 1 }, []],
      [[5, { tool_calls: "x" }], [{ redacted: true, tool_calls: [] }, { redacted: true, tool_calls: [] }]],
    ];
    for (const [entrada, esperado] of casos) {
      const { rows } = await q("select public.fn_lgpd_redigir_tool_calls($1::jsonb) r", [JSON.stringify(entrada)]);
      expect(rows[0].r).toEqual(esperado);
    }
    const redigido = await toolCalls(ALVO);
    const { rows } = await q("select public.fn_lgpd_redigir_tool_calls($1::jsonb) r", [JSON.stringify(redigido)]);
    expect(rows[0].r).toEqual(redigido);
  });

  it("⭐ a cura alcança quem JÁ era anonimizado e poupa o que veio depois (duas reaplicações)", async () => {
    await q(
      `insert into ai_agent_runs(organization_id,agent_id,agent_version_id,contact_id,status,tool_calls)
       values($1,$2,$3,$4,'completed','[{"step":1,"text":"voltou: Carla","tool_calls":[]}]'::jsonb)`,
      [ORG, AGENTE, VERSAO, JA_ANONIMIZADO],
    );
    await q(
      "insert into lead_notes(organization_id,contact_id,headline,body) values($1,$2,'nova','voltou: Carla')",
      [ORG, JA_ANONIMIZADO],
    );

    const dir = join(process.cwd(), "supabase", "migrations");
    const arquivo = readdirSync(dir).find((n) => /_0309_/.test(n));
    if (!arquivo) throw new Error("migration 0309 não encontrada");
    const migration = readFileSync(join(dir, arquivo), "utf8");
    const cura = migration.slice(migration.indexOf("-- Cura:"));
    await q(cura);
    await q(cura);

    expect(await residuo(JA_ANONIMIZADO)).toBe("");
    const { rows } = await q(
      `select (select count(*) from lead_notes where contact_id = $1 and body = 'voltou: Carla')::int notas,
              (select count(*) from ai_agent_runs where contact_id = $1 and tool_calls::text ilike '%Carla%')::int runs`,
      [JA_ANONIMIZADO],
    );
    expect(rows[0]).toEqual({ notas: 1, runs: 1 });
  });
});
