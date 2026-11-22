import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, seedGov } from "./gov-helpers";

/**
 * A ESCRITA TARDIA DA IA SOBRE UM CONTATO ANONIMIZADO JÁ NASCE REDIGIDA (migration 0427).
 *
 * Porte do efeito de melgarafael/DeskcommCRM#1958. A virada (0309) redige o que
 * existe; este arquivo prova o que chega DEPOIS: a run que estava no ar, a
 * memória e o estado gravados pelo mesmo turno. E prova a outra metade: quem
 * voltou a escrever (run nova; memória fora da janela) fica intacto.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
afterAll(() => pool.end());
const q = (text: string, args: unknown[] = []) => pool.query(text, args);

const ORG = GOV_ORG;
const AGORA = randomUUID();
const ANTIGO = randomUUID();
const AGENTE = randomUUID();
const VERSAO = randomUUID();
const PASSO = JSON.stringify([{ step: 1, text: "Bruno quer orçamento", tool_calls: [{ tool_name: "crm_get_lead", args: { name: "Bruno" } }] }]);

async function novaRun(contato: string, criadaEm: string): Promise<string> {
  const { rows } = await q(
    `insert into ai_agent_runs(organization_id,agent_id,agent_version_id,contact_id,status,created_at)
     values($1,$2,$3,$4,'running',${criadaEm}) returning id`,
    [ORG, AGENTE, VERSAO, contato],
  );
  return rows[0].id;
}

beforeAll(async () => {
  seedGov();
  await q("insert into ai_agents(id,organization_id,name,system_prompt) values($1,$2,'Agente LGPD 0427','s')", [AGENTE, ORG]);
  await q(
    `insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status)
     values($1,$2,$3,1,'s','anthropic','claude-sonnet-4-6',$4,'published')`,
    [VERSAO, ORG, AGENTE, GOV_SESSION],
  );
  await q("insert into contacts(id,organization_id,name,display_name) values($1,$2,'Bruno','Bruno')", [AGORA, ORG]);
  await q(
    "insert into contacts(id,organization_id,display_name,is_anonymized,anonymized_at) values($1,$2,'Anon',true,now() - interval '1 hour')",
    [ANTIGO, ORG],
  );
});

describe("LGPD: a escrita tardia da IA sobre contato anonimizado nasce redigida (0427)", () => {
  it("⭐ run no ar na hora da anonimização: os argumentos gravados depois saem redigidos", async () => {
    const run = await novaRun(AGORA, "now() - interval '1 minute'");
    await q("update contacts set is_anonymized = true, anonymized_at = now() where id = $1", [AGORA]);
    await q("update ai_agent_runs set tool_calls = $1::jsonb, status = 'completed' where id = $2", [PASSO, run]);
    const { rows } = await q("select tool_calls from ai_agent_runs where id = $1", [run]);
    expect(rows[0].tool_calls).toEqual([{ step: 1, redacted: true, tool_calls: [{ tool_name: "crm_get_lead" }] }]);
  });

  it("⭐ memória e estado gravados logo depois da anonimização saem redigidos", async () => {
    await q("insert into lead_notes(organization_id,contact_id,headline,body,embedding) values($1,$2,'Bruno','nome: Bruno','[1]')", [ORG, AGORA]);
    await q(
      `insert into lead_state(organization_id,contact_id,next_action,qualification) values($1,$2,'ligar para Bruno','{"nome":"Bruno"}')
       on conflict (organization_id, contact_id) do update set next_action = excluded.next_action, qualification = excluded.qualification`,
      [ORG, AGORA],
    );
    const { rows } = await q(
      `select (select count(*) from lead_notes where contact_id = $1 and (body <> '(anonimizado)' or embedding is not null))::int notas,
              (select count(*) from lead_state where contact_id = $1 and (next_action is not null or qualification <> '{}'))::int estados`,
      [AGORA],
    );
    expect(rows[0]).toEqual({ notas: 0, estados: 0 });
  });

  it("quem voltou a escrever fica intacto: run nova e memória fora da janela", async () => {
    const run = await novaRun(ANTIGO, "now()");
    await q("update ai_agent_runs set tool_calls = $1::jsonb where id = $2", [PASSO, run]);
    await q("insert into lead_notes(organization_id,contact_id,headline,body) values($1,$2,'Carla','voltou: Carla')", [ORG, ANTIGO]);
    await q("insert into lead_state(organization_id,contact_id,next_action) values($1,$2,'ligar para Carla')", [ORG, ANTIGO]);
    const { rows } = await q(
      `select (select tool_calls::text ilike '%Bruno%' from ai_agent_runs where id = $2) run,
              (select count(*) from lead_notes where contact_id = $1 and body = 'voltou: Carla')::int notas,
              (select next_action from lead_state where contact_id = $1) estado`,
      [ANTIGO, run],
    );
    expect(rows[0]).toEqual({ run: true, notas: 1, estado: "ligar para Carla" });
  });
});
