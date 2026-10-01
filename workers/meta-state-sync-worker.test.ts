import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";

const aplicar = vi.fn(async (..._a: unknown[]) => ({ processados: 1 }));
vi.mock("@/lib/channels/meta/contatos-do-celular", () => ({ upsertContatosDoCelular: (...a: unknown[]) => aplicar(...a) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { processarStateSync } from "./meta-state-sync-worker";

const ORG = "org-1";
const SESSAO = "sess-1";
const AGORA = Date.parse("2026-10-02T12:00:00Z");
const CONTATOS = [{ waId: "5531998966398", nome: "Maria Silva" }];

function linha(idadeMs: number): EventRow {
  return {
    id: "ev1", organization_id: ORG, event_type: "meta.state_sync", entity_kind: "channel_session", entity_id: SESSAO,
    consumed_by: [], attempts: 0, metadata: {}, created_at: new Date(AGORA - idadeMs).toISOString(),
    payload: { phone_number_id: "111", contatos: CONTATOS },
  } as EventRow;
}

let historico: Record<string, unknown> | null;
let metadataDaSessao: Record<string, unknown> | null;
let pedidoHistorico: Record<string, unknown> | null;
let onboardingEm: string;
let updates: Array<{ tabela: string; patch: Record<string, unknown>; filtros: Record<string, unknown> }>;

function adminFalso(): SupabaseClient {
  const from = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    let patch: Record<string, unknown> | null = null;
    const alvo: Record<string, unknown> = {
      select: () => alvo,
      eq: (c: string, v: unknown) => ((filtros[c] = v), alvo),
      update: (p: Record<string, unknown>) => ((patch = p), alvo),
      maybeSingle: async () => ({
        data: {
          metadata: metadataDaSessao ?? { coexistencia: { onboarding_em: onboardingEm, pedidos: { historico: pedidoHistorico }, historico } },
          archived_at: null,
        },
        error: null,
      }),
      then: (ok: (v: unknown) => unknown) => {
        if (patch) updates.push({ tabela, patch, filtros: { ...filtros } });
        return Promise.resolve({ data: null, error: null }).then(ok);
      },
    };
    return alvo;
  };
  return { from } as unknown as SupabaseClient;
}

beforeEach(() => {
  aplicar.mockClear();
  updates = [];
  historico = null;
  metadataDaSessao = null;
  pedidoHistorico = { request_id: "req-1" };
  onboardingEm = "2026-10-01T00:00:00Z";
  vi.useFakeTimers();
  vi.setSystemTime(AGORA);
});

const HORA = 3_600_000;

describe("processarStateSync", () => {
  it("histórico em 20%: pede retry com retry_at no futuro e não aplica nem limpa", async () => {
    historico = { fase: 0, progresso: 20, concluido: false, erro_codigo: null };
    const r = await processarStateSync(linha(HORA), adminFalso());
    expect(r.status).toBe("retry");
    expect(Date.parse(r.retry_at!)).toBeGreaterThan(AGORA);
    expect(aplicar).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("histórico em 100%: aplica uma vez e limpa o payload (org + id)", async () => {
    historico = { fase: 2, progresso: 100, concluido: true, erro_codigo: null };
    const r = await processarStateSync(linha(HORA), adminFalso());
    expect(r.status).toBe("ok");
    expect(aplicar).toHaveBeenCalledWith(expect.anything(), ORG, CONTATOS);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ tabela: "event_log", filtros: { organization_id: ORG, id: "ev1" } });
    expect(updates[0]!.patch.payload).toMatchObject({ contatos: null });
  });

  it("histórico com erro também fecha", async () => {
    historico = { fase: null, progresso: null, concluido: false, erro_codigo: 2593109 };
    expect((await processarStateSync(linha(HORA), adminFalso())).status).toBe("ok");
    expect(aplicar).toHaveBeenCalledTimes(1);
  });

  it("passadas 48 h aplica e limpa mesmo com o histórico parado", async () => {
    historico = { fase: 0, progresso: 20, concluido: false, erro_codigo: null };
    const r = await processarStateSync(linha(49 * HORA), adminFalso());
    expect(r.status).toBe("ok");
    expect(aplicar).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
  });

  it("sem metadata de coexistência: não há histórico por vir, aplica já", async () => {
    metadataDaSessao = {};
    expect((await processarStateSync(linha(HORA), adminFalso())).status).toBe("ok");
    expect(aplicar).toHaveBeenCalledTimes(1);
  });

  it("pedido de histórico sem request_id fora da janela de 24 h: aplica já", async () => {
    pedidoHistorico = null; // onboarding 36 h antes de AGORA
    expect((await processarStateSync(linha(HORA), adminFalso())).status).toBe("ok");
    expect(aplicar).toHaveBeenCalledTimes(1);
  });

  it("pedido sem request_id DENTRO da janela: continua esperando (admin ainda pode repetir)", async () => {
    pedidoHistorico = null;
    onboardingEm = "2026-10-02T06:00:00Z";
    expect((await processarStateSync(linha(HORA), adminFalso())).status).toBe("retry");
    expect(aplicar).not.toHaveBeenCalled();
  });
});
