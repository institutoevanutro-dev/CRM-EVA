import { describe, expect, it } from "vitest";

import { countAs, sql, writeCountAs } from "./gov-helpers";

/**
 * As duas tabelas da migration 0280: `instagram_comments` (fila de
 * comentários capturados) e `instagram_comment_rules` (palavra gatilho →
 * resposta pública + Direct, por mídia). Task 1 de 9 da feature de
 * comentários no CRM — só o banco; as tasks seguintes leem e escrevem estas
 * colunas pelo nome, então o que este arquivo prova é o contrato delas:
 *
 *  1. Isolamento por organização nas duas direções (`using` e `with check`).
 *  2. `(organization_id, external_id)` não duplica — o mesmo comentário não
 *     entra duas vezes quando o worker de ingestão reprocessar o webhook.
 *  3. `situacao` é vocabulário fechado por CHECK.
 *  4. O gate de papel na escrita (ver a nota na migration 0280): `viewer` não
 *     escreve em nenhuma das duas tabelas; `agent` escreve em
 *     `instagram_comments` mas NÃO em `instagram_comment_rules` (que exige
 *     `manager`). Isto não estava no briefing — é `rbac-config-ia-canais.test.ts`
 *     ("nenhuma tabela NOVA entra com policy ALL só-tenancy") quem exige.
 *
 * `comBanco`/`duasOrgs`/`comoOrg` do briefing da task são um chute sobre a
 * convenção do repo; o padrão real, usado por todo `tests/invariants/*-rls.test.ts`
 * vizinho (ex.: `meta-templates-rls.test.ts`), é `docker exec psql` com
 * `set role authenticated` + `request.jwt.claims`, via `./gov-helpers`.
 */

const ORG_A = "02790000-0000-4000-8000-000000000001";
const ORG_B = "02790000-0000-4000-8000-000000000002";
const MEMBER_A = "02790000-1111-4000-8000-000000000001";
const MEMBER_B = "02790000-1111-4000-8000-000000000002";
const VIEWER_A = "02790000-1111-4000-8000-000000000003";
const AGENT_A = "02790000-1111-4000-8000-000000000004";
const SESSION_A = "02790000-2222-4000-8000-000000000001";

function seed(): void {
  sql(`
    insert into auth.users (id, email) values
      ('${MEMBER_A}', 'instagram-comments-member-a@invariant.test'),
      ('${MEMBER_B}', 'instagram-comments-member-b@invariant.test'),
      ('${VIEWER_A}', 'instagram-comments-viewer-a@invariant.test'),
      ('${AGENT_A}', 'instagram-comments-agent-a@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'instagram-comments-inv-a', 'Instagram Comments Inv A', 'IG Comments Inv A'),
      ('${ORG_B}', 'instagram-comments-inv-b', 'Instagram Comments Inv B', 'IG Comments Inv B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MEMBER_A}', '${ORG_A}', 'manager', now()),
      ('${MEMBER_B}', '${ORG_B}', 'manager', now()),
      ('${VIEWER_A}', '${ORG_A}', 'viewer', now()),
      ('${AGENT_A}', '${ORG_A}', 'agent', now())
      on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESSION_A}', '${ORG_A}', 'instagram-comments-inv-a', '\\x00'::bytea)
      on conflict (id) do nothing;
  `);
}

const COLS_COMMENT =
  "(organization_id, channel_session_id, external_id, media_id, texto, autor_igsid, comentado_em, situacao)";

function commentValues(org: string, externalId: string, situacao = "novo"): string {
  return `('${org}', '${SESSION_A}', '${externalId}', 'media-1', 'oi', 'igsid-1', now(), '${situacao}')`;
}

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    // execFileSync joga o stderr do psql em `stderr`; a mensagem do Error só traz o exit.
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? "") + String(err.message ?? "");
  }
  throw new Error("o INSERT passou — a trava não existe neste banco");
}

