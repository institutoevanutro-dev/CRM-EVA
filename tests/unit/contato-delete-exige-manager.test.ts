import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * APAGAR A FICHA É DE GERENTE PARA CIMA — a rota e a RLS dizem a mesma coisa.
 *
 * `DELETE /api/v1/contacts/[id]` apaga conversas e mensagens junto (hard
 * delete), contra a doutrina "anonimizar antes de apagar". A rota cobrava
 * `agent`; a policy `contacts_delete` (migration 0289) cobra `manager`. Uma
 * rota que pede menos que o banco devolve 204 com 0 linhas apagadas — e quem
 * lê o 204 acredita que apagou. Este arquivo prende o piso da rota ao do
 * banco; o do banco está em `tests/invariants/endurecimento-0289.test.ts`.
 */

const requireRole = vi.fn();
vi.mock("@/lib/auth/require-role", () => ({ requireRole }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
const deleteContactHandler = vi.fn(async () => ({ id: "c" }));
vi.mock("@/app/api/v1/contacts/_handler", () => ({
  deleteContactHandler,
  getContactHandler: vi.fn(),
  patchContactHandler: vi.fn(),
}));

const { DELETE, PATCH } = await import("@/app/api/v1/contacts/[id]/route");

beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
});

describe("DELETE /api/v1/contacts/[id]", () => {
  it("pede `manager`, e sem ele não chega ao handler", async () => {
    const res = await DELETE(new Request("http://x/api/v1/contacts/c") as never, {
      params: Promise.resolve({ id: "c" }),
    });
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "contacts" }));
    expect(deleteContactHandler).not.toHaveBeenCalled();
  });

  it("o PATCH continua no piso `agent` (editar não é apagar)", async () => {
    await PATCH(new Request("http://x/api/v1/contacts/c", { method: "PATCH", body: "{}" }) as never, {
      params: Promise.resolve({ id: "c" }),
    });
    expect(requireRole).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "contacts" }));
  });
});
