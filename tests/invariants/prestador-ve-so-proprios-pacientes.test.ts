import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via pnpm test:db");
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

function como(userId: string, script: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${script}
  `).split("\n").at(-1) ?? "";
}

function consegue(userId: string, script: string): boolean {
  try {
    como(userId, script);
    return true;
  } catch {
    return false;
  }
}

const ORG = "eb7a06c1-0000-4000-8000-000000000001";
const PRESTADOR_A = "eb7a06c1-1000-4000-8000-000000000001";
const PRESTADOR_B = "eb7a06c1-1000-4000-8000-000000000002";
const COLABORADOR = "eb7a06c1-1000-4000-8000-000000000003";
const CONTATO_A = "eb7a06c1-2000-4000-8000-000000000001";
const CONTATO_B = "eb7a06c1-2000-4000-8000-000000000002";
const AGENDA_A = "eb7a06c1-3000-4000-8000-000000000001";
const AGENDA_B = "eb7a06c1-3000-4000-8000-000000000002";

beforeAll(() => {
  sql(`
    insert into auth.users(id,email) values
      ('${PRESTADOR_A}','prestador-a@escopo.test'),
      ('${PRESTADOR_B}','prestador-b@escopo.test'),
      ('${COLABORADOR}','colaborador@escopo.test') on conflict(id) do nothing;
    insert into public.organizations(id,slug,legal_name,display_name)
      values('${ORG}','escopo-prestador','Escopo prestador','Escopo prestador') on conflict(id) do nothing;
    insert into public.user_organizations(user_id,organization_id,role,accepted_at) values
      ('${PRESTADOR_A}','${ORG}','provider',now()),
      ('${PRESTADOR_B}','${ORG}','provider',now()),
      ('${COLABORADOR}','${ORG}','agent',now()) on conflict do nothing;
    insert into public.contacts(id,organization_id,display_name) values
      ('${CONTATO_A}','${ORG}','Paciente A'),
      ('${CONTATO_B}','${ORG}','Paciente B') on conflict(id) do nothing;
    insert into public.calendar_appointments
      (id,organization_id,contact_id,owner_user_id,title,starts_at,ends_at) values
      ('${AGENDA_A}','${ORG}','${CONTATO_A}','${PRESTADOR_A}','Agenda A',now()+interval '30 days',now()+interval '30 days 30 minutes'),
      ('${AGENDA_B}','${ORG}','${CONTATO_B}','${PRESTADOR_B}','Agenda B',now()+interval '31 days',now()+interval '31 days 30 minutes')
      on conflict(id) do nothing;
  `);
});

describe("prestador vê e altera somente o próprio escopo", () => {
  it("vê somente o próprio compromisso", () => {
    expect(como(PRESTADOR_A, `select string_agg(id::text, ',' order by id) from public.calendar_appointments where organization_id='${ORG}';`)).toBe(AGENDA_A);
  });

  it("vê somente o paciente vinculado ao próprio trabalho", () => {
    expect(como(PRESTADOR_A, `select string_agg(id::text, ',' order by id) from public.contacts where organization_id='${ORG}';`)).toBe(CONTATO_A);
  });

  it("altera o próprio compromisso, mas não o de outro prestador", () => {
    expect(consegue(PRESTADOR_A, `update public.calendar_appointments set notes='próprio' where id='${AGENDA_A}';`)).toBe(true);
    expect(como(PRESTADOR_A, `update public.calendar_appointments set notes='alheio' where id='${AGENDA_B}' returning id;`)).toBe("UPDATE 0");
  });

  it("não transfere o próprio compromisso para outra pessoa", () => {
    expect(consegue(PRESTADOR_A, `update public.calendar_appointments set owner_user_id='${PRESTADOR_B}' where id='${AGENDA_A}';`)).toBe(false);
  });

  it("o colaborador continua vendo toda a organização", () => {
    expect(como(COLABORADOR, `select count(*) from public.calendar_appointments where organization_id='${ORG}';`)).toBe("2");
    expect(como(COLABORADOR, `select count(*) from public.contacts where organization_id='${ORG}';`)).toBe("2");
  });
});
