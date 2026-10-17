import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_CONV_AGENT_B,
  GOV_CONV_UNASSIGNED,
  GOV_MANAGER,
  GOV_ORG,
  GOV_SESSION,
  lastLine,
  seedGov,
  sql,
} from "./gov-helpers";

/**
 * O push de mensagem recebida sai só para as inscrições de quem PODE VER a
 * conversa (migration 0378). A régua é a da RLS de `conversations`
 * (`fn_can_view_conversation`), não uma cópia: os casos abaixo são os mesmos
 * de `gov-5-visibility-scope.test.ts`, agora do lado do envio — mais o papel
 * `provider` deste fork, que só vê a conversa atribuída a ele (sigilo médico).
 *
 * GOV_ORG está no default `own_and_unassigned`; GOV_CONV_AGENT_B é do agent B.
 *
 * Portado do projeto original (DeskcommCRM, PR #2590 de @melgarafael).
 */

// Namespace exclusivo deste arquivo.
const REVOGADO = "abab0378-1111-4000-8000-000000000001";
const PROFISSIONAL = "abab0378-1111-4000-8000-000000000002";
const OUTRA_ORG = "abab0378-0000-4000-8000-000000000001";
const CONTATO_DO_PROFISSIONAL = "abab0378-3333-4000-8000-000000000001";
const CONV_DO_PROFISSIONAL = "abab0378-4444-4000-8000-000000000001";

const SUB = {
  a: "https://push.invariant.test/0378-agente-a",
  b: "https://push.invariant.test/0378-agente-b",
  manager: "https://push.invariant.test/0378-manager",
  revogado: "https://push.invariant.test/0378-revogado",
  profissional: "https://push.invariant.test/0378-profissional",
};

function inscricoesQueVeem(org: string, conversa: string): string[] {
  const out = sql(
    `select coalesce(string_agg(endpoint, ',' order by endpoint), '')
       from public.fn_push_inscricoes_que_veem_a_conversa('${org}', '${conversa}');`,
  );
  const linha = lastLine(out);
  return linha ? linha.split(",") : [];
}

function definirModo(modo: "own" | "all" | "own_and_unassigned"): void {
  sql(`update public.organizations set settings = coalesce(settings, '{}'::jsonb) || '{"visibility_mode":"${modo}"}'
        where id = '${GOV_ORG}';`);
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into auth.users (id, email) values
      ('${REVOGADO}', 'push-0378-revogado@invariant.test'),
      ('${PROFISSIONAL}', 'push-0378-profissional@invariant.test')
    on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at, revoked_at) values
      ('${REVOGADO}', '${GOV_ORG}', 'agent', now(), now()),
      ('${PROFISSIONAL}', '${GOV_ORG}', 'provider', now(), null)
    on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${OUTRA_ORG}', 'push-0378-outra', 'Push Outra Org', 'Push Outra') on conflict do nothing;
    insert into public.push_subscriptions (organization_id, user_id, endpoint, p256dh, auth) values
      ('${GOV_ORG}', '${GOV_AGENT_A}', '${SUB.a}', 'k', 'a'),
      ('${GOV_ORG}', '${GOV_AGENT_B}', '${SUB.b}', 'k', 'a'),
      ('${GOV_ORG}', '${GOV_MANAGER}', '${SUB.manager}', 'k', 'a'),
      ('${GOV_ORG}', '${REVOGADO}', '${SUB.revogado}', 'k', 'a'),
      ('${GOV_ORG}', '${PROFISSIONAL}', '${SUB.profissional}', 'k', 'a')
    on conflict (endpoint) do nothing;
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_DO_PROFISSIONAL}', '${GOV_ORG}', 'Paciente Ficticio 0378')
    on conflict do nothing;
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id)
    values
      ('${CONV_DO_PROFISSIONAL}', '${GOV_ORG}', '${CONTATO_DO_PROFISSIONAL}', '${GOV_SESSION}', 'claimed', '${PROFISSIONAL}')
    on conflict do nothing;
  `);
  definirModo("own_and_unassigned");
});

describe("push de mensagem recebida: só a quem pode ver a conversa", () => {
  it("conversa do agent B: B e o manager recebem; o agent A e o profissional não", () => {
    expect(inscricoesQueVeem(GOV_ORG, GOV_CONV_AGENT_B).sort()).toEqual([SUB.b, SUB.manager].sort());
  });

  it("conversa sem dono em own_and_unassigned: os dois agents e o manager; profissional e vínculo revogado nunca", () => {
    expect(inscricoesQueVeem(GOV_ORG, GOV_CONV_UNASSIGNED).sort()).toEqual(
      [SUB.a, SUB.b, SUB.manager].sort(),
    );
  });

  it("a conversa atribuída ao profissional chega a ele (quem atende nunca deixa de ser avisado)", () => {
    expect(inscricoesQueVeem(GOV_ORG, CONV_DO_PROFISSIONAL)).toContain(SUB.profissional);
  });

  it("conversa pedida por outra organização: ninguém", () => {
    expect(inscricoesQueVeem(OUTRA_ORG, GOV_CONV_AGENT_B)).toEqual([]);
  });

  // Na MESMA transação, como o PostgREST chama: fora dela o set_config local
  // já se desfaria sozinho e o caso passaria sem medir nada. Sem `commit` de
  // propósito: o psql imprimiria "COMMIT" como última linha.
  it("devolve as claims de quem chamou intactas", () => {
    const out = sql(`
      begin;
      select set_config('request.jwt.claims', '{"sub":"${GOV_AGENT_A}"}', true);
      select count(*) from public.fn_push_inscricoes_que_veem_a_conversa('${GOV_ORG}', '${GOV_CONV_AGENT_B}');
      select current_setting('request.jwt.claims') || '|' || auth.uid()::text;
    `);
    expect(lastLine(out)).toBe(`{"sub":"${GOV_AGENT_A}"}|${GOV_AGENT_A}`);
  });

  it("só o service role executa", () => {
    const out = sql(`
      select string_agg(r, ',' order by r) from unnest(array['anon','authenticated','service_role']) r
       where has_function_privilege(r, 'public.fn_push_inscricoes_que_veem_a_conversa(uuid, uuid)', 'execute');
    `);
    expect(lastLine(out)).toBe("service_role");
  });

  // Daqui para baixo muda o visibility_mode do GOV_ORG (cada arquivo tem banco
  // próprio); os casos rodam em ordem.
  it("conversa sem dono em 'own': só o manager", () => {
    definirModo("own");
    expect(inscricoesQueVeem(GOV_ORG, GOV_CONV_UNASSIGNED)).toEqual([SUB.manager]);
  });

  it("em 'all', todos os agents recebem — e o profissional continua só com a dele", () => {
    definirModo("all");
    expect(inscricoesQueVeem(GOV_ORG, GOV_CONV_AGENT_B).sort()).toEqual([SUB.a, SUB.b, SUB.manager].sort());
    expect(inscricoesQueVeem(GOV_ORG, CONV_DO_PROFISSIONAL).sort()).toEqual(
      [SUB.a, SUB.b, SUB.manager, SUB.profissional].sort(),
    );
  });
});
