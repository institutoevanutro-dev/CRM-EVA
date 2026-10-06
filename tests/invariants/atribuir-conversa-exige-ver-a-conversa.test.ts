/**
 * 0319 — QUEM NÃO VÊ A CONVERSA NÃO A ATRIBUI.
 *
 * Achado da revisão do PR 128. `fn_conversation_assign` é `security definer`,
 * tem `grant execute … to authenticated` e só conferia o papel (`agent`). Não
 * perguntava se quem chama ENXERGA a conversa. Como a 0319 pendurou a leitura do
 * caso, da linha do tempo e da nota na visibilidade da conversa, a função era a
 * porta dos fundos: o atendente A chamava o RPC com a conversa do colega B,
 * passava a ser o dono, e tudo o que a RLS escondia dele ficava legível.
 *
 * A regra agora é a mesma da tela: para atribuir pela sessão é preciso ver a
 * conversa COMO ELA ESTÁ (`fn_can_view_conversation` com o dono atual). Quem não
 * vê recebe zero linhas, igual a "conversa não encontrada" — a função não
 * confirma a existência dela. O servidor (roteador, MCP, motor: sem `auth.uid()`)
 * não passa por essa pergunta.
 *
 * O que NÃO mudou, de propósito: transferir para um colega continua imediato e
 * sem aceite (decisão G1-06d), e quem fez fica em `changed_by`.
 *
 * Como foi conferido que nasce VERMELHO: rodado contra o baseline do commit
 * 5db5e1252, o atendente A assumia a conversa do B (1 linha) e passava a ler o
 * caso e a nota dela.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_MANAGER,
  GOV_ORG,
  GOV_SESSION,
  countAs,
  seedGov,
  sql,
} from "./gov-helpers";

const id = (n: number) => `a551a000-0319-4000-8000-${String(n).padStart(12, "0")}`;

/** Conversas próprias deste arquivo, todas com dono e caso, uma por cenário. */
const DO_B_FURTO = 1;
const DO_B_TRANSFERE_TERCEIRO = 2;
const DO_B_GESTOR = 3;
const DO_B_SOLTA = 4;
const LIVRE_PADRAO = 5;
const LIVRE_SO_OS_SEUS = 6;
const DO_B_SERVIDOR = 7;
const conversa = (n: number) => id(100 + n);
const contato = (n: number) => id(200 + n);
const caso = (n: number) => id(300 + n);

const atribuirComo = (usuario: string, n: number, args: string) =>
  countAs(
    usuario,
    `select count(*) from public.fn_conversation_assign('${GOV_ORG}'::uuid, '${conversa(n)}'::uuid, ${args});`,
  );
const donoDe = (n: number) =>
  sql(`select coalesce(assigned_to_user_id::text, 'ninguem') from public.conversations where id = '${conversa(n)}';`);
const eventosDe = (n: number) =>
  Number(sql(`select count(*) from public.conversation_assignment_events where conversation_id = '${conversa(n)}';`));
const lerCaso = (usuario: string, n: number) =>
  countAs(usuario, `select count(*) from public.agent_cases where id = '${caso(n)}';`);

function modoDeVisibilidade(modo: string | null): void {
  sql(
    modo === null
      ? `update public.organizations set settings = coalesce(settings, '{}'::jsonb) - 'visibility_mode' where id = '${GOV_ORG}';`
      : `update public.organizations set settings = coalesce(settings, '{}'::jsonb) || '{"visibility_mode":"${modo}"}'::jsonb where id = '${GOV_ORG}';`,
  );
}

beforeAll(() => {
  seedGov();
  const linhas = [
    [DO_B_FURTO, GOV_AGENT_B],
    [DO_B_TRANSFERE_TERCEIRO, GOV_AGENT_B],
    [DO_B_GESTOR, GOV_AGENT_B],
    [DO_B_SOLTA, GOV_AGENT_B],
    [LIVRE_PADRAO, null],
    [LIVRE_SO_OS_SEUS, null],
    [DO_B_SERVIDOR, GOV_AGENT_B],
  ] as const;
  sql(
    linhas
      .map(
        ([n, dono]) => `
    insert into public.contacts (id, organization_id, display_name)
      values ('${contato(n)}', '${GOV_ORG}', 'Contato ${n}');
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at, assignee_kind)
      values ('${conversa(n)}', '${GOV_ORG}', '${contato(n)}', '${GOV_SESSION}',
              ${dono ? `'claimed', '${dono}', now(), 'user'` : `'open', null, null, null`});
    insert into public.agent_cases (id, organization_id, conversation_id, title, summary, blocker)
      values ('${caso(n)}', '${GOV_ORG}', '${conversa(n)}', 'Caso ${n}', 'Resumo da IA', 'Falta decisão');`,
      )
      .join("\n"),
  );
});

afterAll(() => modoDeVisibilidade(null));

