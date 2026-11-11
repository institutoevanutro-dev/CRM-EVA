import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_AGENT_B, GOV_MANAGER, GOV_VIEWER, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * "Esperando resposta" do Início (migration 0408): `fn_inicio_esperando`.
 *
 * A regra mora só aqui, para o "Meu dia" e para a "Visão da clínica". Prova:
 * (1) quem entra — não é grupo, não é contato oculto, está aberta e a última
 * mensagem é do paciente; (2) o corte entre espera RECENTE e antiga, medido
 * pelo COMEÇO da espera (`awaiting_since`), não pela última mensagem; (3) o
 * recorte "com você" e "sem responsável"; (4) que a RLS de quem lê decide o
 * que conta — o quadro nunca conta conversa que a pessoa não consegue abrir;
 * e (5) que outra organização devolve zero.
 */
const ORG = "bed00000-0000-4000-8000-000000000001";
const VIZINHA = "bed00000-0000-4000-8000-000000000002";
const SESSAO = "bed00000-0000-4000-8000-0000000000aa";
const SESSAO_VIZ = "bed00000-0000-4000-8000-0000000000bb";
const C = (n: number) => `bed01111-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const CONV = (n: number) => `bed02222-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
// No org deste arquivo, o usuário "viewer" do seed entra como PROFISSIONAL.
const PROFISSIONAL = GOV_VIEWER;

// "Agora" é 07/03 ao meio-dia (UTC); a espera é recente a partir de 04/03 ao meio-dia.
const CORTE = "2026-03-04T12:00:00Z";

function esperando(org: string, quem: string) {
  return JSON.parse(
    lastLine(
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${quem}"}', false);
        select public.fn_inicio_esperando('${org}', '${CORTE}');
      `),
    ),
  );
}

/** (n, status, grupo, responsável, começo da espera, última do paciente, última da equipe) */
type Linha = [number, string, boolean, string | null, string | null, string, string | null];
const A = GOV_AGENT_A;
const B = GOV_AGENT_B;
const CONVERSAS: Linha[] = [
  // Da atendente A, recente: insistiu hoje, mas espera desde ontem.
  [1, "open", false, A, "2026-03-06T10:00:00Z", "2026-03-07T09:00:00Z", "2026-03-05T10:00:00Z"],
  // Da A, exatamente no corte: ainda é recente.
  [2, "open", false, A, null, "2026-03-04T12:00:00Z", null],
  // Da A, ANTIGA: escreveu ontem de novo, mas espera há mais de 3 dias.
  [3, "open", false, A, "2026-03-04T11:59:59Z", "2026-03-06T09:00:00Z", "2026-03-01T10:00:00Z"],
  // Da atendente B, recente.
  [4, "open", false, B, null, "2026-03-07T08:00:00Z", null],
  // Sem responsável, recentes (cinco) e uma antiga.
  [5, "open", false, null, null, "2026-03-05T08:00:00Z", null],
  [6, "open", false, null, null, "2026-03-05T09:00:00Z", null],
  [7, "open", false, null, null, "2026-03-05T10:00:00Z", null],
  [8, "open", false, null, null, "2026-03-05T11:00:00Z", null],
  [9, "open", false, null, null, "2026-03-05T12:00:00Z", null],
  [10, "open", false, null, null, "2026-02-20T08:00:00Z", null],
  // Não esperam: respondida, grupo, encerrada.
  [11, "open", false, null, null, "2026-03-07T08:00:00Z", "2026-03-07T08:05:00Z"],
  [12, "open", true, null, null, "2026-03-07T08:00:00Z", null],
  [13, "closed", false, A, null, "2026-03-07T08:00:00Z", null],
];
const q = (v: string | null) => (v === null ? "null" : `'${v}'`);

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'espera-clinica', 'Clínica Espera', 'Espera'),
      ('${VIZINHA}', 'espera-vizinha', 'Vizinha Espera', 'Vizinha');
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GOV_MANAGER}', '${ORG}', 'manager', now()),
      ('${A}', '${ORG}', 'agent', now()),
      ('${B}', '${ORG}', 'agent', now()),
      ('${PROFISSIONAL}', '${ORG}', 'provider', now());
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values
      ('${SESSAO}', '${ORG}', 'espera', '\\x00'::bytea),
      ('${SESSAO_VIZ}', '${VIZINHA}', 'espera-viz', '\\x00'::bytea);

    insert into public.contacts (id, organization_id, display_name) values
      ${CONVERSAS.map(([n]) => `('${C(n)}', '${ORG}', 'Paciente ${n}')`).join(",\n      ")},
      ('${C(90)}', '${VIZINHA}', 'Vizinho');
    -- Contato oculto do Inbox (0372): a conversa herda a marca do contato.
    insert into public.contacts (id, organization_id, display_name, inbox_hidden_at) values
      ('${C(14)}', '${ORG}', 'Oculto', now());
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, is_group, assigned_to_user_id, awaiting_since, last_inbound_at, last_outbound_at) values
      ${CONVERSAS.map(
        ([n, status, grupo, dono, desde, entrada, saida]) =>
          `('${CONV(n)}', '${ORG}', '${C(n)}', '${SESSAO}', '${status}', ${grupo}, ${q(dono)}, ${q(desde)}, ${q(entrada)}, ${q(saida)})`,
      ).join(",\n      ")},
      ('${CONV(14)}', '${ORG}', '${C(14)}', '${SESSAO}', 'open', false, null, null, '2026-03-07T08:00:00Z', null),
      ('${CONV(90)}', '${VIZINHA}', '${C(90)}', '${SESSAO_VIZ}', 'open', false, null, null, '2026-03-07T08:00:00Z', null);
  `);
});

