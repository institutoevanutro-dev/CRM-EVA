import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

import { DELETE, POST } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const AGORA = "2026-10-16T11:30:00.000Z";

let rpc: ReturnType<typeof vi.fn>;

/** Corpo com OUTRA organização: a rota não lê corpo nenhum, e o teste prova. */
const req = (method: "POST" | "DELETE") =>
  new NextRequest("http://localhost/api/v1/leads/at-risk/recomeco", {
    method,
    body: JSON.stringify({ organization_id: ORG_B, p_org: ORG_B }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  rpc = vi.fn().mockResolvedValue({ data: { desde: AGORA, antes: null, mudou: true }, error: null });
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ADMIN, idioma: "pt-BR" },
    org: { orgId: ORG_A, role: "admin" },
  } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createAdminClient).mockReturnValue({ rpc } as unknown as ReturnType<typeof createAdminClient>);
});

describe("recomeçar o radar", () => {
  it("exige administrador e nega sem tocar o banco nem auditar", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden_role", "x", 403) });
    expect((await POST(req("POST"))).status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("admin", expect.objectContaining({ resource: "radar" }));
    expect(rpc).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("acompanhamento somente leitura nega antes de tudo", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(fail("forbidden", "somente leitura", 403));
    expect((await DELETE(req("DELETE"))).status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("recomeça com a organização e o autor da SESSÃO, nunca do corpo, e audita", async () => {
    const r = await POST(req("POST"));
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({ recomecado_em: AGORA });
    expect(rpc).toHaveBeenCalledWith("fn_definir_inicio_do_radar", {
      p_org: ORG_A,
      p_actor: ADMIN,
      p_recomecar: true,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "radar.recomecado",
        actorUserId: ADMIN,
        organizationId: ORG_A,
        resourceType: "organization",
        resourceId: ORG_A,
        metadata: { desde: AGORA, antes: null },
      }),
    );
  });

  it("desfazer limpa o instante e audita com o que valia antes", async () => {
    rpc.mockResolvedValue({ data: { desde: null, antes: AGORA, mudou: true }, error: null });
    const r = await DELETE(req("DELETE"));
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({ recomecado_em: null });
    expect(rpc).toHaveBeenCalledWith("fn_definir_inicio_do_radar", expect.objectContaining({ p_recomecar: false }));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "radar.recomeco_desfeito", metadata: { desde: null, antes: AGORA } }),
    );
  });

  it("nada mudou (desfazer sem recomeço): responde e não audita", async () => {
    rpc.mockResolvedValue({ data: { desde: null, antes: null, mudou: false }, error: null });
    expect((await DELETE(req("DELETE"))).status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("a função recusa o papel (42501): 403, sem auditoria", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "inicio_do_radar_sem_permissao" } });
    const r = await POST(req("POST"));
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("forbidden_role");
    expect(audit).not.toHaveBeenCalled();
  });

  it("erro do banco ou corpo inesperado: 500, sem auditoria", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    expect((await POST(req("POST"))).status).toBe(500);
    rpc.mockResolvedValue({ data: { qualquer: 1 }, error: null });
    expect((await POST(req("POST"))).status).toBe(500);
    expect(audit).not.toHaveBeenCalled();
  });
});
