import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, seedGov, sql } from "./gov-helpers";

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
});
