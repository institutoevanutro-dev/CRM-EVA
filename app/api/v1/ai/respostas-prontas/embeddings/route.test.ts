import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { POST } from "@/app/api/v1/ai/respostas-prontas/embeddings/route";

const ORG = "0302ffff-0000-4000-8000-000000000001";
let ops: OperacaoGravada[];

function banco() {
  const g = supabaseGravador((op) =>
    op.tabela === "respostas_prontas_perguntas" && op.acao === "select"
      ? { data: [{ id: "p1", texto: "a" }, { id: "p2", texto: "b" }], error: null }
      : { data: null, error: null },
  );
  h.cliente = g.cliente;
  ops = g.ops;
}

beforeEach(() => {
  vi.resetAllMocks();
  h.guard.mockResolvedValue({ ok: true, user: { id: "u", idioma: "pt-BR" }, org: { orgId: ORG, role: "manager" } });
  h.apoio.mockResolvedValue(null);
  banco();
});

describe("POST /api/v1/ai/respostas-prontas/embeddings", () => {
  it("sem papel suficiente: devolve o guard e não toca o banco", async () => {
    h.guard.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    const r = await POST();
    expect(r.status).toBe(403);
    expect(ops).toHaveLength(0);
  });

  it("calcula só as sem modelo, da org da sessão, e audita quando calculou", async () => {
    h.embedar.mockResolvedValue([
      { texto: "a", embedding: "[1]", modelo_embedding: "m" },
      { texto: "b", embedding: null, modelo_embedding: null },
    ]);
    const r = await POST();
    expect((await r.json()).data).toEqual({ calculadas: 1, faltando: 1 });
    const sel = ops.find((o) => o.acao === "select")!;
    expect(sel.filtros).toContainEqual(["eq", "organization_id", ORG]);
    expect(sel.filtros).toContainEqual(["is", "modelo_embedding", null]);
    const ups = ops.filter((o) => o.acao === "update");
    expect(ups).toHaveLength(1);
    expect(ups[0]!.filtros).toContainEqual(["eq", "id", "p1"]);
    expect(ups[0]!.filtros).toContainEqual(["eq", "organization_id", ORG]);
    expect(h.audit.mock.calls[0]![0]).toMatchObject({ action: "resposta_pronta.embeddings_calculated", organizationId: ORG });
  });

  it("nada calculado: não audita", async () => {
    h.embedar.mockResolvedValue([
      { texto: "a", embedding: null, modelo_embedding: null },
      { texto: "b", embedding: null, modelo_embedding: null },
    ]);
    const r = await POST();
    expect((await r.json()).data).toEqual({ calculadas: 0, faltando: 2 });
    expect(h.audit).not.toHaveBeenCalled();
  });
});
