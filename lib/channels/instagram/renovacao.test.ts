/**
 * Renovação do token de 60 dias do Instagram — e o aviso quando ela falha.
 *
 * Comportamentos que a suíte prova além de `precisaRenovar`:
 * - renovou → grava o token novo cifrado e a validade nova, filtrado por
 *   `organization_id` (nunca `id` sozinho — vazaria entre tenants).
 * - falhou → abre o aviso reusando `sincronizarSaudeDaConexao`
 *   (`lib/channels/health.ts`) — a MESMA função que o vigia de saúde usa —,
 *   e NUNCA lança.
 * - não repete o aviso enquanto o episódio segue aberto.
 * - uma renovação bem-sucedida DEPOIS de uma falha RESOLVE o aviso aberto.
 * - nenhuma sessão vencendo → nenhuma auditoria (rodada vazia não é mutação).
 *
 * O fake de `channel_session_health` é STATEFUL de propósito (o `upsert`
 * escreve de volta no que o `select` seguinte lê): é o único jeito de provar
 * "abre na falha, fecha no sucesso seguinte" sem mockar a própria função que
 * este arquivo existe para provar que foi REUSADA, não recriada.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: vi.fn(async () => "\\xNOVO"),
  decryptWebhookSecret: vi.fn(async () => "token-velho-em-claro"),
}));

import { precisaRenovar, renovarTokensDoInstagram } from "./renovacao";

const DIA = 86_400_000;

describe("precisaRenovar", () => {
  it("renova com menos de 15 dias; não renova com mais", () => {
    const agora = new Date(0);
    expect(precisaRenovar(new Date(14 * DIA), agora)).toBe(true);
    expect(precisaRenovar(new Date(16 * DIA), agora)).toBe(false);
  });
});

const AGORA = new Date("2026-09-25T04:17:00.000Z");

function sessao(sobrescreve: Record<string, unknown> = {}) {
  return {
    id: "sess-1",
    organization_id: "org-1",
    ig_username: "clinica.eva",
    ig_token_encrypted: "\\xVELHO",
    ...sobrescreve,
  };
}

/** Estado mutável observado pelo admin fake, para asserção depois da rodada. */
let linhas: Record<string, unknown>[];
let atualizacoesDeSessao: Array<{ id: string; campos: Record<string, unknown> }>;
let avisosInseridos: Record<string, unknown>[];
let avisosResolvidos: Array<{ organization_id: string; ref_id: string }>;
let saudeUpserts: Record<string, unknown>[];
/** A linha "gravada" de `channel_session_health` — o `upsert` escreve aqui, o `select` lê daqui. */
let saudeGravada: { escalated_status: string | null } | null;

