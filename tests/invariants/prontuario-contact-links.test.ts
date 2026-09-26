import { beforeAll, describe, expect, it } from "vitest";
import { countAs, lastLine, sql } from "./gov-helpers";

const A = "02800000-0000-4000-8000-000000000001";
const B = "02800000-0000-4000-8000-000000000002";
const USER_A = "02800000-0000-4000-8000-000000000003";
const CONTACT_A = "02800000-0000-4000-8000-000000000004";
const CONTACT_B = "02800000-0000-4000-8000-000000000005";
const PATIENT_A = "02800000-0000-4000-8000-000000000006";
const PATIENT_B = "02800000-0000-4000-8000-000000000007";
const PATIENT_C = "02800000-0000-4000-8000-000000000008";

beforeAll(() => {
  sql(`
    insert into auth.users(id,email) values ('${USER_A}','bridge-a@invariant.test') on conflict(id) do nothing;
    insert into public.organizations(id,slug,legal_name,display_name) values
      ('${A}','prontuario-invariant-a','Prontuario A','Prontuario A'),
      ('${B}','prontuario-invariant-b','Prontuario B','Prontuario B') on conflict(id) do nothing;
    insert into public.user_organizations(user_id,organization_id,role,accepted_at)
      values ('${USER_A}','${A}','agent',now()) on conflict do nothing;
    insert into public.contacts(id,organization_id,name) values
      ('${CONTACT_A}','${A}','Contato ficticio A'),
      ('${CONTACT_B}','${B}','Contato ficticio B') on conflict(id) do nothing;
    insert into public.prontuario_contact_links(organization_id,source_patient_id,contact_id)
      values ('${A}','${PATIENT_A}','${CONTACT_A}'),
             ('${B}','${PATIENT_C}','${CONTACT_B}') on conflict do nothing;
  `);
});

describe("vínculo opaco prontuário-contato", () => {
  it("membro vê só vínculo da própria organização e não pode escrever", () => {
    expect(countAs(USER_A, "select count(*) from public.prontuario_contact_links;")).toBe(1);
    expect(countAs(USER_A, `select count(*) from public.prontuario_contact_links where organization_id='${B}';`)).toBe(0);
    expect(lastLine(sql("select has_table_privilege('authenticated','public.prontuario_contact_links','INSERT');"))).toBe("f");
    expect(lastLine(sql("select has_table_privilege('authenticated','public.prontuario_contact_links','UPDATE');"))).toBe("f");
    expect(lastLine(sql("select has_table_privilege('anon','public.prontuario_contact_links','SELECT');"))).toBe("f");
  });

  it("não aceita contato de outra organização nem duplica paciente ou contato", () => {
    expect(() => sql(`insert into public.prontuario_contact_links(organization_id,source_patient_id,contact_id)
      values ('${A}','${PATIENT_B}','${CONTACT_B}');`)).toThrow();
    expect(() => sql(`insert into public.prontuario_contact_links(organization_id,source_patient_id,contact_id)
      values ('${A}','${PATIENT_B}','${CONTACT_A}');`)).toThrow();
    expect(() => sql(`insert into public.prontuario_contact_links(organization_id,source_patient_id,contact_id)
      values ('${A}','${PATIENT_A}','${CONTACT_A}');`)).toThrow();
  });

  it("anonimização remove o ponteiro que reidentificaria o contato", () => {
    sql(`update public.contacts set is_anonymized=true, anonymized_at=now() where id='${CONTACT_A}' and organization_id='${A}';`);
    expect(lastLine(sql(`select count(*) from public.prontuario_contact_links where contact_id='${CONTACT_A}';`))).toBe("0");
  });
});
