// tests/invariants/jev-observacoes.test.ts
import { describe, expect, it } from "vitest";

import { countAs, sql, writeErrorAs } from "./gov-helpers";

/**
 * O que a migration 0350 promete no banco que o clone recebe (porte da 0421 de
 * melgarafael/DeskcommCRM):
 *  1. jev_observacoes com RLS; membro lê só a própria organização (2 tenants).
 *  2. authenticated não escreve: só o servidor grava observação.
 *  3. Uma observação por tarefa e mensagem.
 *  4. O expurgo tem piso de 30 dias no corpo e não é chamável por anon/authenticated.
 */
const ORG_A = "0350aaaa-0000-4000-8000-000000000001";
const ORG_B = "0350bbbb-0000-4000-8000-000000000002";
const MEMBRO_A = "0350aaaa-1111-4000-8000-000000000001";
const MEMBRO_B = "0350bbbb-1111-4000-8000-000000000002";
const MSG = "0350aaaa-2222-4000-8000-000000000001";

function seed(): void {
  sql(`
    insert into auth.users (id, email) values
      ('${MEMBRO_A}', 'jev-a@invariant.test'),
      ('${MEMBRO_B}', 'jev-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'jev-inv-a', 'Jev Inv A', 'Jev A'),
      ('${ORG_B}', 'jev-inv-b', 'Jev Inv B', 'Jev B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MEMBRO_A}', '${ORG_A}', 'admin', now()),
      ('${MEMBRO_B}', '${ORG_B}', 'admin', now())
      on conflict do nothing;
    delete from public.jev_observacoes where organization_id in ('${ORG_A}', '${ORG_B}');
    insert into public.jev_observacoes (organization_id, tarefa, estado, message_id, rotulo_jev, rotulo_atual)
      values ('${ORG_A}', 'humano', 'observando', '${MSG}', 'nao', 'nao');
  `);
}

describe("0350 · observações do Jev isoladas, só do servidor, com prazo", () => {
  it("nasce com RLS, e cada membro lê só a própria organização", () => {
    seed();
    expect(sql(`select relrowsecurity from pg_class where relname = 'jev_observacoes' and relnamespace = 'public'::regnamespace`)).toBe("t");
    const consulta = `select count(*) from public.jev_observacoes where organization_id = '${ORG_A}';`;
    expect(countAs(MEMBRO_A, consulta)).toBe(1);
    expect(countAs(MEMBRO_B, consulta)).toBe(0);
    expect(sql(`select concordou from public.jev_observacoes where message_id = '${MSG}'`)).toBe("t");
  });

  it("authenticated não grava observação, nem na própria organização", () => {
    const erro = writeErrorAs(
      MEMBRO_A,
      `insert into public.jev_observacoes (organization_id, tarefa, estado) values ('${ORG_A}', 'clima', 'observando')`,
    );
    expect(erro).toMatch(/permission denied/);
  });

  it("uma observação por tarefa e mensagem", () => {
    expect(() =>
      sql(`insert into public.jev_observacoes (organization_id, tarefa, estado, message_id) values ('${ORG_A}', 'humano', 'observando', '${MSG}')`),
    ).toThrow(/jev_observacoes_uma_por_mensagem_idx/);
  });

  it("o expurgo respeita o piso de 30 dias, qualquer que seja o pedido", () => {
    sql(`
      insert into public.jev_observacoes (organization_id, tarefa, estado, created_at) values
        ('${ORG_A}', 'clima', 'observando', now() - interval '10 days'),
        ('${ORG_A}', 'clima', 'observando', now() - interval '40 days');
    `);
    expect(sql(`select public.fn_expurgar_observacoes_do_jev(1, 1000)`)).toBe("1");
    expect(sql(`select count(*) from public.jev_observacoes where organization_id = '${ORG_A}' and tarefa = 'clima'`)).toBe("1");
  });

  it("o expurgo não é chamável por anon nem authenticated", () => {
    expect(
      sql(`select has_function_privilege('anon', 'public.fn_expurgar_observacoes_do_jev(int,int)', 'execute')::text || ' ' ||
                  has_function_privilege('authenticated', 'public.fn_expurgar_observacoes_do_jev(int,int)', 'execute')::text`),
    ).toBe("false false");
  });
});
