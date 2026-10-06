import { describe, expect, it, vi } from "vitest";

// ingest.ts importa @/lib/audit (→ supabase/server → validação de env);
// o mock corta a cadeia sem tocar no que está sob teste.
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { dataDoTimestamp, dispatchWahaEvent, type WahaPayload } from "./ingest";

/**
 * O TIMESTAMP DO WEBHOOK NÃO PODE DERRUBAR A INGESTÃO.
 *
 * Porte do DeskcommCRM 85bacc79d (Vander Gustavo Alves). Medido lá em
 * 2026-09-18: um payload com `timestamp` em NANOSSEGUNDOS fazia
 * `new Date(ns * 1000).toISOString()` lançar `RangeError: Invalid time value`,
 * e o webhook inteiro falhava — a mensagem do paciente se perdia. O WAHA manda
 * segundos, mas tolerar as três unidades custa uma função pura.
 *
 * Neste fork a conta crua aparecia em TRÊS pontos de `lib/waha/ingest.ts`
 * (`sent_at` do inbound, o carimbo da conversa do inbound e `sent_at` do que o
 * dono digita no celular). Os casos de `dispatchWahaEvent` abaixo entram pelo
 * caminho de produção e cobrem os três.
 */
const AGORA = "2026-09-18T12:00:00.000Z";
const NS = 1789723200000000000;

describe("dataDoTimestamp — tolera segundos, ms e ns", () => {
  it("segundos (formato do WAHA)", () => {
    expect(dataDoTimestamp(1789723200, AGORA)).toBe("2026-09-18T09:20:00.000Z");
  });

  it("milissegundos", () => {
    expect(dataDoTimestamp(1789723200000, AGORA)).toBe("2026-09-18T09:20:00.000Z");
  });

  it("nanossegundos NÃO lança (era o RangeError)", () => {
    expect(() => dataDoTimestamp(NS, AGORA)).not.toThrow();
    expect(dataDoTimestamp(NS, AGORA)).toBe("2026-09-18T09:20:00.000Z");
  });

  it("ausente/ inválido cai no agora — nunca lança", () => {
    expect(dataDoTimestamp(null, AGORA)).toBe(AGORA);
    expect(dataDoTimestamp(undefined, AGORA)).toBe(AGORA);
    expect(dataDoTimestamp(0, AGORA)).toBe(AGORA);
    expect(dataDoTimestamp(-5, AGORA)).toBe(AGORA);
    expect(dataDoTimestamp(Number.NaN, AGORA)).toBe(AGORA);
  });
});

/** Admin de mentira que grava os INSERTs e as RPCs, e deixa o resto passar. */
function adminQueGrava() {
  const inserts: Array<Record<string, unknown>> = [];
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const consulta = () => {
    const q: Record<string, unknown> = {};
    for (const m of ["eq", "in", "is", "gte", "order", "limit", "neq"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: null, error: null });
    q.then = (ok: (v: unknown) => unknown) => Promise.resolve(ok({ data: [], error: null }));
    return q;
  };
  const tabela = (nome: string) => ({
    select: () => consulta(),
    insert: (linha: Record<string, unknown>) => {
      if (nome === "messages") inserts.push(linha);
      return { select: () => ({ maybeSingle: async () => ({ data: { id: "msg-1" }, error: null }) }) };
    },
    update: () => consulta(),
  });
  const admin = {
    from: (nome: string) => tabela(nome),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
      if (fn === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
      return { data: null, error: null };
    },
  };
  return { admin, inserts, rpcs };
}

const SESSION = { id: "sessao-1", organization_id: "org-1" };

describe("o webhook com timestamp em nanossegundos ainda grava a mensagem", () => {
  it("mensagem do paciente: grava, com o horário certo, e carimba a conversa", async () => {
    const { admin, inserts, rpcs } = adminQueGrava();
    const payload: WahaPayload = {
      id: "false_5511999999999@c.us_ABC",
      from: "5511999999999@c.us",
      fromMe: false,
      body: "oi, tudo bem?",
      timestamp: NS,
    };

    await dispatchWahaEvent(admin as never, SESSION as never, { event: "message", session: "default", payload }, "req-1");

    expect(inserts, "a mensagem do paciente se perdeu").toHaveLength(1);
    expect(inserts[0]!.sent_at).toBe("2026-09-18T09:20:00.000Z");
    const carimbo = rpcs.find((c) => c.fn === "fn_mark_conversation_message");
    expect(carimbo, "a conversa não foi carimbada").toBeDefined();
    expect(JSON.stringify(carimbo!.args)).toContain("2026-09-18T09:20:00.000Z");
  });

  it("mensagem digitada no celular da clínica: grava com o horário certo", async () => {
    const { admin, inserts } = adminQueGrava();
    const payload: WahaPayload = {
      id: "true_250302204792918@lid_2A1B890FB8AA87730CBC",
      from: "250302204792918@lid",
      fromMe: true,
      body: "respondi por aqui mesmo",
      timestamp: NS,
    };

    await dispatchWahaEvent(admin as never, SESSION as never, { event: "message.any", session: "default", payload }, "req-1");

    expect(inserts, "a mensagem digitada no celular se perdeu").toHaveLength(1);
    expect(inserts[0]!.sent_at).toBe("2026-09-18T09:20:00.000Z");
  });
});
