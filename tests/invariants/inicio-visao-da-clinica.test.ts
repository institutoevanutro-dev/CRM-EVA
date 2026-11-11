import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_MANAGER, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * Visão da clínica do Início (migration 0376, com o corpo da 0408):
 * `fn_inicio_resumo_da_clinica`.
 *
 * SECURITY INVOKER: prova (1) os números — valores distintos por coluna, para
 * troca de coluna reprovar —, (2) que compromisso excluído não conta, (3) que
 * as vendas somam TODOS os funis e comparam com os MESMOS DIAS do mês anterior
 * e (4) que quem pede a org de que não é membro recebe ZERO, nunca os dados
 * dela. "Esperando resposta" tem arquivo próprio: inicio-esperando.test.ts.
 */
const ORG = "bec00000-0000-4000-8000-000000000001";
const VIZINHA = "bec00000-0000-4000-8000-000000000002";
const FUNIL = "bec04444-0000-4000-8000-000000000001";
const ETAPA = "bec04444-0000-4000-8000-000000000011";
const FUNIL_2 = "bec04444-0000-4000-8000-000000000002";
const ETAPA_2 = "bec04444-0000-4000-8000-000000000012";

// Semana de 02/03 a 08/03/2026 em São Paulo; "hoje" = 04/03; mês = março.
const HOJE_DE = "2026-03-04T03:00:00Z";
const HOJE_ATE = "2026-03-05T03:00:00Z";
const SEM_DE = "2026-03-02T03:00:00Z";
const SEM_ATE = "2026-03-09T03:00:00Z";
const MES_DE = "2026-03-01T03:00:00Z";
const MES_ATE = "2026-04-01T03:00:00Z";
const ANT_DE = "2026-02-01T03:00:00Z";
// Os mesmos dias do mês anterior: "agora" é 04/03 ao meio-dia, então até 04/02 ao meio-dia.
const ANT_ATE = "2026-02-04T15:00:00Z";
const ASSINATURA = `public.fn_inicio_resumo_da_clinica(${["uuid", ...Array.from({ length: 8 }, () => "timestamptz")].join(", ")})`;

function resumo(org: string, quem = GOV_MANAGER) {
  return JSON.parse(
    lastLine(
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${quem}"}', false);
        select public.fn_inicio_resumo_da_clinica('${org}', '${HOJE_DE}', '${HOJE_ATE}', '${SEM_DE}', '${SEM_ATE}', '${MES_DE}', '${MES_ATE}', '${ANT_DE}', '${ANT_ATE}');
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

    -- Vendas, em DOIS funis: 4 novos em março; em fevereiro, 1 até o dia 4 (os
    -- mesmos dias) e 1 depois (fora da comparação). Fechados em março: 3 ganhos
    -- (R$ 100,00 + R$ 50,00 no funil 1, US$ 70,00 no funil 2) e 1 perdido.
    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${FUNIL}', '${ORG}', 'Pacientes', 'visao-pac'),
      ('${FUNIL_2}', '${ORG}', 'Estética', 'visao-est');
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${ETAPA}', '${ORG}', '${FUNIL}', 'Avaliação', 'av', 1000),
      ('${ETAPA_2}', '${ORG}', '${FUNIL_2}', 'Orçamento', 'or', 1000);
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, status, closed_at, created_at, value_cents, currency, lost_reason) values
      ('${ORG}', '${FUNIL}',   '${ETAPA}',   'n1', 'open', null,                   '2026-03-02T12:00:00Z', null,  'BRL', null),
      ('${ORG}', '${FUNIL}',   '${ETAPA}',   'n2', 'won',  '2026-03-03T12:00:00Z', '2026-03-02T12:00:00Z', 10000, 'BRL', null),
      ('${ORG}', '${FUNIL}',   '${ETAPA}',   'n3', 'won',  '2026-03-20T12:00:00Z', '2026-03-10T12:00:00Z', 5000,  'BRL', null),
      ('${ORG}', '${FUNIL_2}', '${ETAPA_2}', 'n4', 'won',  '2026-03-21T12:00:00Z', '2026-03-11T12:00:00Z', 7000,  'USD', null),
      ('${ORG}', '${FUNIL_2}', '${ETAPA_2}', 'p1', 'lost', '2026-03-05T12:00:00Z', '2026-02-02T12:00:00Z', null,  'BRL', 'price'),
      ('${ORG}', '${FUNIL}',   '${ETAPA}',   'f1', 'won',  '2026-02-20T12:00:00Z', '2026-02-10T12:00:00Z', 9000,  'BRL', null);
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

  it("pacientes novos: o mês contra os MESMOS DIAS do mês anterior, nunca o mês anterior inteiro", () => {
    // Fevereiro inteiro teria 2 (dias 2 e 10); até o dia 4, só 1.
    expect(resumo(ORG).vendas).toMatchObject({ novos_mes: 4, novos_anterior: 1 });
  });

  it("vendas fechadas, desistências e valor por moeda somam TODOS os funis — e só o mês", () => {
    expect(resumo(ORG).vendas).toMatchObject({
      ganhos_mes: 3,
      perdidos_mes: 1,
      // O ganho de fevereiro (R$ 90,00) não entra.
      valor: { BRL: "15000", USD: "7000" },
    });
  });

  it("quem não é membro da org recebe zero, nunca os dados dela", () => {
    const r = resumo(VIZINHA);
    expect(r.profissionais).toEqual([]);
    expect(r.vendas).toEqual({ novos_mes: 0, novos_anterior: 0, ganhos_mes: 0, perdidos_mes: 0, valor: {} });
  });

  it("\"esperando\" saiu daqui: a regra mora só em fn_inicio_esperando", () => {
    expect(Object.keys(resumo(ORG)).sort()).toEqual(["profissionais", "vendas"]);
  });

  it("anon não executa, e a assinatura antiga (oito argumentos) saiu", () => {
    expect(lastLine(sql(`select has_function_privilege('anon', '${ASSINATURA}', 'execute');`))).toBe("f");
    expect(lastLine(sql(`select count(*) from pg_proc where proname = 'fn_inicio_resumo_da_clinica';`))).toBe("1");
  });
});
