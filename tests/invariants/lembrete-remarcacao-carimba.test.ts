/**
 * A REMARCAÇÃO CARIMBA QUANDO O HORÁRIO FOI MARCADO — no banco de verdade.
 *
 * `tests/unit/remarcacao-carimba-quando-o-horario-foi-marcado.test.ts` mede o
 * TEXTO da migration 0323 e do apêndice do baseline. Aqui se mede o que o
 * Postgres faz com ele, sobre o `baseline.sql` que o self-host aplica:
 *
 *   - nota e status NÃO mexem na régua (senão confirmar um compromisso já
 *     dentro de 24h mataria a véspera armada);
 *   - `starts_at` igual no SET também não — `fn_appointment_change` SEMPRE
 *     nomeia a coluna, e nomear não é mudar (a guarda `is distinct from`);
 *   - mudar `starts_at` grava, pelo UPDATE direto e pelo RPC que a tela e a
 *     ferramenta MCP usam;
 *   - a função do gatilho não é executável por `anon` nem por `public`;
 *   - `calendar_event_types.reminder_body` existe e aceita nulo.
 */
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

const ORG = "1e3b0323-0000-4000-8000-000000000001";
const AP = "1e3b0323-1000-4000-8000-000000000001";
const TIPO = "1e3b0323-2000-4000-8000-000000000001";

const marcado = () => sql(`select coalesce(starts_at_marked_at::text, 'NULL') from public.calendar_appointments where id='${AP}';`);

beforeAll(() => {
  sql(`
    insert into public.organizations(id,slug,legal_name,display_name)
      values('${ORG}','lembrete-0323','Lembrete 0323','Lembrete 0323') on conflict(id) do nothing;
    insert into public.calendar_appointments(id,organization_id,title,starts_at,ends_at,status)
      values('${AP}','${ORG}','Consulta',timestamptz '2030-03-10 17:00Z',timestamptz '2030-03-10 17:30Z','confirmed')
      on conflict(id) do nothing;
  `);
});

describe("a régua da remarcação (migration 0323, porte da 0536 do original)", () => {
  it("compromisso recém-marcado não tem régua de remarcação", () => {
    expect(marcado()).toBe("NULL");
  });

  it("nota e status não mexem na régua", () => {
    sql(`update public.calendar_appointments set notes='x' where id='${AP}';`);
    expect(marcado()).toBe("NULL");
    sql(`update public.calendar_appointments set status='pending' where id='${AP}';
         update public.calendar_appointments set status='confirmed' where id='${AP}';`);
    expect(marcado()).toBe("NULL");
  });

  it("starts_at igual no SET não é remarcação", () => {
    sql(`update public.calendar_appointments set starts_at=starts_at where id='${AP}';`);
    expect(marcado()).toBe("NULL");
  });

  it("mudar starts_at grava a régua", () => {
    sql(`update public.calendar_appointments
            set starts_at=starts_at+interval '1 day', ends_at=ends_at+interval '1 day' where id='${AP}';`);
    expect(marcado()).not.toBe("NULL");
  });

  it("o RPC da tela e da ferramenta MCP também grava — e um patch sem starts_at não regrava", () => {
    const antes = marcado();
    const rev = sql(`select revision from public.calendar_appointments where id='${AP}';`);
    sql(`select public.fn_appointment_change('${ORG}','${AP}',${rev},'{"notes":"só a nota"}'::jsonb);`);
    expect(marcado()).toBe(antes);

    const rev2 = sql(`select revision from public.calendar_appointments where id='${AP}';`);
    sql(`select public.fn_appointment_change('${ORG}','${AP}',${rev2},
           '{"starts_at":"2030-03-20T17:00:00Z","ends_at":"2030-03-20T17:30:00Z"}'::jsonb);`);
    const depois = marcado();
    expect(depois).not.toBe("NULL");
    expect(depois).not.toBe(antes);
  });

  it("a função do gatilho não é executável por anon nem por public", () => {
    expect(sql(`select has_function_privilege('anon','public.fn_starts_at_marked_at()','execute');`)).toBe("f");
    expect(
      sql(`select count(*) from information_schema.routine_privileges
            where routine_schema='public' and routine_name='fn_starts_at_marked_at' and grantee in ('PUBLIC','anon');`),
    ).toBe("0");
  });
});

describe("o texto do lembrete no tipo (migration 0323, porte da 0265 do original)", () => {
  it("reminder_body existe, nasce nulo e aceita texto", () => {
    sql(`insert into public.calendar_event_types(id,organization_id,name,slug,category,duration_minutes)
           values('${TIPO}','${ORG}','Consulta','consulta-0323','consulta',30) on conflict(id) do nothing;`);
    expect(sql(`select coalesce(reminder_body,'NULL') from public.calendar_event_types where id='${TIPO}';`)).toBe("NULL");
    sql(`update public.calendar_event_types set reminder_body='Oi {{primeiro_nome}}' where id='${TIPO}';`);
    expect(sql(`select reminder_body from public.calendar_event_types where id='${TIPO}';`)).toBe("Oi {{primeiro_nome}}");
  });
});
