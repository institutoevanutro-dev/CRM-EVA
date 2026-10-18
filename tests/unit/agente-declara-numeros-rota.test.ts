/**
 * A rota que muda EM QUAIS NÚMEROS o agente atende (migration 0380).
 *
 * O que só a rota garante (o banco mede o resto em
 * `tests/invariants/agente-declara-em-quais-numeros-atende.test.ts`):
 *   - só admin muda; o corpo é `{todos:true}` ou uma lista de uuids;
 *   - número de outra organização ou arquivado é recusado dizendo qual;
 *   - ACRESCENTA antes de TIRAR — ao contrário, a lista passaria por vazia, e
 *     vazia quer dizer "todos os números";
 *   - a mudança grava `ai_agent.numbers_changed` com o antes e o depois, e o
 *     PUT que não muda nada não grava trilha.
 *
 * Portado e adaptado do projeto original (DeskcommCRM, PR #2854 de @webtecnica).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const AGENTE = "55555555-5555-4555-8555-555555555555";
const N1 = "11111111-1111-4111-8111-111111111111";
const N2 = "33333333-3333-4333-8333-333333333333";
const DE_FORA = "44444444-4444-4444-8444-444444444444";

/** Banco falso: o estado das linhas e a ORDEM das escritas. */
let linhas: string[];
let numerosDaOrg: string[];
let escritas: string[];

function banco() {
  const de = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    let op: "select" | "delete" = "select";
    let fora: string[] = [];
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => ((filtros[c] = v), q),
      is: () => q,
      in: (_c: string, vs: string[]) => ((filtros.in = vs), q),
      not: (_c: string, _op: string, lista: string) => ((fora = lista.slice(1, -1).split(",")), q),
      delete: () => ((op = "delete"), q),
      maybeSingle: async () => ({
        data: tabela === "ai_agents" && filtros.organization_id === ORG && filtros.id === AGENTE ? { id: AGENTE } : null,
      }),
      upsert: async (rows: Array<{ channel_session_id: string; organization_id: string }>) => {
        escritas.push(`insere:${rows.map((r) => r.channel_session_id).join(",")}`);
        for (const r of rows) if (!linhas.includes(r.channel_session_id)) linhas.push(r.channel_session_id);
        return { error: null };
      },
      then: (ok: (r: unknown) => unknown) => {
        if (tabela === "ai_agent_channel_sessions" && op === "delete") {
          escritas.push(`apaga-fora-de:${fora.join(",")}`);
          linhas = linhas.filter((l) => fora.includes(l));
          return Promise.resolve({ error: null }).then(ok);
        }
        if (tabela === "ai_agent_channel_sessions") {
          return Promise.resolve({ data: linhas.map((channel_session_id) => ({ channel_session_id })), error: null }).then(ok);
        }
        if (tabela === "channel_sessions") {
          const pedidos = (filtros.in as string[]) ?? [];
          return Promise.resolve({ data: pedidos.filter((p) => numerosDaOrg.includes(p)).map((id) => ({ id })), error: null }).then(ok);
        }
        return Promise.resolve({ data: [], error: null }).then(ok);
      },
    };
    return q;
  };
  return { from: de };
}

const { PUT } = await import("@/app/api/v1/ai/agents/[id]/numeros/route");

function pedir(corpo: unknown) {
  return PUT(
    new NextRequest(`http://x/api/v1/ai/agents/${AGENTE}/numeros`, { method: "PUT", body: JSON.stringify(corpo) }),
    { params: Promise.resolve({ id: AGENTE }) },
  );
}

beforeEach(() => {
  linhas = [];
  numerosDaOrg = [N1, N2];
  escritas = [];
  vi.mocked(audit).mockClear();
  vi.mocked(createAdminClient).mockReturnValue(banco() as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u-admin", idioma: "pt-BR" },
    org: { orgId: ORG, role: "admin" },
  } as never);
});

describe("PUT /api/v1/ai/agents/:id/numeros", () => {
  it("pede papel de admin", async () => {
    await pedir({ todos: true });
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("admin");
  });

  it("declara os números, ACRESCENTANDO antes de tirar, e grava a trilha com antes e depois", async () => {
    linhas = [N2];
    const r = await pedir({ channel_session_ids: [N1] });
    expect(r.status).toBe(200);
    expect(escritas).toEqual([`insere:${N1}`, `apaga-fora-de:${N1}`]);
    expect(linhas).toEqual([N1]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai_agent.numbers_changed",
        organizationId: ORG,
        resourceId: AGENTE,
        metadata: { antes: [N2], depois: [N1] },
      }),
    );
  });

  it("`todos: true` volta ao padrão (tira as linhas) e a trilha diz 'todos'", async () => {
    linhas = [N1];
    const r = await pedir({ todos: true });
    expect(r.status).toBe(200);
    expect(linhas).toEqual([]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: { antes: [N1], depois: "todos" } }));
  });

  it("número que não é desta organização é recusado dizendo qual, sem escrever nada", async () => {
    const r = await pedir({ channel_session_ids: [N1, DE_FORA] });
    expect(r.status).toBe(422);
    const corpo = (await r.json()) as { error: { details: { channel_session_ids: string[] } } };
    expect(corpo.error.details.channel_session_ids).toEqual([DE_FORA]);
    expect(escritas).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("corpo fora do contrato (lista vazia, id que não é uuid, chave a mais) é 422", async () => {
    for (const corpo of [{ channel_session_ids: [] }, { channel_session_ids: ["x"] }, { todos: true, extra: 1 }, {}]) {
      expect((await pedir(corpo)).status, JSON.stringify(corpo)).toBe(422);
    }
    expect(escritas).toEqual([]);
  });

  it("PUT que não muda nada não grava trilha", async () => {
    linhas = [N1];
    await pedir({ channel_session_ids: [N1] });
    expect(audit).not.toHaveBeenCalled();
  });
});
