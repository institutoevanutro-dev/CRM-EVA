import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_MANAGER, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * Visão da clínica do Início (migration 0376): `fn_inicio_resumo_da_clinica`.
 *
 * SECURITY INVOKER: prova (1) os números — valores distintos por coluna, para
 * troca de coluna reprovar —, (2) que compromisso excluído, conversa de grupo,
 * oculta ou encerrada não contam e (3) que quem pede a org de que não é membro
 * recebe ZERO, nunca os dados dela.
 */
const ORG = "bec00000-0000-4000-8000-000000000001";
const VIZINHA = "bec00000-0000-4000-8000-000000000002";
const SESSAO = "bec00000-0000-4000-8000-0000000000aa";
const SESSAO_VIZ = "bec00000-0000-4000-8000-0000000000bb";
const C = (n: number) => `bec01111-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const CONV = (n: number) => `bec02222-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const FUNIL = "bec04444-0000-4000-8000-000000000001";
const ETAPA = "bec04444-0000-4000-8000-000000000011";

// Semana de 02/03 a 08/03/2026 em São Paulo; "hoje" = 04/03; mês = março.
const HOJE_DE = "2026-03-04T03:00:00Z";
const HOJE_ATE = "2026-03-05T03:00:00Z";
const SEM_DE = "2026-03-02T03:00:00Z";
const SEM_ATE = "2026-03-09T03:00:00Z";
const MES_DE = "2026-03-01T03:00:00Z";
const MES_ATE = "2026-04-01T03:00:00Z";
const ANT_DE = "2026-02-01T03:00:00Z";

function resumo(org: string, quem = GOV_MANAGER) {
  return JSON.parse(
    lastLine(
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${quem}"}', false);
        select public.fn_inicio_resumo_da_clinica('${org}', '${HOJE_DE}', '${HOJE_ATE}', '${SEM_DE}', '${SEM_ATE}', '${MES_DE}', '${MES_ATE}', '${ANT_DE}');
      `),
    ),
  );
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'visao-clinica', 'Clínica Visão', 'Visão'),
      ('${VIZINHA}', 'visao-vizinha', 'Vizinha Visão', 'Vizinha');
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GOV_MANAGER}', '${ORG}', 'manager', now()),
      ('${GOV_AGENT_A}', '${ORG}', 'agent', now());
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values
      ('${SESSAO}', '${ORG}', 'visao', '\\x00'::bytea),
      ('${SESSAO_VIZ}', '${VIZINHA}', 'visao-viz', '\\x00'::bytea);

    -- Agenda: o gerente tem 2 hoje (1h e 30min), 1 realizada, 1 falta e 1 cancelada
    -- na semana; o atendente tem 1 confirmada; 1 excluída e 1 fora da semana não contam.
    insert into public.calendar_appointments (organization_id, title, starts_at, ends_at, owner_user_id, status) values
      ('${ORG}', 'h1', '2026-03-04T12:00:00Z', '2026-03-04T13:00:00Z', '${GOV_MANAGER}', 'confirmed'),
      ('${ORG}', 'h2', '2026-03-04T14:00:00Z', '2026-03-04T14:30:00Z', '${GOV_MANAGER}', 'completed'),
      ('${ORG}', 's1', '2026-03-02T12:00:00Z', '2026-03-02T13:00:00Z', '${GOV_MANAGER}', 'no_show'),
      ('${ORG}', 's2', '2026-03-06T12:00:00Z', '2026-03-06T13:00:00Z', '${GOV_AGENT_A}', 'confirmed'),
      ('${ORG}', 'fora', '2026-03-10T12:00:00Z', '2026-03-10T13:00:00Z', '${GOV_MANAGER}', 'confirmed'),
      ('${ORG}', 'excl', '2026-03-04T16:00:00Z', '2026-03-04T17:00:00Z', '${GOV_MANAGER}', 'confirmed');
    insert into public.calendar_appointments (organization_id, title, starts_at, ends_at, owner_user_id, status, cancelled_at) values
      ('${ORG}', 'canc', '2026-03-05T12:00:00Z', '2026-03-05T13:00:00Z', '${GOV_MANAGER}', 'cancelled', '2026-03-01T12:00:00Z');
    update public.calendar_appointments set status = 'cancelled', cancelled_at = now(), excluded_at = now(), exclusion_reason = 'teste'
      where organization_id = '${ORG}' and title = 'excl';
    insert into public.calendar_appointments (organization_id, title, starts_at, ends_at, owner_user_id, status) values
      ('${VIZINHA}', 'viz', '2026-03-04T12:00:00Z', '2026-03-04T13:00:00Z', '${GOV_MANAGER}', 'confirmed');

    -- Conversas: 2 esperando (1 sem responsável), 1 respondida; grupo, oculta e encerrada não contam.
    insert into public.contacts (id, organization_id, display_name) values
      ('${C(1)}', '${ORG}', 'A'), ('${C(2)}', '${ORG}', 'B'), ('${C(3)}', '${ORG}', 'C'),
      ('${C(4)}', '${ORG}', 'D'), ('${C(5)}', '${ORG}', 'E'),
      ('${C(9)}', '${VIZINHA}', 'V');
    -- Contato oculto do Inbox (0372): a conversa herda a marca do contato.
    insert into public.contacts (id, organization_id, display_name, inbox_hidden_at) values
      ('${C(6)}', '${ORG}', 'F', now());
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, is_group, assigned_to_user_id, last_inbound_at, last_outbound_at) values
      ('${CONV(1)}', '${ORG}', '${C(1)}', '${SESSAO}', 'open', false, '${GOV_AGENT_A}', '2026-03-04T12:00:00Z', '2026-03-04T11:00:00Z'),
      ('${CONV(2)}', '${ORG}', '${C(2)}', '${SESSAO}', 'open', false, null,              '2026-03-04T10:00:00Z', null),
      ('${CONV(3)}', '${ORG}', '${C(3)}', '${SESSAO}', 'open', false, null,              '2026-03-04T10:00:00Z', '2026-03-04T10:05:00Z'),
      ('${CONV(4)}', '${ORG}', '${C(4)}', '${SESSAO}', 'open', true,  null,              '2026-03-04T10:00:00Z', null),
      ('${CONV(5)}', '${ORG}', '${C(5)}', '${SESSAO}', 'closed', false, null,            '2026-03-04T10:00:00Z', null),
      ('${CONV(9)}', '${VIZINHA}', '${C(9)}', '${SESSAO_VIZ}', 'open', false, null,      '2026-03-04T10:00:00Z', null);
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, is_group, last_inbound_at) values
      ('${CONV(6)}', '${ORG}', '${C(6)}', '${SESSAO}', 'open', false, '2026-03-04T10:00:00Z');

    -- Leads: 3 novos em março e 1 em fevereiro; 2 ganhos em março e 1 em fevereiro.
    insert into public.crm_pipelines (id, organization_id, name, slug) values ('${FUNIL}', '${ORG}', 'Pacientes', 'visao-pac');
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${ETAPA}', '${ORG}', '${FUNIL}', 'Avaliação', 'av', 1000);
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, status, closed_at, created_at) values
      ('${ORG}', '${FUNIL}', '${ETAPA}', 'n1', 'open', null, '2026-03-02T12:00:00Z'),
      ('${ORG}', '${FUNIL}', '${ETAPA}', 'n2', 'won', '2026-03-03T12:00:00Z', '2026-03-02T12:00:00Z'),
      ('${ORG}', '${FUNIL}', '${ETAPA}', 'n3', 'won', '2026-03-20T12:00:00Z', '2026-03-10T12:00:00Z'),
      ('${ORG}', '${FUNIL}', '${ETAPA}', 'f1', 'won', '2026-02-20T12:00:00Z', '2026-02-10T12:00:00Z');
  `);
});

