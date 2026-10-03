import { describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * `fn_respostas_prontas_metricas` (migration 0306): a medição agregada no banco.
 * Duas organizações; a função nunca conta linha da outra, respeita a RLS do
 * chamador e não é executável pela anon key.
 */
const ORG_A = "0306cccc-0000-4000-8000-000000000001";
const ORG_B = "0306dddd-0000-4000-8000-000000000002";
const GESTOR_A = "0306cccc-1111-4000-8000-000000000001";
const ITEM_A = "0306cccc-3333-4000-8000-000000000001";
const ITEM_B = "0306dddd-3333-4000-8000-000000000002";
const JOB_A1 = "0306cccc-4444-4000-8000-000000000001";
const JOB_A2 = "0306cccc-4444-4000-8000-000000000002";
const JOB_B1 = "0306dddd-4444-4000-8000-000000000001";

const CHAMADA = (org: string, job: string, cost: string) =>
  `insert into public.llm_calls (organization_id, job_id, purpose, provider, model, cost_cents)
   values ('${org}', '${job}', 'agent_turn', 'anthropic', 'm', ${cost});`;

function seed(): void {
  sql(`
    insert into auth.users (id, email) values ('${GESTOR_A}', 'rpm-gestor-a@invariant.test') on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'rpm-inv-a', 'RPM Inv A', 'RPM A'),
      ('${ORG_B}', 'rpm-inv-b', 'RPM Inv B', 'RPM B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${GESTOR_A}', '${ORG_A}', 'manager', now()) on conflict do nothing;
    insert into public.respostas_prontas (id, organization_id, titulo, resposta) values
      ('${ITEM_A}', '${ORG_A}', 'a', 'a'), ('${ITEM_B}', '${ORG_B}', 'b', 'b') on conflict do nothing;
    insert into public.job_queue (id, organization_id, kind) values
      ('${JOB_A1}', '${ORG_A}', 'watchdog'), ('${JOB_A2}', '${ORG_A}', 'watchdog'),
      ('${JOB_B1}', '${ORG_B}', 'watchdog') on conflict do nothing;
    delete from public.llm_calls where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.respostas_prontas_usos where organization_id in ('${ORG_A}', '${ORG_B}');
    -- a conversa não importa para a conta: FKs desligadas só neste insert
    set session_replication_role = replica;
    insert into public.respostas_prontas_usos (organization_id, resposta_pronta_id, conversation_id, similaridade) values
      ('${ORG_A}', '${ITEM_A}', gen_random_uuid(), 0.9), ('${ORG_A}', '${ITEM_A}', gen_random_uuid(), 0.9),
      ('${ORG_B}', '${ITEM_B}', gen_random_uuid(), 0.9);
    set session_replication_role = origin;
    ${CHAMADA(ORG_A, JOB_A1, "1")} ${CHAMADA(ORG_A, JOB_A1, "2")} ${CHAMADA(ORG_A, JOB_A2, "3")}
    ${CHAMADA(ORG_B, JOB_B1, "50")}
  `);
}

const CHAMA = (org: string) =>
  `select resolvidas || '|' || respondidas_pela_ia || '|' || custo_total_cents || '|' || custo_incompleto
   from public.fn_respostas_prontas_metricas('${org}', now() - interval '1 day', now() + interval '1 minute');`;

function comoGestor(consulta: string): string {
  return lastLine(
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${GESTOR_A}"}', false);
      ${consulta}
    `),
  );
}

describe("0306 · fn_respostas_prontas_metricas", () => {
  it("conta só a organização pedida: jobs distintos, custo somado", () => {
    seed();
    expect(comoGestor(CHAMA(ORG_A))).toBe("2|2|6|false");
  });

  it("gestor da A pedindo a org B recebe zeros (a RLS vale — nunca conta linha alheia)", () => {
    expect(comoGestor(CHAMA(ORG_B))).toBe("0|0|0|false");
  });

  it("preço desconhecido vira custo_incompleto", () => {
    sql(`insert into public.llm_calls (organization_id, job_id, purpose, provider, model, cost_cents)
         values ('${ORG_A}', '${JOB_A2}', 'agent_turn', 'anthropic', 'm', null);`);
    expect(comoGestor(CHAMA(ORG_A))).toBe("2|2|6|true");
  });

  it("anon não executa a função", () => {
    let erro = "";
    try {
      sql(`set role anon; ${CHAMA(ORG_A)}`);
    } catch (e) {
      erro = String((e as { stderr?: Buffer | string }).stderr ?? "");
    }
    expect(erro).toContain("permission denied");
  });
});
