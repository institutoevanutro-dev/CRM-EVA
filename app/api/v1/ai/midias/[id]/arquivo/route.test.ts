// @vitest-environment node
//
// Multipart real (File/FormData) precisa do realm do Node: o jsdom corrompe o corpo no parser do NextRequest.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { supabaseGravador, type OperacaoGravada } from "@/tests/unit/helpers/supabase-gravador";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  apoio: vi.fn(),
  audit: vi.fn(),
  subir: vi.fn(),
  remover: vi.fn(),
  bucket: vi.fn(),
  ordem: [] as string[],
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
        return { upload: h.subir, remove: h.remover };
      },
    },
  }),
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { DELETE, POST } from "@/app/api/v1/ai/midias/[id]/arquivo/route";

const ORG = "0326ffff-0000-4000-8000-000000000001";
const USER = "0326ffff-0000-4000-8000-000000000002";
const ID = "0326ffff-0000-4000-8000-0000000000aa";
const ctx = { params: Promise.resolve({ id: ID }) };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const item = (variants: unknown[] = []) => ({
  id: ID,
  updated_at: "2026-10-07T10:00:00Z",
  variants,
  contains_person: false,
  consent_signed_at: null,
  consent_expires_at: null,
  consent_revoked_at: null,
});
const antiga = { key: "A", storage_path: `${ORG}/${ID}/A-velho.png`, mime: "image/png", size_bytes: 1 };

function envio(campos: { variante?: string; bytes?: Uint8Array; tipo?: string }, headers: Record<string, string> = {}) {
  const f = new FormData();
  if (campos.variante) f.set("variante", campos.variante);
  if (campos.bytes) f.set("arquivo", new File([campos.bytes as BlobPart], "x.png", { type: campos.tipo ?? "image/png" }));
  return new NextRequest(`http://localhost/api/v1/ai/midias/${ID}/arquivo`, { method: "POST", body: f, headers });
}
const del = (q = "?variante=B") => new NextRequest(`http://localhost/api/v1/ai/midias/${ID}/arquivo${q}`, { method: "DELETE" });

let ops: OperacaoGravada[];
function banco(lido: unknown, updateComErro = false, linhasAfetadas = 1) {
  const g = supabaseGravador((op) => {
    if (op.acao === "update") {
      h.ordem.push("update");
      return { data: linhasAfetadas ? [{ id: ID }] : [], error: updateComErro ? { message: "boom" } : null };
    }
    return { data: lido, error: null };
  });
  h.cliente = g.cliente;
  ops = g.ops;
}
const acoes = () => h.audit.mock.calls.map((c) => c[0].action);

beforeEach(() => {
  vi.resetAllMocks();
  h.ordem = [];
  h.guard.mockResolvedValue({ ok: true, user: { id: USER, idioma: "pt-BR" }, org: { orgId: ORG, role: "manager" } });
  h.apoio.mockResolvedValue(null);
  h.subir.mockResolvedValue({ error: null });
  h.remover.mockImplementation(async (c: string[]) => {
    h.ordem.push(`remove:${c[0]}`);
    return { error: null };
  });
});

