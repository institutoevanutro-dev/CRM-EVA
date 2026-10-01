import { describe, expect, it } from "vitest";

import { countAs, sql, writeCountAs } from "./gov-helpers";

/**
 * A tabela das palavras que o dono liberou (migration 0290). Três coisas que a
 * RLS tem de garantir e que o CLAUDE.md cobra de toda tabela nova:
 * isolamento entre organizações, piso de papel (ler `agent`, escrever
 * `manager`) e unicidade da palavra por organização.
 *
 * Mesmo padrão de `comentarios-do-instagram.test.ts`: `sql()` como dono,
 * `countAs`/`writeCountAs` como usuário autenticado.
 */

const ORG_A = "0290a000-0000-4000-8000-000000000001";
const ORG_B = "0290a000-0000-4000-8000-000000000002";
const MANAGER_A = "0290a000-1111-4000-8000-000000000001";
const MANAGER_B = "0290a000-1111-4000-8000-000000000002";
const VIEWER_A = "0290a000-1111-4000-8000-000000000003";
const AGENT_A = "0290a000-1111-4000-8000-000000000004";

function seed(): void {
  sql(`
    insert into auth.users (id, email) values
      ('${MANAGER_A}', 'vocabulario-manager-a@invariant.test'),
      ('${MANAGER_B}', 'vocabulario-manager-b@invariant.test'),
      ('${VIEWER_A}', 'vocabulario-viewer-a@invariant.test'),
      ('${AGENT_A}', 'vocabulario-agent-a@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'vocabulario-inv-a', 'Vocabulario Inv A', 'Vocabulario Inv A'),
      ('${ORG_B}', 'vocabulario-inv-b', 'Vocabulario Inv B', 'Vocabulario Inv B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MANAGER_A}', '${ORG_A}', 'manager', now()),
      ('${MANAGER_B}', '${ORG_B}', 'manager', now()),
      ('${VIEWER_A}', '${ORG_A}', 'viewer', now()),
      ('${AGENT_A}', '${ORG_A}', 'agent', now())
      on conflict do nothing;
  `);
}

const COLS = "(organization_id, palavra, aprovada)";

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? "") + String(err.message ?? "");
  }
  throw new Error("o INSERT passou: a trava não existe neste banco");
}

describe("0290 · instagram_comment_vocabulario", () => {
  it("nasce com RLS ligada e as policies de tenant (select com papel + write com papel)", () => {
    seed();
    expect(
      sql(`select relrowsecurity from pg_class where relname = 'instagram_comment_vocabulario'`),
    ).toBe("t");
    expect(
      sql(`select string_agg(policyname, ',' order by policyname) from pg_policies
            where schemaname = 'public' and tablename = 'instagram_comment_vocabulario' and permissive = 'PERMISSIVE'`),
    ).toBe("instagram_comment_vocabulario_select,instagram_comment_vocabulario_write");
  });

  it("a mesma palavra pode existir em DUAS organizações, e só uma vez em cada", () => {
    sql(
      `insert into public.instagram_comment_vocabulario ${COLS}
         values ('${ORG_A}', 'corte', true), ('${ORG_B}', 'corte', false);`,
    );
    const erro = erroDe(() =>
      sql(
        `insert into public.instagram_comment_vocabulario ${COLS} values ('${ORG_A}', 'corte', true);`,
      ),
    );
    expect(erro).toContain("instagram_comment_vocabulario_unica");
  });

  it("viewer não escreve; agent não escreve; manager escreve", () => {
    const insere = (palavra: string) =>
      `insert into public.instagram_comment_vocabulario ${COLS} values ('${ORG_A}', '${palavra}', true)`;
    expect(writeCountAs(VIEWER_A, insere("viewer-nao"))).toBe(0);
    expect(writeCountAs(AGENT_A, insere("agent-nao"))).toBe(0);
    expect(writeCountAs(MANAGER_A, insere("didatico"))).toBe(1);
  });

  it("ler exige agent: agent lê, viewer não", () => {
    const le = `select count(*) from public.instagram_comment_vocabulario where organization_id = '${ORG_A}' and palavra = 'didatico';`;
    expect(countAs(AGENT_A, le)).toBe(1);
    expect(countAs(VIEWER_A, le)).toBe(0);
  });

  it("membro de A não lê as palavras de B", () => {
    sql(
      `insert into public.instagram_comment_vocabulario ${COLS} values ('${ORG_B}', 'segredo', true);`,
    );
    expect(
      countAs(
        MANAGER_A,
        `select count(*) from public.instagram_comment_vocabulario where palavra = 'segredo';`,
      ),
    ).toBe(0);
  });

  it("membro de B não escreve COM o organization_id de A (o lado `with check`)", () => {
    expect(
      writeCountAs(
        MANAGER_B,
        `insert into public.instagram_comment_vocabulario ${COLS} values ('${ORG_A}', 'invadido', true)`,
      ),
    ).toBe(0);
    expect(
      sql(`select count(*) from public.instagram_comment_vocabulario where palavra = 'invadido'`),
    ).toBe("0");
  });
});
