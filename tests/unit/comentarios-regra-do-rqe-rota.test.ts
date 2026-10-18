/**
 * `GET`/`PUT /api/v1/comentarios/regra-do-rqe`: a chave "Médico sem RQE".
 *
 * O que estes testes protegem:
 *  1. Mudar é só do administrador. Quem não é recebe 403 do portão e nada
 *     chega ao banco; e o banco confere de novo: se a função recusa
 *     (administrador de outra organização, sessão sem MFA), a rota devolve 403
 *     e não audita.
 *  2. A escrita vai pela função, com a organização da SESSÃO e o booleano do
 *     corpo.
 *  3. Corpo que não é `{ ligada: boolean }` é 400 antes de qualquer banco.
 *  4. A leitura aplica a mesma régua da trava: só o booleano false desliga.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

const auditSpy = vi.fn(async (_arg: Record<string, unknown>) => undefined);
vi.mock("@/lib/audit", () => ({ audit: (arg: unknown) => auditSpy(arg as Record<string, unknown>) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const { GET, PUT } = await import("@/app/api/v1/comentarios/regra-do-rqe/route");

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const USUARIO = "dddddddd-0000-4000-8000-000000000001";

let settingsNoBanco: Record<string, unknown>;
let chamadasDeRpc: Array<{ nome: string; args: Record<string, unknown> }>;
let erroDaRpc: { code: string; message: string } | null;

beforeEach(() => {
  vi.clearAllMocks();
  settingsNoBanco = {};
  chamadasDeRpc = [];
  erroDaRpc = null;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG },
    user: { id: USUARIO, idioma: "pt-BR" },
  } as never);
  vi.mocked(createClient).mockResolvedValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { settings: settingsNoBanco }, error: null }),
        }),
      }),
    }),
    async rpc(nome: string, args: Record<string, unknown>) {
      chamadasDeRpc.push({ nome, args });
      return { data: null, error: erroDaRpc };
    },
  } as never);
});

function pedido(corpo: string): NextRequest {
  return new NextRequest("http://localhost/api/v1/comentarios/regra-do-rqe", {
    method: "PUT",
    body: corpo,
    headers: { "content-type": "application/json" },
  });
}

describe("PUT", () => {
  it("administrador desliga: 200, a função recebe a organização da sessão e o booleano, e a trilha registra", async () => {
    const res = await PUT(pedido(JSON.stringify({ ligada: false })));

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ ligada: false });
    expect(chamadasDeRpc).toEqual([
      { nome: "fn_definir_medico_sem_rqe", args: { p_organization_id: ORG, p_ligada: false } },
    ]);
    expect(auditSpy.mock.calls[0]![0]).toMatchObject({
      action: "comment.regra_do_rqe_alterada",
      organizationId: ORG,
      actorUserId: USUARIO,
      resourceType: "organization",
      resourceId: ORG,
      metadata: { ligada: false },
    });
  });

  it("mudar exige admin", async () => {
    await PUT(pedido(JSON.stringify({ ligada: true })));
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("admin");
  });

  it("agent: 403 do portão, e nada chega ao banco nem à trilha", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Sem permissão.", 403),
    } as never);

    const res = await PUT(pedido(JSON.stringify({ ligada: false })));

    expect(res.status).toBe(403);
    expect(chamadasDeRpc).toEqual([]);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("administrador de OUTRA organização: a função recusa (42501) e a rota devolve 403, sem auditar", async () => {
    erroDaRpc = { code: "42501", message: "medico_sem_rqe_forbidden" };

    const res = await PUT(pedido(JSON.stringify({ ligada: false })));

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_role");
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("sessão sem MFA provada: 403 mfa_required, sem auditar", async () => {
    erroDaRpc = { code: "42501", message: "medico_sem_rqe_mfa_required" };

    const res = await PUT(pedido(JSON.stringify({ ligada: false })));

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("mfa_required");
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["ligada como texto", JSON.stringify({ ligada: "false" })],
    ["sem ligada", JSON.stringify({})],
    ["ligada nula", JSON.stringify({ ligada: null })],
    ["corpo que não é JSON", "desligar"],
  ])("corpo inválido (%s): 400, sem chamar o banco", async (_caso, corpo) => {
    const res = await PUT(pedido(corpo));

    expect(res.status).toBe(400);
    expect(chamadasDeRpc).toEqual([]);
    expect(auditSpy).not.toHaveBeenCalled();
  });
});

describe("GET", () => {
  it.each<[string, Record<string, unknown>, boolean]>([
    ["organização que nunca mexeu: ligada", {}, true],
    ["desligada", { medico_sem_rqe: false }, false],
    ["ligada", { medico_sem_rqe: true }, true],
    ['com a string "false": ligada', { medico_sem_rqe: "false" }, true],
  ])("%s", async (_caso, settings, ligada) => {
    settingsNoBanco = settings;

    const corpo = await (await GET()).json();

    expect(corpo.data).toEqual({ ligada });
  });

  it("ler exige agent", async () => {
    await GET();
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("agent");
  });
});
