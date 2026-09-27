import { beforeAll, describe, expect, it } from "vitest";
import { lastLine, sql } from "./gov-helpers";

const ORG = "02810000-0000-4000-8000-000000000001";
const OTHER = "02810000-0000-4000-8000-000000000002";
const USER = "02810000-0000-4000-8000-000000000003";
const TOKEN = "02810000-0000-4000-8000-000000000004";
const CONTACT = "02810000-0000-4000-8000-000000000005";
const OTHER_CONTACT = "02810000-0000-4000-8000-000000000006";
const PATIENT_LINK = "02810000-0000-4000-8000-000000000007";
const PATIENT_CREATE = "02810000-0000-4000-8000-000000000008";
const KEY = "02810000-0000-4000-8000-000000000009";

function lastJson(query: string): Record<string, unknown> { return JSON.parse(lastLine(sql(query))) as Record<string, unknown>; }
const createCall = (key = KEY, name = "Paciente Ficticio") => `select public.fn_prontuario_create_contact('${ORG}','${PATIENT_CREATE}','${name}','1990-01-01','+5527999990000','ficticio@invariant.test','${key}','${TOKEN}');`;

beforeAll(() => {
  sql(`
    insert into auth.users(id,email) values ('${USER}','bridge-ops@invariant.test') on conflict(id) do nothing;
    insert into public.organizations(id,slug,legal_name,display_name) values
      ('${ORG}','bridge-ops-invariant','Bridge Ops','Bridge Ops'),
      ('${OTHER}','bridge-ops-other','Bridge Other','Bridge Other') on conflict(id) do nothing;
    insert into public.user_organizations(user_id,organization_id,role,accepted_at)
      values ('${USER}','${ORG}','admin',now()) on conflict do nothing;
    insert into public.api_tokens(id,organization_id,created_by,name,prefix,token_hash,scopes)
      values ('${TOKEN}','${ORG}','${USER}','Token de teste','dsk_test',decode(repeat('a',64),'hex'),'["prontuario:contacts:write"]'::jsonb)
      on conflict(id) do nothing;
    insert into public.contacts(id,organization_id,name) values
      ('${CONTACT}','${ORG}','Existente'),
      ('${OTHER_CONTACT}','${OTHER}','Outra organizacao') on conflict(id) do nothing;
  `);
});

describe("operações transacionais do prontuário", () => {
  it("vincula um contato revisado e não aceita org ou revisão errada", () => {
    expect(() => sql(`select public.fn_prontuario_link_existing('${ORG}','${PATIENT_LINK}','${OTHER_CONTACT}',now(),'${TOKEN}');`)).toThrow();
    expect(() => sql(`select public.fn_prontuario_link_existing('${ORG}','${PATIENT_LINK}','${CONTACT}','2020-01-01','${TOKEN}');`)).toThrow();
    const call = `select public.fn_prontuario_link_existing('${ORG}','${PATIENT_LINK}','${CONTACT}',(select updated_at from public.contacts where id='${CONTACT}'),'${TOKEN}');`;
    expect(lastJson(call)).toMatchObject({ id: CONTACT, linked: true });
    expect(lastJson(call)).toMatchObject({ id: CONTACT, linked: false });
    expect(lastLine(sql(`select count(*) from public.prontuario_contact_links where source_patient_id='${PATIENT_LINK}';`))).toBe("1");
  });

  it("cria contato e vínculo atomicamente; repetição não duplica", () => {
    const first = lastJson(createCall());
    expect(first.created).toBe(true);
    const again = lastJson(createCall());
    expect(again.created).toBe(false);
    expect(again.id).toBe(first.id);
    expect(() => sql(createCall(KEY, "Outro Nome"))).toThrow();
    expect(lastLine(sql(`select count(*) from public.prontuario_contact_links where source_patient_id='${PATIENT_CREATE}';`))).toBe("1");
    expect(() => sql(createCall("02810000-0000-4000-8000-000000000010"))).toThrow();
  });

  it("PATCH é idempotente e recusa versão CRM defasada", () => {
    const id = lastLine(sql(`select contact_id from public.prontuario_contact_links where source_patient_id='${PATIENT_CREATE}';`));
    const expected = lastLine(sql(`select updated_at from public.contacts where id='${id}';`));
    const patch = (revision: number, timestamp: string, name = "Nome Revisado") =>
      `select public.fn_prontuario_patch_contact('${ORG}','${PATIENT_CREATE}','${id}',${revision},'${timestamp}','${name}','1990-01-01','+5527999990000','ficticio@invariant.test','${TOKEN}');`;
    expect(lastJson(patch(1, expected)).applied).toBe(true);
    expect(lastJson(patch(1, expected)).applied).toBe(false);
    expect(lastJson(createCall()).created).toBe(false);
    expect(() => sql(patch(1, expected, "Outro Nome"))).toThrow();
    sql(`update public.contacts set name='Edicao CRM' where id='${id}';`);
    expect(() => sql(patch(2, expected))).toThrow();
    expect(lastLine(sql(`select name from public.contacts where id='${id}';`))).toBe("Edicao CRM");
  });

  it("funções ficam inacessíveis a anon e authenticated", () => {
    for (const signature of [
      "fn_prontuario_link_existing(uuid,uuid,uuid,timestamp with time zone,uuid)",
      "fn_prontuario_create_contact(uuid,uuid,text,date,text,text,uuid,uuid)",
      "fn_prontuario_patch_contact(uuid,uuid,uuid,integer,timestamp with time zone,text,date,text,text,uuid)",
    ]) {
      expect(lastLine(sql(`select has_function_privilege('anon','public.${signature}','EXECUTE');`))).toBe("f");
      expect(lastLine(sql(`select has_function_privilege('authenticated','public.${signature}','EXECUTE');`))).toBe("f");
      expect(lastLine(sql(`select has_function_privilege('service_role','public.${signature}','EXECUTE');`))).toBe("t");
    }
  });
});
