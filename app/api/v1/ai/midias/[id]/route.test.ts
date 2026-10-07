import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { supabaseGravador, type OperacaoGravada } from "@/tests/unit/helpers/supabase-gravador";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  apoio: vi.fn(),
  audit: vi.fn(),
  remover: vi.fn(),
  aviso: vi.fn(),
  bucket: vi.fn(),
  cliente: null as unknown,
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.apoio }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.cliente }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: (b: string) => {
        h.bucket(b);
        return { remove: h.remover };
      },
    },
  }),
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: h.aviso, info: vi.fn(), debug: vi.fn() } }));

import { DELETE, PATCH } from "@/app/api/v1/ai/midias/[id]/route";

const ORG = "0326ffff-0000-4000-8000-000000000001";
const USER = "0326ffff-0000-4000-8000-000000000002";
const ID = "0326ffff-0000-4000-8000-0000000000aa";
const ctx = { params: Promise.resolve({ id: ID }) };

const patch = (corpo: unknown) =>
  new NextRequest(`http://localhost/api/v1/ai/midias/${ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
const del = () => new NextRequest(`http://localhost/api/v1/ai/midias/${ID}`, { method: "DELETE" });

let ops: OperacaoGravada[];
function banco(responder?: (op: OperacaoGravada) => { data: unknown; error: unknown }) {
  const g = supabaseGravador(responder);
  h.cliente = g.cliente;
  ops = g.ops;
}
const acoes = () => h.audit.mock.calls.map((c) => c[0].action);

beforeEach(() => {
  vi.resetAllMocks();
  h.guard.mockResolvedValue({ ok: true, user: { id: USER, idioma: "pt-BR" }, org: { orgId: ORG, role: "manager" } });
  h.apoio.mockResolvedValue(null);
  h.remover.mockResolvedValue({ error: null });
});

describe("PATCH /api/v1/ai/midias/:id", () => {
  it("id que não é da org: 404 not_found e nenhuma gravação", async () => {
    banco(() => ({ data: null, error: null }));
    const r = await PATCH(patch({ title: "Novo" }), ctx);
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe("not_found");
    expect(ops[0]!.filtros).toEqual(expect.arrayContaining([["eq", "organization_id", ORG], ["eq", "id", ID]]));
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("consent grava o termo, zera a revogação e audita consent_recorded", async () => {
    banco(() => ({ data: { id: ID, variants: [], contains_person: true, consent_signed_at: "2026-10-01", consent_expires_at: null, consent_revoked_at: null }, error: null }));
    const r = await PATCH(patch({ consent: { subject: "Maria", scope: "WhatsApp", signed_at: "2026-10-01", expires_at: null } }), ctx);
    expect(r.status).toBe(200);
    expect(ops.find((o) => o.acao === "update")!.dados).toEqual({
      consent_subject: "Maria",
      consent_scope: "WhatsApp",
      consent_signed_at: "2026-10-01",
      consent_expires_at: null,
      consent_revoked_at: null,
    });
    expect(acoes()).toEqual(["media_library.consent_recorded"]);
  });

  it("revogar grava consent_revoked_at e audita consent_revoked", async () => {
    const naoRevogada = { id: ID, variants: [], contains_person: true, consent_signed_at: "2026-10-01", consent_expires_at: null, consent_revoked_at: null };
    banco((op) => ({ data: op.acao === "select" ? naoRevogada : { id: ID, variants: [{ key: "A", storage_path: `${ORG}/${ID}/A-1.png`, mime: "image/png", size_bytes: 1 }], contains_person: true, consent_signed_at: "2026-10-01", consent_expires_at: null, consent_revoked_at: "2026-10-07T00:00:00Z" }, error: null }));
    const r = await PATCH(patch({ revogar: true }), ctx);
    expect(r.status).toBe(200);
    expect((await r.json()).data.situacao).toBe("revogada");
    expect(typeof (ops.find((o) => o.acao === "update")!.dados as Record<string, unknown>).consent_revoked_at).toBe("string");
    expect(acoes()).toEqual(["media_library.consent_revoked"]);
  });

  it("sessão de suporte: devolve a negativa e não toca banco nem audit", async () => {
    banco();
    h.apoio.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await PATCH(patch({ title: "Novo" }), ctx)).status).toBe(403);
    expect(ops).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();
  });

  const termo = (signed_at: string) => ({ consent: { subject: "Maria", scope: "WhatsApp", signed_at, expires_at: null } });
  const revogadaEm = { id: ID, variants: [{ key: "A", storage_path: `${ORG}/${ID}/A-1.png`, mime: "image/png", size_bytes: 1 }], contains_person: true, consent_signed_at: "2026-10-01", consent_expires_at: null, consent_revoked_at: "2026-10-05T15:00:00Z" };

  it("item revogado: reenviar o termo antigo (assinado até a revogação) é 422 e nada grava", async () => {
    banco(() => ({ data: revogadaEm, error: null }));
    for (const d of ["2026-10-01", "2026-10-05"]) {
      const r = await PATCH(patch(termo(d)), ctx);
      expect(r.status).toBe(422);
      expect((await r.json()).error.message).toContain("termo novo");
    }
    expect(ops.every((o) => o.acao === "select")).toBe(true);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("item revogado: termo assinado DEPOIS da revogação é aceito", async () => {
    banco((op) => ({ data: op.acao === "select" ? revogadaEm : { ...revogadaEm, consent_signed_at: "2026-10-06", consent_revoked_at: null }, error: null }));
    expect((await PATCH(patch(termo("2026-10-06")), ctx)).status).toBe(200);
    expect(acoes()).toEqual(["media_library.consent_recorded"]);
  });

  it("consent e revogar no mesmo pedido: 422", async () => {
    banco();
    expect((await PATCH(patch({ ...termo("2026-10-01"), revogar: true }), ctx)).status).toBe(422);
    expect(ops).toHaveLength(0);
  });

  it("revogar de novo mantém a data original: não regrava o campo nem audita outra vez", async () => {
    banco(() => ({ data: revogadaEm, error: null }));
    const r = await PATCH(patch({ revogar: true }), ctx);
    expect(r.status).toBe(200);
    expect((await r.json()).data.situacao).toBe("revogada");
    expect(ops.every((o) => o.acao === "select")).toBe(true);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("item_updated audita os campos mudados e o novo contains_person", async () => {
    banco(() => ({ data: { id: ID, variants: [], contains_person: false, consent_signed_at: null, consent_expires_at: null, consent_revoked_at: null }, error: null }));
    await PATCH(patch({ title: "Novo", contains_person: false }), ctx);
    expect(h.audit.mock.calls[0]![0]).toMatchObject({
      action: "media_library.item_updated",
      metadata: { fields: ["title", "contains_person"], contains_person: false },
    });
  });
});

describe("DELETE /api/v1/ai/midias/:id", () => {
  const variantes = [{ key: "A", storage_path: `${ORG}/${ID}/A-1.png`, mime: "image/png", size_bytes: 1 }];

  it("apaga a linha filtrando org e id, depois remove os arquivos do bucket, e audita", async () => {
    banco(() => ({ data: { id: ID, title: "Vídeo", variants: variantes }, error: null }));
    const r = await DELETE(del(), ctx);
    expect(r.status).toBe(200);
    expect(ops[0]).toMatchObject({ tabela: "media_library_items", acao: "delete" });
    expect(ops[0]!.filtros).toEqual(expect.arrayContaining([["eq", "organization_id", ORG], ["eq", "id", ID]]));
    expect(h.bucket).toHaveBeenCalledWith("media-library");
    expect(h.remover).toHaveBeenCalledWith([`${ORG}/${ID}/A-1.png`]);
    expect(acoes()).toEqual(["media_library.item_deleted"]);
  });

  it("caminho de OUTRA org gravado na linha nunca vai para o remove", async () => {
    const alheia = { key: "B", storage_path: `outra/${ID}/B-1.png`, mime: "image/png", size_bytes: 1 };
    banco(() => ({ data: { id: ID, title: "Vídeo", variants: [...variantes, alheia] }, error: null }));
    expect((await DELETE(del(), ctx)).status).toBe(200);
    expect(h.remover).toHaveBeenCalledTimes(1);
    expect(h.remover).toHaveBeenCalledWith([`${ORG}/${ID}/A-1.png`]);
  });

  it("falha ao remover do bucket não muda o 200: só loga", async () => {
    banco(() => ({ data: { id: ID, title: "Vídeo", variants: variantes }, error: null }));
    h.remover.mockResolvedValue({ error: { message: "boom" } });
    expect((await DELETE(del(), ctx)).status).toBe(200);
    expect(h.aviso).toHaveBeenCalled();
  });

  it("sessão de suporte: devolve a negativa e não toca banco nem bucket", async () => {
    banco();
    h.apoio.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await DELETE(del(), ctx)).status).toBe(403);
    expect(ops).toHaveLength(0);
    expect(h.remover).not.toHaveBeenCalled();
  });

  it("id de outra org: 404 e nada removido do bucket", async () => {
    banco(() => ({ data: null, error: null }));
    expect((await DELETE(del(), ctx)).status).toBe(404);
    expect(h.remover).not.toHaveBeenCalled();
  });
});
