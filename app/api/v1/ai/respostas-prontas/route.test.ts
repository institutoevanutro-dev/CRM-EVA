import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { supabaseGravador, type OperacaoGravada } from "@/tests/unit/helpers/supabase-gravador";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  apoio: vi.fn(),
  audit: vi.fn(),
  embedar: vi.fn(),
  cliente: null as unknown,
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.apoio }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/respostas-prontas/embeddings", () => ({ embedarPerguntas: h.embedar }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.cliente }));

import { GET, POST } from "@/app/api/v1/ai/respostas-prontas/route";
import { PUT } from "@/app/api/v1/ai/respostas-prontas/config/route";

const ORG = "0302ffff-0000-4000-8000-000000000001";
const USER = "0302ffff-0000-4000-8000-000000000002";

function req(url: string, metodo: string, corpo: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method: metodo,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

let ops: OperacaoGravada[];
function banco(responder?: (op: OperacaoGravada) => { data: unknown; error: unknown }) {
  const g = supabaseGravador(
    responder ??
      ((op) =>
        op.tabela === "respostas_prontas" && op.acao === "insert"
          ? { data: { id: "item-1" }, error: null }
          : { data: null, error: null }),
  );
  h.cliente = g.cliente;
  ops = g.ops;
}

beforeEach(() => {
  vi.resetAllMocks();
  h.guard.mockResolvedValue({ ok: true, user: { id: USER, idioma: "pt-BR" }, org: { orgId: ORG, role: "manager" } });
  h.apoio.mockResolvedValue(null);
});

describe("GET /api/v1/ai/respostas-prontas", () => {
  it("sem papel suficiente: devolve a resposta do guard e não toca o banco", async () => {
    banco();
    h.guard.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    const r = await GET();
    expect(r.status).toBe(403);
    expect(ops).toHaveLength(0);
  });

  it("lista só a org da sessão; sem config = desligado no limite padrão; reconhecida pelo modelo", async () => {
    banco((op) => {
      if (op.tabela === "respostas_prontas") {
        return { data: [{ id: "i1", titulo: "Preço", resposta: "R$ 180", ativo: true, revisado_em: "2026-10-01" }], error: null };
      }
      if (op.tabela === "respostas_prontas_perguntas") {
        return {
          data: [
            { id: "p1", texto: "Quanto custa?", resposta_pronta_id: "i1", modelo_embedding: "openai/text-embedding-3-small" },
            { id: "p2", texto: "Qual o valor?", resposta_pronta_id: "i1", modelo_embedding: null },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    });
    const r = await GET();
    expect(r.status).toBe(200);
    const { data } = await r.json();
    expect(data.config).toEqual({ ligado: false, limite_similaridade: 0.82 });
    expect(data.itens[0].perguntas).toEqual([
      { id: "p1", texto: "Quanto custa?", reconhecida: true },
      { id: "p2", texto: "Qual o valor?", reconhecida: false },
    ]);
    expect(ops.length).toBeGreaterThan(0);
    for (const o of ops) expect(o.filtros).toContainEqual(["eq", "organization_id", ORG]);
  });
});

describe("POST /api/v1/ai/respostas-prontas", () => {
  it("sem chave de embedding: SALVA, marca como não reconhecida e audita uma vez", async () => {
    banco();
    h.embedar.mockResolvedValue([
      { texto: "Quanto custa a limpeza?", embedding: null, modelo_embedding: null },
      { texto: "Qual o valor da limpeza?", embedding: null, modelo_embedding: null },
    ]);
    const r = await POST(
      req("/api/v1/ai/respostas-prontas", "POST", {
        titulo: "Preço da limpeza",
        resposta: "A limpeza custa R$ 180,00.",
        perguntas: ["Quanto custa a limpeza?", "Qual o valor da limpeza?"],
      }),
    );
    expect(r.status).toBe(201);
    expect((await r.json()).data).toEqual({ id: "item-1", sem_reconhecimento: 2 });
    const perguntas = ops.find((o) => o.tabela === "respostas_prontas_perguntas" && o.acao === "insert");
    expect(perguntas?.dados).toEqual([
      { organization_id: ORG, resposta_pronta_id: "item-1", texto: "Quanto custa a limpeza?", embedding: null, modelo_embedding: null },
      { organization_id: ORG, resposta_pronta_id: "item-1", texto: "Qual o valor da limpeza?", embedding: null, modelo_embedding: null },
    ]);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]![0]).toMatchObject({ action: "resposta_pronta.created", organizationId: ORG, resourceId: "item-1" });
  });

  it("sem forma de perguntar: 422 e nada gravado", async () => {
    banco();
    const r = await POST(req("/api/v1/ai/respostas-prontas", "POST", { titulo: "x", resposta: "y", perguntas: [] }));
    expect(r.status).toBe(422);
    expect(ops).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("organization_id no corpo é rejeitado (a org vem da sessão)", async () => {
    banco();
    const r = await POST(
      req("/api/v1/ai/respostas-prontas", "POST", {
        titulo: "t",
        resposta: "r",
        perguntas: ["Quanto custa?"],
        organization_id: "outra-org",
      }),
    );
    expect(r.status).toBe(422);
    expect(ops).toHaveLength(0);
  });

  it("falha ao gravar as perguntas desfaz o item (não sobra item sem pergunta)", async () => {
    banco((op) => {
      if (op.tabela === "respostas_prontas" && op.acao === "insert") return { data: { id: "item-1" }, error: null };
      if (op.tabela === "respostas_prontas_perguntas") return { data: null, error: { message: "falhou" } };
      return { data: null, error: null };
    });
    h.embedar.mockResolvedValue([{ texto: "Quanto custa a limpeza?", embedding: null, modelo_embedding: null }]);
    const r = await POST(
      req("/api/v1/ai/respostas-prontas", "POST", { titulo: "t", resposta: "r", perguntas: ["Quanto custa a limpeza?"] }),
    );
    expect(r.status).toBe(500);
    expect(ops.some((o) => o.tabela === "respostas_prontas" && o.acao === "delete")).toBe(true);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("PUT /api/v1/ai/respostas-prontas/config", () => {
  it("limite fora de 0,78–0,95: 422 e nada gravado", async () => {
    banco();
    const r = await PUT(req("/api/v1/ai/respostas-prontas/config", "PUT", { ligado: true, limite_similaridade: 0.5 }));
    expect(r.status).toBe(422);
    expect(ops).toHaveLength(0);
  });

  it("grava por upsert na org da sessão e audita", async () => {
    banco();
    const r = await PUT(req("/api/v1/ai/respostas-prontas/config", "PUT", { ligado: true, limite_similaridade: 0.85 }));
    expect(r.status).toBe(200);
    const up = ops.find((o) => o.acao === "upsert");
    expect(up?.dados).toMatchObject({ organization_id: ORG, ligado: true, limite_similaridade: 0.85 });
    expect(h.audit.mock.calls[0]![0]).toMatchObject({ action: "resposta_pronta.config_changed" });
  });
});
