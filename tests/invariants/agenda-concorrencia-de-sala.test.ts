import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via pnpm test:db");
const containerName: string = container;

function sql(script: string): string {
  return execFileSync("docker", ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], { input: script, encoding: "utf8" }).trim();
}

function aceita(script: string): boolean {
  try { sql(`begin; ${script}; rollback;`); return true; } catch { return false; }
}

const ORG = "ea730000-0000-4000-8000-000000000001";
const DONO = "ea730000-1000-4000-8000-000000000001";
const VITORIA = "ea730000-2000-4000-8000-000000000001";
const SERRA = "ea730000-2000-4000-8000-000000000002";
const IV = "ea730000-3000-4000-8000-000000000001";
const IM = "ea730000-3000-4000-8000-000000000002";

beforeAll(() => {
  sql(`
    insert into auth.users(id,email) values('${DONO}','agenda-concorrencia@invariant.test') on conflict(id) do nothing;
    insert into public.organizations(id,slug,legal_name,display_name) values('${ORG}','agenda-concorrencia','Agenda concorrência','Agenda concorrência') on conflict(id) do nothing;
    insert into public.calendar_units(id,organization_id,name) values
      ('${VITORIA}','${ORG}','Vitória'),('${SERRA}','${ORG}','Serra');
    insert into public.calendar_rooms(organization_id,unit_id,name,kind) values
      ('${ORG}','${VITORIA}','Aplicação 1','application'),
      ('${ORG}','${VITORIA}','Aplicação 2','application'),
      ('${ORG}','${SERRA}','Aplicação','application');
    insert into public.calendar_event_types(id,organization_id,name,slug,category,duration_minutes,default_owner_user_id,required_room_kind,concurrency_key) values
      ('${IV}','${ORG}','Intravenosa','iv','procedimento',30,'${DONO}','application','iv'),
      ('${IM}','${ORG}','Intramuscular','im','procedimento',7,'${DONO}','application','im');
  `);
});

describe("conflitos de profissional e sala", () => {
  it("mantém compromissos legados sem tipo fora da regra de simultaneidade", () => {
    expect(aceita(`insert into public.calendar_appointments(organization_id,title,starts_at,ends_at,owner_user_id,status) values
      ('${ORG}','Legado 1',timestamp with time zone '2030-01-09 12:00Z',timestamp with time zone '2030-01-09 13:00Z','${DONO}','confirmed'),
      ('${ORG}','Legado 2',timestamp with time zone '2030-01-09 12:05Z',timestamp with time zone '2030-01-09 13:05Z','${DONO}','confirmed')`)).toBe(true);
  });

  it("seleciona automaticamente uma sala compatível", () => {
    const room = sql(`insert into public.calendar_appointments(organization_id,event_type_id,title,starts_at,ends_at,owner_user_id,status,unit_id,duration_minutes_snapshot)
      values('${ORG}','${IV}','IV',timestamp with time zone '2030-01-10 12:00Z',timestamp with time zone '2030-01-10 12:30Z','${DONO}','confirmed','${VITORIA}',30) returning room_id;`);
    expect(room).toMatch(/[0-9a-f-]{36}/);
  });

  it("permite IV e IM simultâneos em duas salas de Vitória", () => {
    expect(aceita(`insert into public.calendar_appointments(organization_id,event_type_id,title,starts_at,ends_at,owner_user_id,status,unit_id,duration_minutes_snapshot) values
      ('${ORG}','${IV}','IV',timestamp with time zone '2030-01-11 12:00Z',timestamp with time zone '2030-01-11 12:30Z','${DONO}','confirmed','${VITORIA}',30),
      ('${ORG}','${IM}','IM',timestamp with time zone '2030-01-11 12:05Z',timestamp with time zone '2030-01-11 12:12Z','${DONO}','confirmed','${VITORIA}',7)`)).toBe(true);
  });

  it("recusa duas IV simultâneas", () => {
    expect(aceita(`insert into public.calendar_appointments(organization_id,event_type_id,title,starts_at,ends_at,owner_user_id,status,unit_id,duration_minutes_snapshot) values
      ('${ORG}','${IV}','IV 1',timestamp with time zone '2030-01-12 12:00Z',timestamp with time zone '2030-01-12 12:30Z','${DONO}','confirmed','${VITORIA}',30),
      ('${ORG}','${IV}','IV 2',timestamp with time zone '2030-01-12 12:05Z',timestamp with time zone '2030-01-12 12:35Z','${DONO}','confirmed','${VITORIA}',30)`)).toBe(false);
  });

  it("recusa IV e IM simultâneos na única sala da Serra", () => {
    expect(aceita(`insert into public.calendar_appointments(organization_id,event_type_id,title,starts_at,ends_at,owner_user_id,status,unit_id,duration_minutes_snapshot) values
      ('${ORG}','${IV}','IV',timestamp with time zone '2030-01-13 12:00Z',timestamp with time zone '2030-01-13 12:30Z','${DONO}','confirmed','${SERRA}',30),
      ('${ORG}','${IM}','IM',timestamp with time zone '2030-01-13 12:05Z',timestamp with time zone '2030-01-13 12:12Z','${DONO}','confirmed','${SERRA}',7)`)).toBe(false);
  });
});
