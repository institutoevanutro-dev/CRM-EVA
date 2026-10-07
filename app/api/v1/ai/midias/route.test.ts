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

import { GET, POST } from "@/app/api/v1/ai/midias/route";

const ORG = "0326ffff-0000-4000-8000-000000000001";
const USER = "0326ffff-0000-4000-8000-000000000002";

const post = (corpo: unknown) =>
  new NextRequest("http://localhost/api/v1/ai/midias", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

  it("GET calcula a situação: pessoa sem termo = sem_termo; sem pessoa com variante = pronta", async () => {
    const variante = { key: "A", storage_path: "o/i/A-1.png", mime: "image/png", size_bytes: 10 };
    const base = { when_to_use: null, tags: [], consent_subject: null, consent_scope: null, consent_signed_at: null, consent_expires_at: null, consent_revoked_at: null };
    banco(() => ({
      data: [
        { ...base, id: "a", title: "Com pessoa", contains_person: true, variants: [variante] },
        { ...base, id: "b", title: "Sem pessoa", contains_person: false, variants: [variante] },
      ],
      error: null,
    }));
    const { data } = await (await GET()).json();
    expect(data.itens.map((i: { situacao: string }) => i.situacao)).toEqual(["sem_termo", "pronta"]);
    expect(data.itens[1].variantes).toEqual([{ key: "A", mime: "image/png", size_bytes: 10, url: "https://x/assinada" }]);
    expect(data.itens[0]).not.toHaveProperty("variants");
    expect(ops[0]!.filtros).toContainEqual(["eq", "organization_id", ORG]);
  });
});
