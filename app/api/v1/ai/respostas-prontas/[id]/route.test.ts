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

import { PATCH } from "@/app/api/v1/ai/respostas-prontas/[id]/route";

const ORG = "0302ffff-0000-4000-8000-000000000001";
const ITEM = "0302ffff-0000-4000-8000-000000000003";

let ops: OperacaoGravada[];

function banco() {
  const g = supabaseGravador((op) => {
    if (op.tabela === "respostas_prontas" && op.acao === "select") {
      return { data: { id: ITEM, resposta: "antiga" }, error: null };
    }
    if (op.tabela === "respostas_prontas_perguntas" && op.acao === "select") {
      return {
        data: [
          { id: "p-velha", texto: "Quanto é a limpeza?" },
          { id: "p-fica", texto: "Quanto custa a limpeza?" },
        ],
        error: null,
      };
    }
    return { data: null, error: null };
  });
  h.cliente = g.cliente;
  ops = g.ops;
}

function patch(corpo: unknown, id: string = ITEM) {
  return PATCH(
    new NextRequest(`http://localhost/api/v1/ai/respostas-prontas/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  h.guard.mockResolvedValue({ ok: true, user: { id: "u", idioma: "pt-BR" }, org: { orgId: ORG, role: "manager" } });
  h.apoio.mockResolvedValue(null);
  h.embedar.mockImplementation(async (_org: string, textos: string[]) =>
    textos.map((texto) => ({ texto, embedding: "[0.1]", modelo_embedding: "openai/text-embedding-3-small" })),
  );
  banco();
});

describe("PATCH /api/v1/ai/respostas-prontas/:id", () => {
  it("forma de perguntar que SAIU da lista é apagada — senão continuaria casando", async () => {
    const r = await patch({ perguntas: ["Quanto custa a limpeza?", "Qual o valor da limpeza?"] });
    expect(r.status).toBe(200);
    expect(h.embedar).toHaveBeenCalledWith(ORG, ["Qual o valor da limpeza?"]);
    const apaga = ops.find((o) => o.tabela === "respostas_prontas_perguntas" && o.acao === "delete");
    expect(apaga?.filtros).toContainEqual(["in", "id", ["p-velha"]]);
    expect(apaga?.filtros).toContainEqual(["eq", "organization_id", ORG]);
  });

  it("mudar as perguntas conta como revisão", async () => {
    await patch({ perguntas: ["Quanto custa a limpeza?"] });
    const up = ops.find((o) => o.tabela === "respostas_prontas" && o.acao === "update");
    expect(up?.dados).toHaveProperty("revisado_em");
  });

  it("'marcar como revisada' só atualiza revisado_em", async () => {
    await patch({ revisado: true });
    const up = ops.find((o) => o.tabela === "respostas_prontas" && o.acao === "update");
    expect(Object.keys(up?.dados as object).sort()).toEqual(["revisado_em", "updated_at"]);
    expect(h.audit.mock.calls[0]![0]).toMatchObject({ action: "resposta_pronta.updated", resourceId: ITEM });
  });

  it("desativar não mexe em revisado_em", async () => {
    await patch({ ativo: false });
    const up = ops.find((o) => o.tabela === "respostas_prontas" && o.acao === "update");
    expect(up?.dados).toMatchObject({ ativo: false });
    expect(up?.dados).not.toHaveProperty("revisado_em");
  });

  it("mesmas formas de perguntar, noutra ordem: não é revisão nem mexe no banco das perguntas", async () => {
    await patch({ perguntas: ["Quanto custa a limpeza?", "Quanto é a limpeza?"] });
    const up = ops.find((o) => o.tabela === "respostas_prontas" && o.acao === "update");
    expect(up?.dados).not.toHaveProperty("revisado_em");
    expect(ops.some((o) => o.tabela === "respostas_prontas_perguntas" && o.acao !== "select")).toBe(false);
  });

  it("resposta reenviada com o MESMO texto: não é revisão", async () => {
    await patch({ resposta: "antiga" });
    const up = ops.find((o) => o.tabela === "respostas_prontas" && o.acao === "update");
    expect(up?.dados).not.toHaveProperty("revisado_em");
  });

  it("só o título mudou: não é revisão", async () => {
    await patch({ titulo: "Limpeza (preço)" });
    const up = ops.find((o) => o.tabela === "respostas_prontas" && o.acao === "update");
    expect(up?.dados).toMatchObject({ titulo: "Limpeza (preço)" });
    expect(up?.dados).not.toHaveProperty("revisado_em");
  });

  it("id que não é UUID: 422, sem tocar no banco", async () => {
    const r = await patch({ revisado: true }, "nao-e-uuid");
    expect(r.status).toBe(422);
    expect(ops).toHaveLength(0);
  });

  it("corpo vazio: 422", async () => {
    const r = await patch({});
    expect(r.status).toBe(422);
  });
});
