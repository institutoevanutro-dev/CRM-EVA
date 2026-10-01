import { describe, expect, it } from "vitest";

import { limparPayloadsDaSincronizacao } from "@/lib/retencao/sincronizacao-meta";

/**
 * Coexistência (LGPD): `meta.history_chunk` guarda a conversa crua e
 * `meta.state_sync` a agenda do celular em `event_log.payload`. Passados 7
 * dias, qualquer status (inclusive evento morto que nenhum worker limpou),
 * o conteúdo pessoal sai e a linha fica.
 */
interface Linha { id: string; organization_id: string; event_type: string; payload: Record<string, unknown> }

function fakeAdmin(porTipo: Record<string, Linha[]>, erroNoUpdate = false) {
  const filtros: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; org: unknown; patch: Record<string, unknown> }> = [];
  const admin = {
    from(tabela: string) {
      expect(tabela).toBe("event_log");
      const f: Record<string, unknown> = {};
      let patch: Record<string, unknown> | null = null;
      const q: Record<string, unknown> = {
        select: () => q,
        update: (p: Record<string, unknown>) => ((patch = p), q),
        eq: (c: string, v: unknown) => {
          f[c] = v;
          if (patch) {
            if (f.id !== undefined && f.organization_id !== undefined) {
              updates.push({ id: f.id as string, org: f.organization_id, patch });
              const linha = Object.values(porTipo).flat().find((l) => l.id === f.id);
              if (linha && !erroNoUpdate) linha.payload = patch.payload as Record<string, unknown>;
              return Promise.resolve({ error: erroNoUpdate ? { message: "x" } : null });
            }
          }
          return q;
        },
        lt: (c: string, v: unknown) => ((f[c] = v), q),
        not: (c: string, op: string) => ((f[`not:${c}`] = op), q),
        limit: () => {
          filtros.push({ ...f });
          const tipo = f.event_type as string;
          const campo = tipo === "meta.history_chunk" ? "value" : "contatos";
          const pend = (porTipo[tipo] ?? []).filter((l) => l.payload[campo] != null);
          return Promise.resolve({ data: pend, error: null });
        },
      };
      return q;
    },
  };
  return { admin: admin as never, filtros, updates };
}

describe("limparPayloadsDaSincronizacao", () => {
  it("zera value do history_chunk e contatos do state_sync com mais de 7 dias, sem olhar status", async () => {
    const porTipo = {
      "meta.history_chunk": [{ id: "a", organization_id: "o1", event_type: "meta.history_chunk", payload: { fase: 0, value: { history: [1] } } }],
      "meta.state_sync": [{ id: "b", organization_id: "o2", event_type: "meta.state_sync", payload: { contatos: [{ waId: "1" }] } }],
    };
    const { admin, filtros, updates } = fakeAdmin(porTipo);
    const n = await limparPayloadsDaSincronizacao(admin, new Date("2026-10-20T00:00:00Z"));
    expect(n).toBe(2);
    expect(filtros.every((f) => f.created_at === "2026-10-13T00:00:00.000Z" && !("status" in f))).toBe(true);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ id: "a", org: "o1" });
    expect(updates[0]!.patch.payload).toMatchObject({ fase: 0, value: null });
    expect(updates[1]!.patch.payload).toMatchObject({ contatos: null });
  });

  it("nada a limpar: devolve 0 e não escreve", async () => {
    const { admin, updates } = fakeAdmin({});
    expect(await limparPayloadsDaSincronizacao(admin)).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("falha no update não conta como limpo", async () => {
    const porTipo = { "meta.history_chunk": [{ id: "a", organization_id: "o1", event_type: "meta.history_chunk", payload: { value: { x: 1 } } }] };
    const { admin } = fakeAdmin(porTipo, true);
    expect(await limparPayloadsDaSincronizacao(admin)).toBe(0);
  });
});
