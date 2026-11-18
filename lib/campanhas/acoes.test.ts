/**
 * Ações da campanha — auditoria de 17/11/2026, lote 2.
 *
 *  - item 15: "Voltar para rascunho" existe, descarta a lista montada e só vale
 *    antes de qualquer envio;
 *  - item 17: duplicar copia funil, etapa, agente e os números do rodízio;
 *  - item 24: preparar com sucesso apaga o aviso da tentativa anterior.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { supabaseEmMemoria, type Linha } from "@/tests/helpers/supabase-em-memoria";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn() }));
vi.mock("@/lib/atendimento/origem", () => ({ beginServiceAtOrigin: vi.fn() }));
vi.mock("./preparacao", () => ({
  prepararCampanha: vi.fn(async () => ({ total: 3, elegiveis: 2, excluidos: 1, motivos: {} })),
}));

const { duplicarAcao, prepararAcao, voltarParaRascunhoAcao } = await import("./acoes");
type Campanha = Parameters<typeof duplicarAcao>[1];

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const ID = "cccccccc-0000-4000-8000-000000000001";
const PRINCIPAL = "dddddddd-0000-4000-8000-000000000001";
const EXTRA = "dddddddd-0000-4000-8000-000000000002";

function campanha(extra: Partial<Campanha> = {}): Campanha {
  return {
    id: ID,
    organization_id: ORG,
    name: "Retorno de pacientes (fictícia)",
    status: "ready",
    channel_session_id: PRINCIPAL,
    message_body: "Oi, {{primeiro_nome}}!",
    base_legal: "consent",
    lia_ref: null,
    audience_filter: { funis: ["f"] },
    audience_version: 1,
    content_version: 1,
    scheduled_at: null,
    intervalo_segundos: 60,
    janela_inicio_hora: 9,
    janela_fim_hora: 18,
    teto_diario: 50,
    teto_horario: null,
    description: null,
    pipeline_id: "11111111-1111-4111-8111-111111111111",
    stage_id: "22222222-2222-4222-8222-222222222222",
    agent_id: "33333333-3333-4333-8333-333333333333",
    ...extra,
  };
}

function destinatario(extra: Linha = {}): Linha {
  return { organization_id: ORG, campaign_id: ID, status: "pending", sent_at: null, ...extra };
}

let banco: ReturnType<typeof supabaseEmMemoria>;

beforeEach(() => {
  banco = supabaseEmMemoria({
    campaigns: [{ ...campanha(), snapshot_total: 3, snapshot_eligible: 2, snapshot_excluded: 1 }],
    campaign_recipients: [destinatario(), destinatario(), destinatario({ status: "skipped" })],
    campaign_channel_sessions: [{ organization_id: ORG, campaign_id: ID, channel_session_id: EXTRA }],
    channel_sessions: [
      { id: PRINCIPAL, organization_id: ORG },
      { id: EXTRA, organization_id: ORG },
    ],
  });
});

const admin = () => banco.cliente as never;

describe("duplicar (item 17)", () => {
  it("a cópia leva funil, etapa, agente e os números do rodízio", async () => {
    const r = await duplicarAcao(admin(), campanha(), "eeeeeeee-0000-4000-8000-000000000001");

    expect(r.ok).toBe(true);
    const copia = banco.tabelas.campaigns!.find((c) => c.id !== ID)!;
    expect(copia).toMatchObject({
      name: "Retorno de pacientes (fictícia) (cópia)",
      pipeline_id: "11111111-1111-4111-8111-111111111111",
      stage_id: "22222222-2222-4222-8222-222222222222",
      agent_id: "33333333-3333-4333-8333-333333333333",
      intervalo_segundos: 60,
      audience_filter: { funis: ["f"] },
    });
    const pool = banco.tabelas.campaign_channel_sessions!.filter((l) => l.campaign_id === copia.id);
    expect(pool.map((l) => l.channel_session_id)).toEqual([EXTRA]);
  });
});

describe("voltar para rascunho (item 15)", () => {
  it("de pronta: volta a rascunho, zera o snapshot e descarta a lista", async () => {
    const r = await voltarParaRascunhoAcao(admin(), campanha());

    expect(r).toEqual({ ok: true, descartados: 3 });
    expect(banco.tabelas.campaigns![0]).toMatchObject({
      status: "draft",
      snapshot_total: 0,
      snapshot_eligible: 0,
      snapshot_excluded: 0,
      prepared_at: null,
    });
    expect(banco.tabelas.campaign_recipients).toHaveLength(0);
  });

  it("depois de qualquer envio, recusa — a lista é histórico", async () => {
    banco.tabelas.campaign_recipients![0]!.sent_at = "2026-11-17T12:00:00.000Z";

    const r = await voltarParaRascunhoAcao(admin(), campanha());

    expect(r.ok).toBe(false);
    expect(banco.tabelas.campaigns![0]!.status).toBe("ready");
    expect(banco.tabelas.campaign_recipients).toHaveLength(3);
  });

  it("enviando não volta: a máquina de estados não deixa", async () => {
    banco.tabelas.campaigns![0]!.status = "running";

    const r = await voltarParaRascunhoAcao(admin(), campanha({ status: "running" }));

    expect(r.ok).toBe(false);
    expect(banco.tabelas.campaign_recipients).toHaveLength(3);
  });
});

describe("preparar (item 24)", () => {
  it("dar certo apaga o aviso da tentativa anterior", async () => {
    banco.tabelas.campaigns![0] = { ...banco.tabelas.campaigns![0]!, status: "draft", failure_code: "sem_elegiveis" };

    const r = await prepararAcao(admin(), campanha({ status: "draft" }), new Date("2026-11-18T12:00:00.000Z"));

    expect(r.ok).toBe(true);
    expect(banco.tabelas.campaigns![0]).toMatchObject({ status: "ready", failure_code: null });
  });
});