describe("0280 · instagram_comments", () => {
  it("nasce com RLS ligada e as policies de tenant (select solto + write com papel)", () => {
    seed();
    expect(sql(`select relrowsecurity from pg_class where relname = 'instagram_comments'`)).toBe(
      "t",
    );
    expect(
      sql(`select string_agg(policyname, ',' order by policyname) from pg_policies
            where schemaname = 'public' and tablename = 'instagram_comments' and permissive = 'PERMISSIVE'`),
    ).toBe("instagram_comments_select,instagram_comments_write");
  });

  it("membro da org A escreve na própria org e lê de volta", () => {
    expect(
      writeCountAs(
        MEMBER_A,
        `insert into public.instagram_comments ${COLS_COMMENT} values ${commentValues(ORG_A, "c1")}`,
      ),
    ).toBe(1);
    expect(
      countAs(
        MEMBER_A,
        `select count(*) from public.instagram_comments where organization_id = '${ORG_A}';`,
      ),
    ).toBe(1);
  });

  it("membro da org B NÃO vê o comentário da org A (isolamento por RLS)", () => {
    expect(
      countAs(
        MEMBER_B,
        `select count(*) from public.instagram_comments where organization_id = '${ORG_A}';`,
      ),
    ).toBe(0);
  });

  it("membro da org B NÃO escreve COM o organization_id da org A (o lado `with check`)", () => {
    expect(
      writeCountAs(
        MEMBER_B,
        `insert into public.instagram_comments ${COLS_COMMENT} values ${commentValues(ORG_A, "invadido")}`,
      ),
    ).toBe(0);
    expect(
      sql(`select count(*) from public.instagram_comments where external_id = 'invadido'`),
    ).toBe("0");
  });

  it("o mesmo external_id não entra duas vezes na mesma organização", () => {
    const erro = erroDe(() =>
      sql(`insert into public.instagram_comments ${COLS_COMMENT} values ${commentValues(ORG_A, "c1")};`),
    );
    expect(erro).toContain("instagram_comments_externo");
  });

  it("situacao fora do vocabulário é recusada pelo CHECK", () => {
    const erro = erroDe(() =>
      sql(
        `insert into public.instagram_comments ${COLS_COMMENT} values ${commentValues(ORG_A, "c-invalido", "inventado")};`,
      ),
    );
    expect(erro).toContain("instagram_comments_situacao_check");
  });

  it("situacao 'respondido_manualmente' (migration 0282 — publicação humana pela tela, Task 8) é aceita", () => {
    // O teste negativo acima passaria mesmo que este valor NUNCA tivesse sido
    // acrescentado ao CHECK — ele só prova que o CHECK existe, não que o
    // vocabulário novo está nele. Este é o positivo: insere de verdade e
    // relê, provando que o valor está no conjunto aceito, não só ausente do
    // conjunto recusado.
    sql(
      `insert into public.instagram_comments ${COLS_COMMENT} values ${commentValues(ORG_A, "c-manual", "respondido_manualmente")};`,
    );
    const linhas = Number(
      sql(
        `select count(*) from public.instagram_comments where organization_id = '${ORG_A}' and external_id = 'c-manual' and situacao = 'respondido_manualmente';`,
      ),
    );
    expect(linhas).toBe(1);
  });

  it("reivindicado_em (migration 0281) é o lease do worker — nullable, e a reivindicação só avança quem está 'novo' e sem lease vigente", () => {
    writeCountAs(
      AGENT_A,
      `insert into public.instagram_comments ${COLS_COMMENT} values ${commentValues(ORG_A, "c-lease")}`,
    );
    // Nasce null (nunca reivindicado).
    expect(
      sql(
        `select reivindicado_em is null from public.instagram_comments where organization_id = '${ORG_A}' and external_id = 'c-lease'`,
      ),
    ).toBe("t");

    // A reivindicação real é um UPDATE condicional — provado aqui como SQL
    // puro (o código de `reivindicar`, task 7, faz exatamente esta query).
    // `with ... returning` + `count(*)` dá um número confiável do `psql -tA`
    // em vez de depender do formato da linha de status do UPDATE.
    const reivindicar = () =>
      Number(
        sql(
          `with w as (
             update public.instagram_comments set reivindicado_em = now()
               where organization_id = '${ORG_A}' and external_id = 'c-lease'
                 and situacao = 'novo'
                 and (reivindicado_em is null or reivindicado_em < now() - interval '10 minutes')
             returning id
           ) select count(*) from w;`,
        ),
      );

    expect(reivindicar()).toBe(1);

    // Lease vigente (acabou de reivindicar) barra uma segunda reivindicação —
    // duas rodadas simultâneas não mandam duas privadas para a mesma pessoa.
    expect(reivindicar()).toBe(0);

    // Lease vencido (>10min) libera de novo — uma rodada que morreu no meio
    // não tranca a linha para sempre.
    sql(
      `update public.instagram_comments set reivindicado_em = now() - interval '11 minutes'
         where organization_id = '${ORG_A}' and external_id = 'c-lease';`,
    );
    expect(reivindicar()).toBe(1);
  });

  it("viewer da própria org NÃO escreve (a policy de escrita exige `agent`)", () => {
    expect(
      writeCountAs(
        VIEWER_A,
        `insert into public.instagram_comments ${COLS_COMMENT} values ${commentValues(ORG_A, "c-viewer")}`,
      ),
    ).toBe(0);
  });

  it("agent da própria org escreve (papel mínimo exigido)", () => {
    expect(
      writeCountAs(
        AGENT_A,
        `insert into public.instagram_comments ${COLS_COMMENT} values ${commentValues(ORG_A, "c-agent")}`,
      ),
    ).toBe(1);
  });
});