describe("POST /api/v1/ai/midias/:id/arquivo", () => {
  it("sessão de suporte: devolve a negativa e não toca banco nem storage", async () => {
    banco(item());
    h.apoio.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await POST(envio({ variante: "A", bytes: PNG }), ctx)).status).toBe(403);
    expect(ops).toHaveLength(0);
    expect(h.subir).not.toHaveBeenCalled();
  });

  it("content-length acima do teto: 413 sem ler o corpo nem tocar o storage", async () => {
    banco(item());
    const req = envio({ variante: "A", bytes: PNG }, { "content-length": String(50 * 1024 * 1024 + 64 * 1024 + 1) });
    const spy = vi.spyOn(req, "formData");
    const r = await POST(req, ctx);
    expect(r.status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
    expect(h.subir).not.toHaveBeenCalled();
  });

  it("variante inválida ou sem arquivo: 400 invalid_request", async () => {
    banco(item());
    for (const req of [envio({ variante: "C", bytes: PNG }), envio({ variante: "A" })]) {
      const r = await POST(req, ctx);
      expect(r.status).toBe(400);
      expect((await r.json()).error.code).toBe("invalid_request");
    }
    expect(h.subir).not.toHaveBeenCalled();
  });

  it("png que na verdade é svg: 415", async () => {
    banco(item());
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const r = await POST(envio({ variante: "A", bytes: svg }), ctx);
    expect(r.status).toBe(415);
    expect((await r.json()).error.code).toBe("unsupported_media_type");
    expect(h.subir).not.toHaveBeenCalled();
  });

  it("pdf válido mas fora dos tipos da biblioteca: 415", async () => {
    banco(item());
    const pdf = new TextEncoder().encode("%PDF-1.4\n%....");
    const r = await POST(envio({ variante: "A", bytes: pdf, tipo: "application/pdf" }), ctx);
    expect(r.status).toBe(415);
    expect(h.subir).not.toHaveBeenCalled();
  });

  it("item de outra org: 404 e nenhum upload", async () => {
    banco(null);
    const r = await POST(envio({ variante: "A", bytes: PNG }), ctx);
    expect(r.status).toBe(404);
    expect(ops[0]!.filtros).toEqual(expect.arrayContaining([["eq", "organization_id", ORG], ["eq", "id", ID]]));
    expect(h.subir).not.toHaveBeenCalled();
  });

  it("variante nova: sobe no bucket, grava variants, audita e responde 201", async () => {
    banco(item());
    const r = await POST(envio({ variante: "A", bytes: PNG }), ctx);
    expect(r.status).toBe(201);
    expect(h.bucket).toHaveBeenCalledWith("media-library");
    const caminho = h.subir.mock.calls[0]![0] as string;
    expect(caminho).toMatch(new RegExp(`^${ORG}/${ID}/A-[0-9a-f-]{36}\\.png$`));
    const up = ops.find((o) => o.acao === "update")!;
    expect(up.dados).toEqual({ variants: [{ key: "A", storage_path: caminho, mime: "image/png", size_bytes: PNG.length }] });
    expect(acoes()).toEqual(["media_library.file_replaced"]);
    expect((await r.json()).data).toMatchObject({ key: "A", situacao: "pronta" });
  });

  it("troca: o arquivo antigo só sai DEPOIS do update", async () => {
    banco(item([antiga]));
    const r = await POST(envio({ variante: "A", bytes: PNG }), ctx);
    expect(r.status).toBe(201);
    expect(h.ordem).toEqual(["update", `remove:${antiga.storage_path}`]);
  });

  it("update falha: remove o NOVO, o antigo fica", async () => {
    banco(item([antiga]), true);
    const r = await POST(envio({ variante: "A", bytes: PNG }), ctx);
    expect(r.status).toBe(500);
    const novo = h.subir.mock.calls[0]![0] as string;
    expect(h.remover).toHaveBeenCalledTimes(1);
    expect(h.remover).toHaveBeenCalledWith([novo]);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("concorrência e caminhos alheios", () => {
  it("update com zero linhas (alguém mexeu antes): 409, remove o novo, o antigo fica", async () => {
    banco(item([antiga]), false, 0);
    const r = await POST(envio({ variante: "A", bytes: PNG }), ctx);
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("state_conflict");
    const up = ops.find((o) => o.acao === "update")!;
    expect(up.filtros).toContainEqual(["eq", "updated_at", "2026-10-07T10:00:00Z"]);
    expect(h.remover).toHaveBeenCalledTimes(1);
    expect(h.remover).toHaveBeenCalledWith([h.subir.mock.calls[0]![0]]);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("DELETE com zero linhas: 409 e nada removido", async () => {
    const b = { key: "B", storage_path: `${ORG}/${ID}/B-1.png`, mime: "image/png", size_bytes: 1 };
    banco(item([b]), false, 0);
    expect((await DELETE(del(), ctx)).status).toBe(409);
    expect(h.remover).not.toHaveBeenCalled();
  });

  it("caminho de outra org na linha é ignorado: DELETE não remove nada e troca não remove o alheio", async () => {
    const alheia = { key: "A", storage_path: `outra/${ID}/A-1.png`, mime: "image/png", size_bytes: 1 };
    banco(item([alheia]));
    expect((await DELETE(del("?variante=A"), ctx)).status).toBe(200);
    expect(h.remover).not.toHaveBeenCalled();
    banco(item([alheia]));
    expect((await POST(envio({ variante: "A", bytes: PNG }), ctx)).status).toBe(201);
    expect(h.remover).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/v1/ai/midias/:id/arquivo", () => {
  it("sessão de suporte: devolve a negativa e não toca banco nem storage", async () => {
    banco(item([antiga]));
    h.apoio.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await DELETE(del("?variante=A"), ctx)).status).toBe(403);
    expect(ops).toHaveLength(0);
    expect(h.remover).not.toHaveBeenCalled();
  });

  const b = { key: "B", storage_path: `${ORG}/${ID}/B-1.png`, mime: "image/png", size_bytes: 1 };

  it("tira a variante de variants, remove o arquivo e audita file_removed", async () => {
    banco(item([antiga, b]));
    const r = await DELETE(del(), ctx);
    expect(r.status).toBe(200);
    expect(ops.find((o) => o.acao === "update")!.dados).toEqual({ variants: [antiga] });
    expect(h.remover).toHaveBeenCalledWith([b.storage_path]);
    expect(acoes()).toEqual(["media_library.file_removed"]);
  });

  it("variante desconhecida: 400", async () => {
    banco(item());
    expect((await DELETE(del("?variante=Z"), ctx)).status).toBe(400);
  });
});