describe("0319 — o RPC de atribuir não fura a visibilidade da conversa", () => {
  it("CONTROLE DE CENÁRIO: no modo padrão o atendente A não lê o caso da conversa do B", () => {
    expect(lerCaso(GOV_AGENT_A, DO_B_FURTO)).toBe(0);
    expect(lerCaso(GOV_AGENT_B, DO_B_FURTO)).toBe(1);
  });

  it("o atendente A não ASSUME a conversa do colega pelo RPC (antes → 1, e o caso ficava legível)", () => {
    expect(atribuirComo(GOV_AGENT_A, DO_B_FURTO, `'${GOV_AGENT_A}'::uuid, 'claim'`)).toBe(0);
    expect(donoDe(DO_B_FURTO)).toBe(GOV_AGENT_B);
    expect(eventosDe(DO_B_FURTO)).toBe(0);
    expect(lerCaso(GOV_AGENT_A, DO_B_FURTO)).toBe(0);
  });

  it("nem dizendo quem é o dono atual (a tomada consciente só vale para quem vê a conversa)", () => {
    expect(
      atribuirComo(GOV_AGENT_A, DO_B_FURTO, `'${GOV_AGENT_A}'::uuid, 'claim', '${GOV_AGENT_B}'::uuid, true`),
    ).toBe(0);
    expect(donoDe(DO_B_FURTO)).toBe(GOV_AGENT_B);
  });

  it("o atendente A não TRANSFERE nem SOLTA a conversa que não vê (antes → 1)", () => {
    expect(
      atribuirComo(GOV_AGENT_A, DO_B_TRANSFERE_TERCEIRO, `'${GOV_MANAGER}'::uuid, 'transfer'`),
    ).toBe(0);
    expect(atribuirComo(GOV_AGENT_A, DO_B_TRANSFERE_TERCEIRO, `null::uuid, 'release'`)).toBe(0);
    expect(donoDe(DO_B_TRANSFERE_TERCEIRO)).toBe(GOV_AGENT_B);
    expect(eventosDe(DO_B_TRANSFERE_TERCEIRO)).toBe(0);
  });

  it("no modo 'Só os seus' o atendente não assume a conversa sem dono, que ele não vê (antes → 1)", () => {
    modoDeVisibilidade("own");
    try {
      expect(atribuirComo(GOV_AGENT_A, LIVRE_SO_OS_SEUS, `'${GOV_AGENT_A}'::uuid, 'claim'`)).toBe(0);
      expect(donoDe(LIVRE_SO_OS_SEUS)).toBe("ninguem");
    } finally {
      modoDeVisibilidade(null);
    }
  });
});

describe("0319 — o que tinha de continuar funcionando", () => {
  it("no modo padrão o atendente assume a conversa SEM dono, que ele vê", () => {
    expect(atribuirComo(GOV_AGENT_A, LIVRE_PADRAO, `'${GOV_AGENT_A}'::uuid, 'claim', null::uuid, true`)).toBe(1);
    expect(donoDe(LIVRE_PADRAO)).toBe(GOV_AGENT_A);
  });

  it("o dono transfere e quem recebe solta: cada um vê a conversa no momento em que age", () => {
    expect(atribuirComo(GOV_AGENT_B, DO_B_SOLTA, `'${GOV_AGENT_A}'::uuid, 'transfer'`)).toBe(1);
    expect(
      atribuirComo(GOV_AGENT_A, DO_B_SOLTA, `null::uuid, 'release', '${GOV_AGENT_A}'::uuid, true`),
    ).toBe(1);
    expect(donoDe(DO_B_SOLTA)).toBe("ninguem");
    expect(eventosDe(DO_B_SOLTA)).toBe(2);
  });

  it("o GESTOR vê todas e transfere a conversa de um atendente para outro", () => {
    expect(atribuirComo(GOV_MANAGER, DO_B_GESTOR, `'${GOV_AGENT_A}'::uuid, 'transfer'`)).toBe(1);
    expect(donoDe(DO_B_GESTOR)).toBe(GOV_AGENT_A);
  });

  it("no modo 'Todos veem tudo' o atendente assume a conversa de um colega dizendo quem é o dono", () => {
    modoDeVisibilidade("all");
    try {
      expect(
        atribuirComo(
          GOV_AGENT_A,
          DO_B_TRANSFERE_TERCEIRO,
          `'${GOV_AGENT_A}'::uuid, 'claim', '${GOV_AGENT_B}'::uuid, true`,
        ),
      ).toBe(1);
    } finally {
      modoDeVisibilidade(null);
    }
  });

  it("o SERVIDOR (sem sessão) atribui qualquer conversa: roteador, MCP e motor não mudam", () => {
    const linhas = sql(`
      set role service_role;
      select count(*) from public.fn_conversation_assign(
        '${GOV_ORG}'::uuid, '${conversa(DO_B_SERVIDOR)}'::uuid, '${GOV_AGENT_A}'::uuid, 'routing');
    `)
      .split("\n")
      .at(-1);
    expect(linhas).toBe("1");
    expect(donoDe(DO_B_SERVIDOR)).toBe(GOV_AGENT_A);
  });
});
