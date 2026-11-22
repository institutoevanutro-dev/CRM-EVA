import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ADMIN, GOV_ORG, lastLine, seedGov, sql, writeErrorAs } from "./gov-helpers";

/**
 * Resumo semanal do Marketing (migration 0431): o registro de envio é deny-all para
 * os papéis do PostgREST e vale uma vez por semana por número; a função de agregados
 * só é alcançável pela service role e devolve o formato que o endpoint espera.
 */
describe("resumo semanal (0431)", () => {
  beforeAll(() => seedGov());

  it("a tabela é deny-all para anon e authenticated, com RLS ligada", () => {
    expect(
      sql(`select count(*) from information_schema.role_table_grants
             where table_schema='public' and table_name='marketing_resumo_envios'
               and grantee in ('anon','authenticated');`),
    ).toBe("0");
    expect(sql(`select relrowsecurity from pg_class where oid='public.marketing_resumo_envios'::regclass;`)).toBe("t");
  });

  it("nem o administrador da própria organização lê ou escreve pela sessão (permission denied)", () => {
    const leitura = writeErrorAs(GOV_ADMIN, "select count(*) from marketing_resumo_envios");
    expect(leitura, "authenticated leu SEM erro — a tabela está exposta").not.toBeNull();
    expect(leitura).toContain("permission denied");
    const escrita = writeErrorAs(
      GOV_ADMIN,
      `insert into marketing_resumo_envios (organization_id, semana, telefone) values ('${GOV_ORG}', '2026-W48', '5527999990000')`,
    );
    expect(escrita).toContain("permission denied");
  });

  it("o mesmo telefone não entra duas vezes na mesma semana", () => {
    sql(`delete from marketing_resumo_envios where organization_id='${GOV_ORG}';
         insert into marketing_resumo_envios (organization_id, semana, telefone) values ('${GOV_ORG}', '2026-W47', '5527999990000');`);
    expect(() =>
      sql(`insert into marketing_resumo_envios (organization_id, semana, telefone) values ('${GOV_ORG}', '2026-W47', '5527999990000');`),
    ).toThrow(/marketing_resumo_envios_uma_vez/);
    expect(() =>
      sql(`insert into marketing_resumo_envios (organization_id, semana, telefone) values ('${GOV_ORG}', 'semana-47', '5527999990000');`),
    ).toThrow(/check/);
  });

  it("fn_marketing_semana não é executável por anon nem authenticated e devolve o formato", () => {
    expect(
      sql(`select has_function_privilege('anon','public.fn_marketing_semana(uuid,timestamptz,timestamptz)','execute')
                  or has_function_privilege('authenticated','public.fn_marketing_semana(uuid,timestamptz,timestamptz)','execute');`),
    ).toBe("f");
    const j = JSON.parse(sql(`select public.fn_marketing_semana('${GOV_ORG}', now() - interval '7 days', now());`));
    expect(Object.keys(j).sort()).toEqual(["agenda", "mensagens", "quem_marcou", "recebidas"]);
    expect(Object.keys(j.agenda).sort()).toEqual(["cancelados", "criados", "faltas", "realizados"]);
  });

  it("agendamento importado ou remarcado não conta como agendamento novo (mesma régua do funil)", () => {
    const j = JSON.parse(lastLine(
      sql(`delete from calendar_appointments where organization_id='${GOV_ORG}' and title like 'resumo-%';
           insert into calendar_appointments(id,organization_id,title,starts_at,ends_at,status,source)
             values ('cccccccc-9999-4000-8000-000000000001','${GOV_ORG}','resumo-normal',now(),now()+interval '30 min','completed','ui');
           insert into calendar_appointments(id,organization_id,title,starts_at,ends_at,status,source,history_import_key)
             values ('cccccccc-9999-4000-8000-000000000002','${GOV_ORG}','resumo-importado',now()-interval '2 hours',now()-interval '90 min','completed','historical_import',repeat('a',64));
           insert into calendar_appointments(organization_id,title,starts_at,ends_at,status,source,rescheduled_from_id)
             values ('${GOV_ORG}','resumo-remarcado',now()+interval '1 day',now()+interval '1 day 30 min','confirmed','ui','cccccccc-9999-4000-8000-000000000001');
           select public.fn_marketing_semana('${GOV_ORG}', now() - interval '3 hours', now() + interval '2 days');`),
    ));
    expect(j.agenda.criados).toBe(1);
    expect(j.agenda.realizados).toBe(1);
  });
});

