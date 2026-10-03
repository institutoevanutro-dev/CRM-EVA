import { describe, expect, it } from "vitest";

import { countAs, sql, writeCountAs } from "./gov-helpers";

/**
 * O que a migration 0306 promete, cobrado no banco que o CLONE recebe
 * (baseline.sql aplicado pelo scripts/test-db.sh).
 *
 *  1. As quatro tabelas nascem com RLS e com a restritiva `mfa_provada` (0301).
 *  2. Escrita é de gestor: `agent` lê e não escreve (spec: "escrita só para
 *     manager ou acima").
 *  3. Isolamento nas duas direções entre duas organizações, inclusive o lado
 *     `with check`.
 *  4. FK composta: forma de perguntar não aponta para item de outra org.
 *  5. `respostas_prontas_usos` é escrito só pelo serviço (o worker); membro só lê.
 *     É a métrica — um cliente da REST não pode fabricar "resolvidas sem IA".
 */

// Namespace pela migration (0306), como manda a convenção dos invariantes.
const ORG_A = "0306aaaa-0000-4000-8000-000000000001";
const ORG_B = "0306bbbb-0000-4000-8000-000000000002";
const GESTOR_A = "0306aaaa-1111-4000-8000-000000000001";
const ATENDENTE_A = "0306aaaa-2222-4000-8000-000000000001";
const GESTOR_B = "0306bbbb-1111-4000-8000-000000000002";
const ITEM_A = "0306aaaa-3333-4000-8000-000000000001";

const TABELAS = [
  "respostas_prontas",
  "respostas_prontas_perguntas",
  "respostas_prontas_config",
  "respostas_prontas_usos",
] as const;

function seed(): void {
  sql(`
    insert into auth.users (id, email) values
      ('${GESTOR_A}', 'rp-gestor-a@invariant.test'),
      ('${ATENDENTE_A}', 'rp-atendente-a@invariant.test'),
      ('${GESTOR_B}', 'rp-gestor-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'rp-inv-a', 'Respostas Prontas Inv A', 'RP Inv A'),
      ('${ORG_B}', 'rp-inv-b', 'Respostas Prontas Inv B', 'RP Inv B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GESTOR_A}', '${ORG_A}', 'manager', now()),
      ('${ATENDENTE_A}', '${ORG_A}', 'agent', now()),
      ('${GESTOR_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;
  `);
}

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? "") + String(err.message ?? "");
  }
  throw new Error("o comando passou — a trava não existe neste banco");
}

describe("0306 · respostas prontas chegam ao clone com isolamento e papel", () => {
  it("as quatro tabelas nascem com RLS ligada e a restritiva do segundo fator", () => {
    seed();
    for (const t of TABELAS) {
      expect(
        sql(`select relrowsecurity from pg_class where relname = '${t}' and relnamespace = 'public'::regnamespace`),
        t,
      ).toBe("t");
      expect(
        sql(`select count(*) from pg_policies where schemaname = 'public' and tablename = '${t}' and policyname = 'mfa_provada'`),
        t,
      ).toBe("1");
    }
  });

  it("gestor da org A cria item, forma de perguntar e configuração", () => {
    expect(
      writeCountAs(
        GESTOR_A,
        `insert into public.respostas_prontas (id, organization_id, titulo, resposta)
         values ('${ITEM_A}', '${ORG_A}', 'Preço da limpeza', 'A limpeza custa R$ 180.')`,
      ),
    ).toBe(1);
    expect(
      writeCountAs(
        GESTOR_A,
        `insert into public.respostas_prontas_perguntas (organization_id, resposta_pronta_id, texto)
         values ('${ORG_A}', '${ITEM_A}', 'quanto custa a limpeza?')`,
      ),
    ).toBe(1);
    expect(
      writeCountAs(
        GESTOR_A,
        `insert into public.respostas_prontas_config (organization_id, ligado) values ('${ORG_A}', true)`,
      ),
    ).toBe(1);
  });

  it("a configuração nasce DESLIGADA e com o limite padrão 0.82", () => {
    sql(`insert into public.respostas_prontas_config (organization_id) values ('${ORG_B}') on conflict do nothing`);
    expect(
      sql(`select ligado::text || ' ' || limite_similaridade::text from public.respostas_prontas_config where organization_id = '${ORG_B}'`),
    ).toBe("false 0.82");
  });

  it("atendente (agent) LÊ, mas não escreve — escrita é de gestor", () => {
    expect(
      countAs(ATENDENTE_A, `select count(*) from public.respostas_prontas where organization_id = '${ORG_A}';`),
    ).toBe(1);
    expect(
      writeCountAs(
        ATENDENTE_A,
        `insert into public.respostas_prontas (organization_id, titulo, resposta) values ('${ORG_A}', 'invasao', 'x')`,
      ),
    ).toBe(0);
    expect(
      writeCountAs(ATENDENTE_A, `update public.respostas_prontas set resposta = 'trocada' where id = '${ITEM_A}'`),
    ).toBe(0);
    expect(sql(`select resposta from public.respostas_prontas where id = '${ITEM_A}'`)).toBe(
      "A limpeza custa R$ 180.",
    );
  });

  it("gestor da org B não vê NADA da org A, em nenhuma das quatro tabelas", () => {
    for (const t of TABELAS) {
      expect(
        countAs(GESTOR_B, `select count(*) from public.${t} where organization_id = '${ORG_A}';`),
        t,
      ).toBe(0);
    }
  });

  it("gestor da org B não escreve COM o organization_id da org A (o lado `with check`)", () => {
    expect(
      writeCountAs(
        GESTOR_B,
        `insert into public.respostas_prontas (organization_id, titulo, resposta) values ('${ORG_A}', 'invadido', 'x')`,
      ),
    ).toBe(0);
    expect(sql(`select count(*) from public.respostas_prontas where titulo = 'invadido'`)).toBe("0");
  });

  it("forma de perguntar não aponta para item de outra org (FK composta)", () => {
    const erro = erroDe(() =>
      sql(
        `insert into public.respostas_prontas_perguntas (organization_id, resposta_pronta_id, texto)
         values ('${ORG_B}', '${ITEM_A}', 'cruzada');`,
      ),
    );
    expect(erro).toContain("respostas_prontas_perguntas_item_fk");
  });

  it("usos: nenhum papel do PostgREST grava — só o serviço", () => {
    const erro = erroDe(() =>
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${GESTOR_A}"}', false);
        insert into public.respostas_prontas_usos (organization_id, resposta_pronta_id, conversation_id, similaridade)
        values ('${ORG_A}', '${ITEM_A}', gen_random_uuid(), 0.9);
      `),
    );
    expect(erro).toContain("permission denied");
  });

  it("limite fora da faixa é recusado pelo banco", () => {
    const erro = erroDe(() =>
      sql(`update public.respostas_prontas_config set limite_similaridade = 0.5 where organization_id = '${ORG_A}';`),
    );
    expect(erro).toContain("respostas_prontas_config_limite");
  });
});