function admin() {
  return {
    from: (tabela: string) => {
      if (tabela === "channel_sessions") {
        const q = {
          select: () => q,
          eq: () => q,
          is: () => q,
          not: () => q,
          lte: () => q,
          limit: async () => ({ data: linhas, error: null }),
          then: (r: (v: unknown) => void) => r({ data: linhas, error: null }),
          update: (campos: Record<string, unknown>) => ({
            eq: (_c1: string, id: string) => ({
              eq: async () => {
                atualizacoesDeSessao.push({ id, campos });
                return { error: null };
              },
            }),
          }),
        };
        return q;
      }
      if (tabela === "channel_session_health") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: saudeGravada, error: null }),
              }),
            }),
          }),
          upsert: async (linha: Record<string, unknown>) => {
            saudeUpserts.push(linha);
            saudeGravada = { escalated_status: (linha.escalated_status as string | null) ?? null };
            return { error: null };
          },
        };
      }
      if (tabela === "agent_inbox_items") {
        return {
          insert: async (linha: Record<string, unknown>) => {
            avisosInseridos.push(linha);
            return { error: null };
          },
          update: (_campos: Record<string, unknown>) => ({
            eq: (_c1: string, organizationId: string) => ({
              eq: () => ({
                eq: (_c3: string, refId: string) => ({
                  eq: async () => {
                    avisosResolvidos.push({ organization_id: organizationId, ref_id: refId });
                    return { error: null };
                  },
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`tabela inesperada no fake: ${tabela}`);
    },
  } as never;
}

const fetchMock = vi.fn();

function respostaOk(expiresInDias = 60) {
  return { ok: true, json: async () => ({ access_token: "token-novo", expires_in: expiresInDias * 86_400 }) };
}
const respostaFalha = { ok: false, status: 400, json: async () => ({}) };

beforeEach(() => {
  linhas = [];
  atualizacoesDeSessao = [];
  avisosInseridos = [];
  avisosResolvidos = [];
  saudeUpserts = [];
  saudeGravada = null;
  vi.mocked(audit).mockClear();
  vi.mocked(encryptWebhookSecret).mockClear();
  vi.mocked(decryptWebhookSecret).mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renovarTokensDoInstagram", () => {
  it("renova, grava o token cifrado e a validade novos filtrados pela organização, e audita", async () => {
    linhas = [sessao()];
    fetchMock.mockResolvedValue(respostaOk());

    const resumo = await renovarTokensDoInstagram(admin(), AGORA);

    expect(resumo.renovadas).toBe(1);
    expect(atualizacoesDeSessao).toHaveLength(1);
    expect(atualizacoesDeSessao[0]!.id).toBe("sess-1");
    expect(atualizacoesDeSessao[0]!.campos.ig_token_encrypted).toBe("\\xNOVO");
    expect(typeof atualizacoesDeSessao[0]!.campos.ig_token_expires_at).toBe("string");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel.instagram_token_refreshed" }),
    );
  });

  it("falha na renovação: abre o aviso via sincronizarSaudeDaConexao (o helper do vigia de saúde), e não lança", async () => {
    linhas = [sessao()];
    fetchMock.mockResolvedValue(respostaFalha);

    const resumo = await renovarTokensDoInstagram(admin(), AGORA);

    expect(resumo.falhas).toBe(1);
    expect(avisosInseridos).toHaveLength(1);
    expect(avisosInseridos[0]).toMatchObject({
      organization_id: "org-1",
      kind: "channel_number_alert",
      severity: "critical",
      ref_kind: "channel_session",
      ref_id: "sess-1",
    });
    expect(String(avisosInseridos[0]!.title)).toBe("Instagram @clinica.eva precisa ser reconectado");
    expect(saudeUpserts).toHaveLength(1);
  });

  it("não repete o aviso: episódio já escalado não insere de novo", async () => {
    linhas = [sessao()];
    saudeGravada = { escalated_status: "TOKEN_DE_RENOVACAO_VENCIDO" };
    fetchMock.mockResolvedValue(respostaFalha);

    await renovarTokensDoInstagram(admin(), AGORA);

    expect(avisosInseridos).toHaveLength(0);
  });

  it("uma renovação bem-sucedida depois de uma falha RESOLVE o aviso aberto", async () => {
    const alvo = admin();

    // 1ª rodada: falha, abre o aviso.
    linhas = [sessao()];
    fetchMock.mockResolvedValue(respostaFalha);
    await renovarTokensDoInstagram(alvo, AGORA);
    expect(avisosInseridos).toHaveLength(1);
    expect(saudeGravada?.escalated_status).toBe("TOKEN_DE_RENOVACAO_VENCIDO");

    // 2ª rodada: mesma sessão, agora renova com sucesso.
    linhas = [sessao()];
    fetchMock.mockResolvedValue(respostaOk());
    const resumo = await renovarTokensDoInstagram(alvo, AGORA);

    expect(resumo.renovadas).toBe(1);
    expect(avisosResolvidos).toHaveLength(1);
    expect(avisosResolvidos[0]).toMatchObject({ organization_id: "org-1", ref_id: "sess-1" });
    expect(saudeGravada?.escalated_status).toBeNull();
  });

  it("nenhuma sessão vencendo: nenhuma auditoria (rodada vazia não é mutação)", async () => {
    linhas = [];

    const resumo = await renovarTokensDoInstagram(admin(), AGORA);

    expect(resumo.renovadas).toBe(0);
    expect(resumo.falhas).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });
});