describe("fn_inicio_resumo_da_clinica", () => {
  it("agenda por profissional: hoje, semana, horas, realizadas, faltas e canceladas", () => {
    const r = resumo(ORG);
    const gerente = r.profissionais.find((p: { user_id: string }) => p.user_id === GOV_MANAGER);
    expect(gerente).toEqual({ user_id: GOV_MANAGER, hoje: 2, semana: 3, realizadas: 1, faltas: 1, canceladas: 1, minutos: 150 });
    const atendente = r.profissionais.find((p: { user_id: string }) => p.user_id === GOV_AGENT_A);
    expect(atendente).toMatchObject({ hoje: 0, semana: 1, minutos: 60 });
    expect(r.profissionais).toHaveLength(2);
  });

  it("conversas esperando resposta agora: sem grupo, oculta, encerrada nem respondida", () => {
    const r = resumo(ORG);
    expect(r.esperando).toMatchObject({ total: 2, sem_responsavel: 1 });
    expect(r.esperando.desde).toMatch(/^2026-03-04T10:00:00/);
  });

  it("leads novos e ganhos no mês, com o mês anterior", () => {
    expect(resumo(ORG).leads).toEqual({ novos_mes: 3, novos_anterior: 1, ganhos_mes: 2, ganhos_anterior: 1 });
  });

  it("quem não é membro da org recebe zero, nunca os dados dela", () => {
    const r = resumo(VIZINHA);
    expect(r.profissionais).toEqual([]);
    expect(r.esperando).toMatchObject({ total: 0, sem_responsavel: 0, desde: null });
    expect(r.leads).toEqual({ novos_mes: 0, novos_anterior: 0, ganhos_mes: 0, ganhos_anterior: 0 });
  });

  it("anon não executa", () => {
    const out = sql(`
      set role anon;
      select has_function_privilege('anon', 'public.fn_inicio_resumo_da_clinica(uuid, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz)', 'execute');
    `);
    expect(lastLine(out)).toBe("f");
  });
});
