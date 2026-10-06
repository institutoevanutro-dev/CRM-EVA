import { beforeAll, expect, it } from "vitest";
import { seedGov, sql, writeCountAs, writeErrorAs, GOV_ORG, GOV_VIEWER, GOV_AGENT_A, GOV_MANAGER, GOV_CONV_UNASSIGNED, GOV_SESSION, GOV_CONTACT_1, GOV_LEAD } from "./gov-helpers";
beforeAll(() => { seedGov(); });
// `agent_cases` saiu deste laço na migration 0319: a 0299 tirou a escrita do
// somente leitura e deixou a do atendente; a 0319 tira a de TODA sessão (o caso
// é do servidor). O caso próprio está logo abaixo do laço.
const insertDeCaso = `insert into public.agent_cases (organization_id,conversation_id,title,summary,blocker) values ('${GOV_ORG}','${GOV_CONV_UNASSIGNED}','synthetic','synthetic','synthetic')`;
const writes = {
  messages: `insert into public.messages (organization_id,conversation_id,channel_session_id,contact_id,type,direction,body) values ('${GOV_ORG}','${GOV_CONV_UNASSIGNED}','${GOV_SESSION}','${GOV_CONTACT_1}','text','outbound','synthetic')`,
  agent_inbox_items: `insert into public.agent_inbox_items (organization_id,kind,title) values ('${GOV_ORG}','other','synthetic')`,
  channel_knobs: `insert into public.channel_knobs (organization_id,channel_session_id) values ('${GOV_ORG}','${GOV_SESSION}')`,
};
for (const [table, insert] of Object.entries(writes)) {
  it(`${table}: viewer não escreve, papel autorizado continua escrevendo`, () => {
    expect(writeCountAs(GOV_VIEWER, insert)).toBe(0);
    expect(writeCountAs(table === "channel_knobs" ? GOV_MANAGER : GOV_AGENT_A, insert)).toBe(1);
    expect(writeCountAs(GOV_VIEWER, `update public.${table} set organization_id=organization_id where organization_id='${GOV_ORG}'`)).toBe(0);
    expect(writeCountAs(GOV_VIEWER, `delete from public.${table} where organization_id='${GOV_ORG}'`)).toBe(0);
  });
}
it("agent_cases: nem o viewer nem o atendente escrevem pela sessão; o servidor escreve", () => {
  for (const usuario of [GOV_VIEWER, GOV_AGENT_A]) {
    expect(writeErrorAs(usuario, insertDeCaso)).toContain("permission denied for table agent_cases");
  }
  expect(sql(`set role service_role; with w as (${insertDeCaso} returning 1) select count(*) from w;`).endsWith("1")).toBe(true);
});
it("viewer não injeta evento de negócio", () => {
  expect(() => sql(`set role authenticated; select set_config('request.jwt.claims','{"sub":"${GOV_VIEWER}"}',false);
    select public.emit_event('lead.created','lead','${GOV_LEAD}','{}','{}','${GOV_ORG}');`)).toThrow(/caller_not_authorized/);
});
it("ledger de pacing só pode ser escrito pelo serviço", () => {
  expect(sql("select has_table_privilege('authenticated','public.pacing_ledger','DELETE');")).toBe("f");
  expect(sql("select has_table_privilege('service_role','public.pacing_ledger','INSERT');")).toBe("t");
});
