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

function aceita(script: string): boolean {
  try {
    sql(`begin; ${script}; rollback;`);
    return true;
  } catch {
    return false;
  }
}

const ORG_A = "ea710000-0000-4000-8000-000000000001";
const ORG_B = "ea710000-0000-4000-8000-000000000002";
const LOCAL_A = "ea710000-1000-4000-8000-000000000001";
const ROOM_A = "ea710000-2000-4000-8000-000000000001";
const PRODUTO_A = "ea710000-3000-4000-8000-000000000001";

beforeAll(() => {
  sql(`
    insert into public.organizations(id,slug,legal_name,display_name) values
      ('${ORG_A}','agenda-recursos-a','Agenda recursos A','Agenda recursos A'),
      ('${ORG_B}','agenda-recursos-b','Agenda recursos B','Agenda recursos B')
      on conflict(id) do nothing;
  `);
});

describe("recursos físicos e duração da agenda", () => {
  it("cria unidades e salas dentro da mesma organização", () => {
    sql(`
      insert into public.calendar_locations(id,organization_id,name,slug)
        values('${LOCAL_A}','${ORG_A}','Vitória','vitoria');
      insert into public.calendar_rooms(id,organization_id,location_id,name,kind)
        values('${ROOM_A}','${ORG_A}','${LOCAL_A}','Consultório 1','consultorio');
    `);
    expect(sql(`select location_id::text from public.calendar_rooms where id='${ROOM_A}';`)).toBe(LOCAL_A);
  });

  it("recusa sala ligada a unidade de outra organização", () => {
    expect(aceita(`insert into public.calendar_rooms(organization_id,location_id,name,kind) values('${ORG_B}','${LOCAL_A}','Sala cruzada','consultorio')`)).toBe(false);
  });

  it("aceita duração de 7 minutos e recusa duração menor que 5", () => {
    sql(`insert into public.catalog_products(id,organization_id,codigo,nome,preco_cents,duration_minutes) values('${PRODUTO_A}','${ORG_A}','IM-7','Aplicação intramuscular',0,7);`);
    expect(sql(`select duration_minutes from public.catalog_products where id='${PRODUTO_A}';`)).toBe("7");
    expect(aceita(`insert into public.catalog_products(organization_id,codigo,nome,preco_cents,duration_minutes) values('${ORG_A}','INVALIDO-4','Inválido',0,4)`)).toBe(false);
  });

  it("guarda no compromisso a duração usada e os recursos reservados", () => {
    expect(aceita(`insert into public.calendar_appointments(organization_id,title,starts_at,ends_at,location_id,room_id,scheduled_duration_minutes) values('${ORG_A}','Aplicação',now()+interval '1 day',now()+interval '1 day 7 minutes','${LOCAL_A}','${ROOM_A}',7)`)).toBe(true);
  });
});
