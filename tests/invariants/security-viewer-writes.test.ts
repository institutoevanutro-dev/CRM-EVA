import { beforeAll, expect, it } from "vitest";
import { seedGov, sql, writeCountAs, GOV_ORG, GOV_VIEWER, GOV_AGENT_A, GOV_MANAGER, GOV_CONV_UNASSIGNED, GOV_SESSION, GOV_CONTACT_1, GOV_LEAD } from "./gov-helpers";
beforeAll(() => { seedGov(); });
const writes = {
  messages: `insert into public.messages (organization_id,conversation_id,channel_session_id,contact_id,type,direction,body) values ('${GOV_ORG}','${GOV_CONV_UNASSIGNED}','${GOV_SESSION}','${GOV_CONTACT_1}','text','outbound','synthetic')`,
  agent_cases: `insert into public.agent_cases (organization_id,conversation_id,title,summary,blocker) values ('${GOV_ORG}','${GOV_CONV_UNASSIGNED}','synthetic','synthetic','synthetic')`,
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
it("viewer não injeta evento de negócio", () => {
  expect(() => sql(`set role authenticated; select set_config('request.jwt.claims','{"sub":"${GOV_VIEWER}"}',false);
    select public.emit_event('lead.created','lead','${GOV_LEAD}','{}','{}','${GOV_ORG}');`)).toThrow(/caller_not_authorized/);
});
it("ledger de pacing só pode ser escrito pelo serviço", () => {
  expect(sql("select has_table_privilege('authenticated','public.pacing_ledger','DELETE');")).toBe("f");
  expect(sql("select has_table_privilege('service_role','public.pacing_ledger','INSERT');")).toBe("t");
});
