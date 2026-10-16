import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/v1/conversations/bulk (porte do upstream #2909).
 *
 * Os handlers por conversa são dublês aqui: a regra deles (org da sessão,
 * `fn_service_status`, auditoria por item) já tem testes próprios. O que este
 * arquivo prende é o que o LOTE acrescenta: portão da chamada, teto, relatório
 * por item, a org do corpo descartada e a ausência de `reactivate-bot`.
 */
const auth = vi.hoisted(() => ({ negar: false }));
const chamadas = vi.hoisted(() => [] as Array<{ rota: string; id: string; corpo: unknown }>);

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () =>
    auth.negar
      ? {
          ok: false,
          response: NextResponse.json(
            { error: { code: "forbidden_role", message: "Sem permissão." } },
            { status: 403 },
          ),
        }
      : { ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: "org-a", role: "agent" } },
  ),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

function dubleDe(rota: string) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const corpo = await req.json().catch(() => null);
    chamadas.push({ rota, id, corpo });
    if (id.startsWith("bbbbbbbb")) {
      // Conversa de outra organização: o handler por item não a enxerga.
      return NextResponse.json(
        { error: { code: "not_found", message: "Conversa não encontrada." } },
        { status: 404, headers: { "X-Request-Id": `req-${id}` } },
      );
    }
    if (id.startsWith("dddddddd")) throw new Error("banco caiu no meio da escrita");
    return NextResponse.json({ data: { id } }, { headers: { "X-Request-Id": `req-${id}` } });
  };
}
vi.mock("../[id]/close/route", () => ({ POST: dubleDe("close") }));
vi.mock("../[id]/mark-read/route", () => ({ POST: dubleDe("mark-read") }));
vi.mock("../[id]/pause-ai/route", () => ({ POST: dubleDe("pause-ai") }));
vi.mock("../[id]/transfer/route", () => ({ POST: dubleDe("transfer") }));
vi.mock("../[id]/route", () => ({ PATCH: dubleDe("patch") }));

import { POST, TETO_DO_LOTE } from "./route";

const A1 = "aaaaaaaa-1111-4000-8000-000000000001";
const A2 = "aaaaaaaa-1111-4000-8000-000000000002";
const B1 = "bbbbbbbb-1111-4000-8000-000000000001";
const D1 = "dddddddd-1111-4000-8000-000000000001";
const DESTINO = "aaaaaaaa-4444-4000-8000-000000000004";

function chamar(corpo: unknown) {
  return POST(
    new NextRequest("http://localhost/api/v1/conversations/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpo),
    }),
  );
}

beforeEach(() => {
  auth.negar = false;
  chamadas.length = 0;
});

describe("POST /api/v1/conversations/bulk", () => {
  it("fecha cada conversa pelo handler individual e recusa NO ITEM a de outra organização", async () => {
    const res = await chamar({ action: "close", ids: [A1, B1, A2] });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(chamadas.map((c) => [c.rota, c.id])).toEqual([
      ["close", A1],
      ["close", B1],
      ["close", A2],
    ]);
    expect(data).toMatchObject({ acao: "close", total: 3, feitos: 2, recusados: 1 });
    expect(data.resultados[1]).toMatchObject({ id: B1, feito: false, codigo: "not_found" });
    expect(data.resultados[0]).toMatchObject({ id: A1, feito: true, request_id: `req-${A1}` });
  });

  it("viewer: 403 na chamada e nenhuma subchamada", async () => {
    auth.negar = true;
    const res = await chamar({ action: "close", ids: [A1] });
    expect(res.status).toBe(403);
    expect(chamadas).toHaveLength(0);
  });

  it("acima do teto: 422 bulk_too_large e nenhuma subchamada", async () => {
    const ids = Array.from({ length: TETO_DO_LOTE + 1 }, (_, i) =>
      `aaaaaaaa-1111-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const res = await chamar({ action: "close", ids });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("bulk_too_large");
    expect(chamadas).toHaveLength(0);
  });

  it("reactivate-bot em lote não existe: 422 e nenhuma subchamada", async () => {
    const res = await chamar({ action: "reactivate-bot", ids: [A1] });
    expect(res.status).toBe(422);
    expect(chamadas).toHaveLength(0);
  });

  it("a organização do corpo é ignorada e o destino chega ao handler de transferência", async () => {
    const res = await chamar({
      action: "transfer",
      ids: [A1],
      to_user_id: DESTINO,
      reason: "plantão",
      organization_id: "org-b",
    });
    expect(res.status).toBe(200);
    expect(chamadas).toEqual([
      { rota: "transfer", id: A1, corpo: { to_user_id: DESTINO, reason: "plantão" } },
    ]);
  });

  it("arquivar vai pelo PATCH de status; marcar lida e pausar IA pelas rotas irmãs", async () => {
    await chamar({ action: "archive", ids: [A1] });
    await chamar({ action: "mark-read", ids: [A1] });
    await chamar({ action: "pause-ai", ids: [A1] });
    expect(chamadas).toEqual([
      { rota: "patch", id: A1, corpo: { status: "archived" } },
      { rota: "mark-read", id: A1, corpo: {} },
      { rota: "pause-ai", id: A1, corpo: {} },
    ]);
  });

  it("handler que estoura recusa só o item; id repetido roda uma vez", async () => {
    const res = await chamar({ action: "close", ids: [D1, A1, A1] });
    const { data } = await res.json();
    expect(data).toMatchObject({ total: 2, feitos: 1, recusados: 1 });
    expect(data.resultados[0]).toMatchObject({ id: D1, feito: false, codigo: "internal_error" });
  });
});
