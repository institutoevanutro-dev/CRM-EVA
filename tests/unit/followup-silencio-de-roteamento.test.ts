/**
 * Os gates do NÚCLEO do agente (`executarTurnoDoAgente`), que o follow-up com IA
 * atravessa: o silêncio de canal sem IA (Instagram, `'infinity'` para cair na
 * Fila) é roteamento para o follow-up, e só para ele. Os pools abaixo respondem
 * como o Postgres: o silêncio vale, a menos que a sessão da conversa seja de um
 * provider da lista que o chamador passou.
 */
import { describe, expect, it, vi } from "vitest";

import { isLeadInHandoff } from "@/lib/agent-engine/agent/human-handoff";
import { decidirElegibilidadeDaConversa } from "@/lib/ai/elegibilidade/consulta-pg";
import { CHANNEL_PROVIDER_INSTAGRAM, DEFAULT_CHANNEL_PROVIDER, silencioDoBotEhRoteamento } from "@/lib/channels/capabilities";

describe("silencioDoBotEhRoteamento", () => {
  it("canal sem IA: sim; WhatsApp e desconhecido: não", () => {
    expect(silencioDoBotEhRoteamento(CHANNEL_PROVIDER_INSTAGRAM)).toBe(true);
    expect(silencioDoBotEhRoteamento(DEFAULT_CHANNEL_PROVIDER)).toBe(false);
    expect(silencioDoBotEhRoteamento(null)).toBe(false);
  });
});

describe("isLeadInHandoff — varredura do contato inteiro", () => {
  /**
   * As conversas do contato. Modela a SQL: silêncio no futuro conta, exceto em
   * sessão cujo provider está na lista `$3` — se a consulta a declarar.
   */
  function pool(conversas: Array<{ provider: string; silenciada: boolean }>, forceHuman = false) {
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      const excluidos = sql.includes("any($3::text[])") ? (params[2] as string[]) : [];
      const silencio = conversas.some((c) => c.silenciada && !excluidos.includes(c.provider));
      return { rows: [{ handoff: forceHuman || silencio }] };
    });
    return { pool: { query } as never, query };
  }
  const IG_NA_FILA = { provider: CHANNEL_PROVIDER_INSTAGRAM, silenciada: true };

  it("contato unificado: o silêncio de roteamento do Instagram não cala a IA no WhatsApp", async () => {
    const p = pool([IG_NA_FILA, { provider: DEFAULT_CHANNEL_PROVIDER, silenciada: false }]);
    expect(await isLeadInHandoff(p.pool, "org", "lead")).toBe(false);
  });

  it("contato unificado com silêncio HUMANO no WhatsApp: continua handoff", async () => {
    const p = pool([IG_NA_FILA, { provider: DEFAULT_CHANNEL_PROVIDER, silenciada: true }]);
    expect(await isLeadInHandoff(p.pool, "org", "lead")).toBe(true);
  });

  it("force_human: continua handoff", async () => {
    expect(await isLeadInHandoff(pool([IG_NA_FILA], true).pool, "org", "lead")).toBe(true);
  });

  it("só WhatsApp: igual a antes (silenciada bloqueia, livre não)", async () => {
    expect(await isLeadInHandoff(pool([{ provider: DEFAULT_CHANNEL_PROVIDER, silenciada: true }]).pool, "org", "lead")).toBe(true);
    expect(await isLeadInHandoff(pool([{ provider: DEFAULT_CHANNEL_PROVIDER, silenciada: false }]).pool, "org", "lead")).toBe(false);
  });

  it("a lista excluída é a dos canais sem IA, e não contém o WhatsApp", async () => {
    const p = pool([]);
    await isLeadInHandoff(p.pool, "org", "lead");
    const [, params] = p.query.mock.calls[0]!;
    expect(params).toEqual(["org", "lead", [CHANNEL_PROVIDER_INSTAGRAM]]);
  });
});

describe("decidirElegibilidadeDaConversa (pg)", () => {
  function pool(provider: string, extra: Record<string, unknown> = {}) {
    return {
      query: async () => ({ rows: [{
        channel_metadata: null, force_human: false, assignee_kind: null, bot_silenced_until: "infinity",
        ai_authorized_at: null, phone_number: null, provider, ...extra,
      }] }),
    } as never;
  }
  const base = { organizationId: "org", conversationId: "conv", agora: new Date(), ttlMs: 1000 };

  it("follow-up no Instagram silenciado: permite", async () => {
    expect((await decidirElegibilidadeDaConversa(pool(CHANNEL_PROVIDER_INSTAGRAM), { ...base, followup: true }))?.permite).toBe(true);
  });

  it("follow-up no WhatsApp silenciado: continua barrado", async () => {
    expect((await decidirElegibilidadeDaConversa(pool(DEFAULT_CHANNEL_PROVIDER), { ...base, followup: true }))?.permite).toBe(false);
  });

  it("o turno de atendimento da PRÓPRIA conversa do Instagram continua barrado", async () => {
    expect((await decidirElegibilidadeDaConversa(pool(CHANNEL_PROVIDER_INSTAGRAM), base))?.permite).toBe(false);
  });

  it("follow-up no Instagram com force_human: continua barrado (os outros sinais valem)", async () => {
    expect((await decidirElegibilidadeDaConversa(pool(CHANNEL_PROVIDER_INSTAGRAM, { force_human: true }), { ...base, followup: true }))?.permite).toBe(false);
  });
});
