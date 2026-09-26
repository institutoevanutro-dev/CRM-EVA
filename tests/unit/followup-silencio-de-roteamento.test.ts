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

describe("isLeadInHandoff", () => {
  /** Uma conversa silenciada, no provider dado. Modela o `not exists ... any($3)`. */
  function pool(provider: string) {
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      const excluidos = sql.includes("any($3::text[])") ? (params[2] as string[]) : [];
      return { rows: [{ handoff: !excluidos.includes(provider) }] };
    });
    return { pool: { query } as never, query };
  }

  it("follow-up no Instagram silenciado: não é handoff", async () => {
    expect(await isLeadInHandoff(pool(CHANNEL_PROVIDER_INSTAGRAM).pool, "org", "lead", { followup: true })).toBe(false);
  });

  it("follow-up no WhatsApp silenciado: continua handoff", async () => {
    expect(await isLeadInHandoff(pool(DEFAULT_CHANNEL_PROVIDER).pool, "org", "lead", { followup: true })).toBe(true);
  });

  it("sem a opção (atendimento): a consulta é a de sempre, byte a byte", async () => {
    const p = pool(CHANNEL_PROVIDER_INSTAGRAM);
    expect(await isLeadInHandoff(p.pool, "org", "lead")).toBe(true);
    const [sql, params] = p.query.mock.calls[0]!;
    expect(sql).not.toContain("channel_sessions");
    expect(params).toEqual(["org", "lead"]);
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

  it("atendimento (sem follow-up) no Instagram silenciado: continua barrado", async () => {
    expect((await decidirElegibilidadeDaConversa(pool(CHANNEL_PROVIDER_INSTAGRAM), base))?.permite).toBe(false);
  });

  it("follow-up no Instagram com force_human: continua barrado (os outros sinais valem)", async () => {
    expect((await decidirElegibilidadeDaConversa(pool(CHANNEL_PROVIDER_INSTAGRAM, { force_human: true }), { ...base, followup: true }))?.permite).toBe(false);
  });
});
