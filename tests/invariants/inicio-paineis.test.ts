import { beforeAll, describe, expect, it } from "vitest";

import { GOV_MANAGER, GOV_ORG, GOV_SESSION, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * Painéis do Início (migration 0330, spec 2026-10-07-inicio-paineis).
 *
 * As quatro funções são SECURITY INVOKER: a RLS de cada tabela continua valendo.
 * Aqui se prova (1) que cada número sai certo — valores distintos na fixture, para
 * troca de coluna reprovar —, (2) a virada de dia no fuso da org e (3) que um membro
 * da GOV_ORG pedindo a org vizinha recebe ZERO, nunca os dados dela.
 */

const VIZINHA = "beb00000-0000-4000-8000-000000000001";
const SESSION_VIZ = "beb00000-0000-4000-8000-0000000000ff";
const C = (n: number) => `beb01111-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const CONV = (n: number) => `beb02222-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const UNIDADE = "beb03333-0000-4000-8000-000000000001";
const FUNIL = "beb04444-0000-4000-8000-000000000001";
const ETAPA_1 = "beb04444-0000-4000-8000-000000000011";
const ETAPA_2 = "beb04444-0000-4000-8000-000000000012";
const ETAPA_GANHO = "beb04444-0000-4000-8000-000000000013";
const FUSO = "America/Sao_Paulo";

/** Março/2026 no fuso de São Paulo (UTC-3): [01/03 00:00, 01/04 00:00). */
const DE = "2026-03-01T03:00:00Z";
const ATE = "2026-04-01T03:00:00Z";
const ANT = "2026-02-01T03:00:00Z";

function como(script: string): string {
  return lastLine(
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${GOV_MANAGER}"}', false);
      ${script}
    `),
  );
}
const linhas = (consulta: string) => JSON.parse(como(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (${consulta}) t;`));

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${VIZINHA}', 'inicio-vizinha', 'Vizinha Início', 'Vizinha');
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESSION_VIZ}', '${VIZINHA}', 'inicio-viz', '\\x00'::bytea);

    -- Contatos criados em março: origem meta_ads, whatsapp, webhook/site; um anonimizado não conta.
    insert into public.contacts (id, organization_id, display_name, source, source_metadata, created_at) values
      ('${C(1)}', '${GOV_ORG}', 'Pac IA',      'meta_ads', '{}'::jsonb,                    '2026-03-10T13:00:00Z'),
      ('${C(2)}', '${GOV_ORG}', 'Pac Equipe',  'whatsapp', '{}'::jsonb,                    '2026-03-10T13:00:00Z'),
      ('${C(3)}', '${GOV_ORG}', 'Pac Mudo',    'webhook',  '{"utm_source":"site"}'::jsonb, '2026-03-10T13:00:00Z'),
      ('${C(4)}', '${GOV_ORG}', 'Pac Noite',   'whatsapp', '{}'::jsonb,                    '2026-02-15T13:00:00Z'),
      ('${C(5)}', '${GOV_ORG}', 'Pac Lembrete', 'manual',  '{}'::jsonb,                    '2026-02-15T13:00:00Z'),
      ('${C(9)}', '${VIZINHA}', 'Pac Vizinho', 'meta_ads', '{}'::jsonb,                    '2026-03-10T13:00:00Z');

    -- Conversas: 10/03 (IA sozinha, com a equipe, sem resposta) e 31/03 22h local = 01/04 01h UTC.
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, created_at) values
      ('${CONV(1)}', '${GOV_ORG}', '${C(1)}', '${GOV_SESSION}', 'open', '2026-03-10T13:00:00Z'),
      ('${CONV(2)}', '${GOV_ORG}', '${C(2)}', '${GOV_SESSION}', 'open', '2026-03-10T14:00:00Z'),
      ('${CONV(3)}', '${GOV_ORG}', '${C(3)}', '${GOV_SESSION}', 'open', '2026-03-10T15:00:00Z'),
      ('${CONV(4)}', '${GOV_ORG}', '${C(4)}', '${GOV_SESSION}', 'open', '2026-04-01T01:00:00Z'),
      ('${CONV(5)}', '${GOV_ORG}', '${C(5)}', '${GOV_SESSION}', 'open', '2026-03-10T16:00:00Z'),
      ('${CONV(9)}', '${VIZINHA}', '${C(9)}', '${SESSION_VIZ}', 'open', '2026-03-10T13:00:00Z');
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_by_user_id, sent_at, metadata)
    values
      ('${GOV_ORG}', '${CONV(1)}', '${GOV_SESSION}', '${C(1)}', 'text', 'inbound',  'received', 'ai',  null, '2026-03-10T13:00:00Z', '{}'::jsonb),
      -- Fala da IA: marcada por ai_actor_id (a mesma régua de ehFalaDaIa em lib/ai/handoff/aviso-ao-lead.ts).
      ('${GOV_ORG}', '${CONV(1)}', '${GOV_SESSION}', '${C(1)}', 'text', 'outbound', 'sent',     'ai',  null, '2026-03-10T13:01:00Z', '{"ai_actor_id":"agente-1"}'::jsonb),
      ('${GOV_ORG}', '${CONV(2)}', '${GOV_SESSION}', '${C(2)}', 'text', 'inbound',  'received', 'ai',  null, '2026-03-10T14:00:00Z', '{}'::jsonb),
      ('${GOV_ORG}', '${CONV(2)}', '${GOV_SESSION}', '${C(2)}', 'text', 'outbound', 'sent',     'crm', '${GOV_MANAGER}', '2026-03-10T14:03:00Z', '{}'::jsonb),
      ('${GOV_ORG}', '${CONV(3)}', '${GOV_SESSION}', '${C(3)}', 'text', 'inbound',  'received', 'ai',  null, '2026-03-10T15:00:00Z', '{}'::jsonb),
      -- Saída que FALHOU não é resposta.
      ('${GOV_ORG}', '${CONV(3)}', '${GOV_SESSION}', '${C(3)}', 'text', 'outbound', 'failed',   'crm', '${GOV_MANAGER}', '2026-03-10T15:05:00Z', '{}'::jsonb),
      -- Lembrete da Agenda: sent_via='ai' SEM marca de autoria da IA — não é a IA atendendo.
      ('${GOV_ORG}', '${CONV(5)}', '${GOV_SESSION}', '${C(5)}', 'text', 'outbound', 'sent',     'ai',  null, '2026-03-10T16:00:00Z', '{}'::jsonb);

    -- Agenda: Vitória com 2 realizadas e 1 falta; 1 confirmada sem unidade; 1 cancelada.
    insert into public.calendar_units (id, organization_id, name) values ('${UNIDADE}', '${GOV_ORG}', 'Vitória');
    insert into public.calendar_appointments (organization_id, title, starts_at, ends_at, owner_user_id, status, unit_id) values
      ('${GOV_ORG}', 'a1', '2026-03-02T12:00:00Z', '2026-03-02T13:00:00Z', '${GOV_MANAGER}', 'completed', '${UNIDADE}'),
      ('${GOV_ORG}', 'a2', '2026-03-03T12:00:00Z', '2026-03-03T13:00:00Z', '${GOV_MANAGER}', 'completed', '${UNIDADE}'),
      ('${GOV_ORG}', 'a3', '2026-03-04T12:00:00Z', '2026-03-04T13:00:00Z', '${GOV_MANAGER}', 'no_show',   '${UNIDADE}'),
      ('${GOV_ORG}', 'a4', '2026-03-05T12:00:00Z', '2026-03-05T13:00:00Z', '${GOV_MANAGER}', 'confirmed', null);
    insert into public.calendar_appointments (organization_id, title, starts_at, ends_at, owner_user_id, status, unit_id, cancelled_at) values
      ('${GOV_ORG}', 'a5', '2026-03-06T12:00:00Z', '2026-03-06T13:00:00Z', '${GOV_MANAGER}', 'cancelled', null, '2026-03-01T12:00:00Z');

    -- Funil: 2 abertos na etapa 1, 1 na etapa 2; ganho de R$ 150,00 em março; perda em fevereiro.
    insert into public.crm_pipelines (id, organization_id, name, slug) values ('${FUNIL}', '${GOV_ORG}', 'Pedidos', 'inicio-pedidos');
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position, is_won) values
      ('${ETAPA_1}', '${GOV_ORG}', '${FUNIL}', 'Avaliação', 'av', 1000, false),
      ('${ETAPA_2}', '${GOV_ORG}', '${FUNIL}', 'Proposta',  'pr', 2000, false),
      ('${ETAPA_GANHO}', '${GOV_ORG}', '${FUNIL}', 'Ganho', 'gn', 3000, true);
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, status, closed_at, value_cents, currency, lost_reason) values
      ('${GOV_ORG}', '${FUNIL}', '${ETAPA_1}', 'l1', 'open', null, null, 'BRL', null),
      ('${GOV_ORG}', '${FUNIL}', '${ETAPA_1}', 'l2', 'open', null, null, 'BRL', null),
      ('${GOV_ORG}', '${FUNIL}', '${ETAPA_2}', 'l3', 'open', null, null, 'BRL', null),
      ('${GOV_ORG}', '${FUNIL}', '${ETAPA_GANHO}', 'l4', 'won', '2026-03-20T12:00:00Z', 15000, 'BRL', null),
      ('${GOV_ORG}', '${FUNIL}', '${ETAPA_2}', 'l5', 'lost', '2026-02-20T12:00:00Z', null, 'BRL', 'price');
  `);
});

describe("fn_inicio_conversas_por_dia", () => {
  const conversas = (org: string) =>
    linhas(`select * from public.fn_inicio_conversas_por_dia('${org}', '${DE}', '${ATE}', '${FUSO}')`);

  it("separa IA sozinha, com a equipe e sem resposta; lembrete e envio que falhou não contam", () => {
    const dia10 = conversas(GOV_ORG).find((l: { dia: string }) => l.dia === "2026-03-10");
    expect(dia10).toMatchObject({ ia_sozinha: 1, com_equipe: 1, sem_resposta: 2, respondidas: 2 });
    // primeira resposta: 60 s (IA) + 180 s (equipe)
    expect(dia10.soma_primeira_resposta_s).toBe(240);
  });

  it("a conversa das 22h do dia 31 conta no dia 31 do fuso, não no dia 1", () => {
    const dias = conversas(GOV_ORG).map((l: { dia: string }) => l.dia);
    expect(dias).toContain("2026-03-31");
    expect(dias).not.toContain("2026-04-01");
  });

  it("a org vizinha não vaza", () => {
    expect(conversas(VIZINHA)).toEqual([]);
  });
});

describe("fn_inicio_agenda", () => {
  it("conta por unidade e põe o resto em 'sem unidade'", () => {
    const r = linhas(`select * from public.fn_inicio_agenda('${GOV_ORG}', '${DE}', '${ATE}')`);
    expect(r.find((l: { unidade: string }) => l.unidade === "Vitória")).toMatchObject({
      marcadas: 3, realizadas: 2, faltas: 1, canceladas: 0,
    });
    expect(r.find((l: { unit_id: string | null }) => l.unit_id === null)).toMatchObject({
      marcadas: 1, confirmadas: 1, canceladas: 1,
    });
  });
  it("a org vizinha não vaza", () => {
    expect(linhas(`select * from public.fn_inicio_agenda('${VIZINHA}', '${DE}', '${ATE}')`)).toEqual([]);
  });
});

describe("fn_inicio_funil", () => {
  const funil = (org: string) =>
    JSON.parse(como(`select public.fn_inicio_funil('${org}', '${FUNIL}', '${DE}', '${ATE}', '${ANT}');`));

  it("abertos por etapa, na ordem, sem a etapa de ganho", () => {
    expect(funil(GOV_ORG).etapas).toEqual([
      { id: ETAPA_1, nome: "Avaliação", abertos: 2 },
      { id: ETAPA_2, nome: "Proposta", abertos: 1 },
    ]);
  });
  it("ganhos, perdidos e valor do mês e do mês anterior", () => {
    const f = funil(GOV_ORG);
    expect(f.mes).toEqual({ ganhos: 1, perdidos: 0, valor: { BRL: "15000" } });
    expect(f.anterior).toEqual({ ganhos: 0, perdidos: 1, valor: {} });
  });
  it("a org vizinha não vaza", () => {
    const f = funil(VIZINHA);
    expect(f.etapas).toEqual([]);
    expect(f.mes).toEqual({ ganhos: 0, perdidos: 0, valor: {} });
  });
});

describe("fn_inicio_origem", () => {
  it("novos contatos do mês por origem, com o utm quando houver", () => {
    const r = linhas(`select * from public.fn_inicio_origem('${GOV_ORG}', '${DE}', '${ATE}')`);
    expect(r).toEqual(
      expect.arrayContaining([
        { origem: "meta_ads", utm_source: null, total: 1 },
        { origem: "whatsapp", utm_source: null, total: 1 },
        { origem: "webhook", utm_source: "site", total: 1 },
      ]),
    );
    expect(r).toHaveLength(3);
  });
  it("a org vizinha não vaza", () => {
    expect(linhas(`select * from public.fn_inicio_origem('${VIZINHA}', '${DE}', '${ATE}')`)).toEqual([]);
  });
});