describe("0280 · instagram_comment_rules", () => {
  const COLS_RULE =
    "(organization_id, channel_session_id, media_id, palavra, texto_do_direct, frase_publica)";
  function ruleValues(org: string, palavra: string): string {
    return `('${org}', '${SESSION_A}', 'media-1', '${palavra}', 'te chamo no direct', 'olha seu direct!')`;
  }

  it("nasce com RLS ligada e as policies de tenant (select solto + write com papel)", () => {
    expect(
      sql(`select relrowsecurity from pg_class where relname = 'instagram_comment_rules'`),
    ).toBe("t");
    expect(
      sql(`select string_agg(policyname, ',' order by policyname) from pg_policies
            where schemaname = 'public' and tablename = 'instagram_comment_rules' and permissive = 'PERMISSIVE'`),
    ).toBe("instagram_comment_rules_select,instagram_comment_rules_write");
  });

  it("membro (manager) da org A escreve na própria org e lê de volta; org B não vê", () => {
    expect(
      writeCountAs(
        MEMBER_A,
        `insert into public.instagram_comment_rules ${COLS_RULE} values ${ruleValues(ORG_A, "preco")}`,
      ),
    ).toBe(1);
    expect(
      countAs(
        MEMBER_B,
        `select count(*) from public.instagram_comment_rules where organization_id = '${ORG_A}';`,
      ),
    ).toBe(0);
  });

  it("agent da própria org NÃO escreve (a policy de escrita exige `manager`)", () => {
    expect(
      writeCountAs(
        AGENT_A,
        `insert into public.instagram_comment_rules ${COLS_RULE} values ${ruleValues(ORG_A, "agent-nao-escreve")}`,
      ),
    ).toBe(0);
  });
});

describe("0281 · agent_inbox_items_kind_check ganha 'instagram_comment_stuck'", () => {
  it("aceita o kind novo — o aviso anti-morte do worker de comentários", () => {
    seed();
    const inserida = sql(
      `insert into public.agent_inbox_items (organization_id, kind, severity, title, ref_kind, ref_id)
         values ('${ORG_A}', 'instagram_comment_stuck', 'warn', 'Comentário parado há mais de 1h', 'instagram_comment', gen_random_uuid())
       returning id;`,
    );
    expect(inserida).not.toBe("");
  });
});
