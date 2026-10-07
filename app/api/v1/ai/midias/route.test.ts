import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { supabaseGravador, type OperacaoGravada } from "@/tests/unit/helpers/supabase-gravador";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  apoio: vi.fn(),
  audit: vi.fn(),
  assinar: vi.fn(),
  cliente: null as unknown,
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.apoio }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.cliente }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: h.assinar }) } }),
}));

import { hashDoCorpo } from "@/lib/api/idempotency";
import { GET, POST } from "@/app/api/v1/ai/midias/route";

const ORG = "0326ffff-0000-4000-8000-000000000001";
const USER = "0326ffff-0000-4000-8000-000000000002";

const post = (corpo: unknown, chave?: string) =>
  new NextRequest("http://localhost/api/v1/ai/midias", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(chave ? { "Idempotency-Key": chave } : {}) },
    body: JSON.stringify(corpo),
  });

let ops: OperacaoGravada[];
function banco(responder?: (op: OperacaoGravada) => { data: unknown; error: unknown }) {
  const g = supabaseGravador(responder);
  h.cliente = g.cliente;
  ops = g.ops;
}

beforeEach(() => {
  vi.resetAllMocks();
  h.guard.mockResolvedValue({ ok: true, user: { id: USER, idioma: "pt-BR" }, org: { orgId: ORG, role: "manager" } });
  h.apoio.mockResolvedValue(null);
  h.assinar.mockResolvedValue({ data: { signedUrl: "https://x/assinada" }, error: null });
});

describe("/api/v1/ai/midias", () => {
  it("acesso negado devolve a resposta do guard e não toca o banco", async () => {
    banco();
    h.guard.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await GET()).status).toBe(403);
    expect((await POST(post({ title: "x" }))).status).toBe(403);
    expect(ops).toHaveLength(0);
  });

  it("POST com título vazio: 422 validation_failed", async () => {
    banco();
    const r = await POST(post({ title: "" }));
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("validation_failed");
    expect(ops).toHaveLength(0);
  });

  it("POST válido insere com a org da sessão (não a do body) e audita", async () => {
    banco(() => ({ data: { id: "m1" }, error: null }));
    const r = await POST(post({ title: "Vídeo da unidade" }));
    expect(r.status).toBe(201);
    expect((await r.json()).data).toEqual({ id: "m1" });
    expect(ops[0]!.dados).toMatchObject({ organization_id: ORG, created_by_user_id: USER, title: "Vídeo da unidade" });
    expect(h.audit.mock.calls[0]![0]).toMatchObject({ action: "media_library.item_created", organizationId: ORG, resourceId: "m1" });
    // organization_id no body é recusado pelo schema estrito
    expect((await POST(post({ title: "x", organization_id: "outra" }))).status).toBe(422);
  });

  it("POST em sessão de suporte: devolve a negativa e não toca banco nem audit", async () => {
    banco();
    h.apoio.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await POST(post({ title: "x" }))).status).toBe(403);
    expect(ops).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();
  });

  describe("Idempotency-Key", () => {
    const CHAVE = "0326ffff-0000-4000-8000-0000000000c1";
    it("chave que não é UUID: 400 e nada gravado", async () => {
      banco();
      const r = await POST(post({ title: "x" }, "nao-e-uuid"));
      expect(r.status).toBe(400);
      expect(ops).toHaveLength(0);
    });
    it("mesma chave + mesmo corpo: devolve o mesmo id sem segundo insert", async () => {
      banco((op) =>
        op.tabela === "idempotency_keys"
          ? { data: { request_hash: hashDoCorpo({ title: "Vídeo" }), status_code: 201, response_body: { id: "m1" } }, error: null }
          : { data: { id: "novo" }, error: null },
      );
      const r = await POST(post({ title: "Vídeo" }, CHAVE));
      expect(r.status).toBe(201);
      expect((await r.json()).data).toEqual({ id: "m1" });
      expect(ops.some((o) => o.tabela === "media_library_items")).toBe(false);
    });
    it("mesma chave + corpo diferente: 409 idempotency_conflict", async () => {
      banco((op) =>
        op.tabela === "idempotency_keys"
          ? { data: { request_hash: hashDoCorpo({ title: "Outro" }), status_code: 201, response_body: { id: "m1" } }, error: null }
          : { data: { id: "novo" }, error: null },
      );
      const r = await POST(post({ title: "Vídeo" }, CHAVE));
      expect(r.status).toBe(409);
      expect((await r.json()).error.code).toBe("idempotency_conflict");
      expect(ops.some((o) => o.tabela === "media_library_items")).toBe(false);
    });
    it("chave nova: insere e grava o recibo", async () => {
      banco((op) => (op.tabela === "idempotency_keys" ? { data: null, error: null } : { data: { id: "m2" }, error: null }));
      const r = await POST(post({ title: "Vídeo" }, CHAVE));
      expect(r.status).toBe(201);
      expect(ops.filter((o) => o.acao === "insert").map((o) => o.tabela)).toEqual(["media_library_items", "idempotency_keys"]);
    });
  });

  it("GET calcula a situação: pessoa sem termo = sem_termo; sem pessoa com variante = pronta", async () => {
    const variante = (id: string) => ({ key: "A", storage_path: `${ORG}/${id}/A-1.png`, mime: "image/png", size_bytes: 10 });
    const base = { when_to_use: null, tags: [], consent_subject: null, consent_scope: null, consent_signed_at: null, consent_expires_at: null, consent_revoked_at: null };
    banco(() => ({
      data: [
        { ...base, id: "a", title: "Com pessoa", contains_person: true, variants: [variante("a")] },
        { ...base, id: "b", title: "Sem pessoa", contains_person: false, variants: [variante("b")] },
      ],
      error: null,
    }));
    const { data } = await (await GET()).json();
    expect(data.itens.map((i: { situacao: string }) => i.situacao)).toEqual(["sem_termo", "pronta"]);
    expect(data.itens[1].variantes).toEqual([{ key: "A", mime: "image/png", size_bytes: 10, url: "https://x/assinada" }]);
    expect(data.itens[0]).not.toHaveProperty("variants");
    expect(ops[0]!.filtros).toContainEqual(["eq", "organization_id", ORG]);
  });

  it("GET nunca assina caminho de outra org gravado na linha", async () => {
    const alheia = { key: "A", storage_path: `outra/a/A-1.png`, mime: "image/png", size_bytes: 10 };
    banco(() => ({ data: [{ id: "a", title: "x", when_to_use: null, tags: [], contains_person: false, consent_subject: null, consent_scope: null, consent_signed_at: null, consent_expires_at: null, consent_revoked_at: null, variants: [alheia] }], error: null }));
    const { data } = await (await GET()).json();
    expect(h.assinar).not.toHaveBeenCalled();
    expect(data.itens[0].variantes).toEqual([]);
  });
});