describe("fn_inicio_esperando", () => {
  it("atendente: conta as DELA e as sem responsável; a da colega não entra (a RLS não a deixa abrir)", () => {
    const r = esperando(ORG, A);
    expect(r.ve_sem_responsavel).toBe(true);
    // Recentes: 2 dela + 5 sem responsável. A da colega B fica fora até do total.
    expect(r.recentes).toEqual({ total: 7, com_voce: 2, sem_responsavel: 5 });
    // Antigas: a dela que espera há mais de 3 dias (apesar da mensagem de ontem) e a sem responsável de fevereiro.
    expect(r.antigas).toEqual({ total: 2, com_voce: 1, sem_responsavel: 1 });
  });

  it("a lista são as 5 recentes que esperam há mais tempo, dela e sem responsável, com o nome do paciente", () => {
    const r = esperando(ORG, A);
    expect(r.itens.map((i: { id: string }) => i.id)).toEqual([CONV(2), CONV(5), CONV(6), CONV(7), CONV(8)]);
    expect(r.itens[0]).toMatchObject({ display_name: "Paciente 2", name: null });
    expect(r.itens[0].desde).toMatch(/^2026-03-04T12:00:00/);
  });

  it("gerente: o total é a clínica toda; 'com você' é zero e a lista é só a fila sem responsável", () => {
    const r = esperando(ORG, GOV_MANAGER);
    expect(r.recentes).toEqual({ total: 8, com_voce: 0, sem_responsavel: 5 });
    expect(r.antigas).toEqual({ total: 2, com_voce: 0, sem_responsavel: 1 });
    expect(r.itens.map((i: { id: string }) => i.id)).toEqual([CONV(5), CONV(6), CONV(7), CONV(8), CONV(9)]);
  });

  it("profissional só abre as dele: não conta conversa sem responsável, e a tela é avisada disso", () => {
    const r = esperando(ORG, PROFISSIONAL);
    expect(r.ve_sem_responsavel).toBe(false);
    expect(r.recentes).toEqual({ total: 0, com_voce: 0, sem_responsavel: 0 });
    expect(r.antigas.total).toBe(0);
    expect(r.itens).toEqual([]);
  });

  it("organização em modo 'só as minhas': a atendente deixa de contar a fila sem responsável", () => {
    const modo = (valor: string) =>
      sql(`update public.organizations set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{visibility_mode}', '"${valor}"') where id = '${ORG}';`);
    modo("own");
    let r;
    try {
      r = esperando(ORG, A);
    } finally {
      modo("own_and_unassigned");
    }
    expect(r.ve_sem_responsavel).toBe(false);
    expect(r.recentes).toEqual({ total: 2, com_voce: 2, sem_responsavel: 0 });
  });

  it("quem não é membro da org recebe zero, nunca os dados dela", () => {
    const r = esperando(VIZINHA, GOV_MANAGER);
    expect(r).toEqual({
      ve_sem_responsavel: false,
      recentes: { total: 0, com_voce: 0, sem_responsavel: 0 },
      antigas: { total: 0, com_voce: 0, sem_responsavel: 0 },
      itens: [],
    });
  });

  it("anon não executa", () => {
    expect(
      lastLine(sql(`select has_function_privilege('anon', 'public.fn_inicio_esperando(uuid, timestamptz)', 'execute');`)),
    ).toBe("f");
  });
});
