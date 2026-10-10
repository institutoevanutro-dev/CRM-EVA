import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { loadAuthUser, mfaEmDivida } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

import { POST } from "./route";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), mfaEmDivida: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const org = "11111111-1111-4111-8111-111111111111";
const contato = "22222222-2222-4222-8222-222222222222";
const outro = "33333333-3333-4333-8333-333333333333";
const contagens = { conversations_closed: 1, lead_state: 2, send_ledger: 3 };

let telefone: string | null;
let canais: { metadata: Record<string, unknown> }[];
let rpc: ReturnType<typeof vi.fn>;
let tabelas: string[];

const ctx = (id = contato) => ({ params: Promise.resolve({ id }) });
const req = () => new NextRequest("http://localhost/x", { method: "POST" });
const canal = (numeros: string[], modo = "pre_go_live") => ({
  metadata: { ai_gate: "allowlist", ai_gate_mode: modo, ai_test_phone_numbers: numeros },
});

beforeEach(() => {
  vi.clearAllMocks();
  telefone = "+5541999953255";
  canais = [canal(["+5541999953255"])];
  tabelas = [];
  rpc = vi.fn().mockResolvedValue({ data: contagens, error: null });
  vi.mocked(loadAuthUser).mockResolvedValue(null);
  vi.mocked(mfaEmDivida).mockResolvedValue(false);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1" },
    org: { orgId: org, role: "manager" },
  } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => {
      tabelas.push(tabela);
      const f: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          f[k] = v;
          return q;
        },
        maybeSingle: async () => ({
          data: f.id === contato && f.organization_id === org ? { id: contato, phone_number: telefone } : null,
          error: null,
        }),
        then: (res: (v: unknown) => unknown) =>
          res({ data: f.organization_id === org ? canais : [], error: null }),
      };
      return q;
    },
    rpc,
  } as unknown as ReturnType<typeof createAdminClient>);
});

describe("reiniciar teste do contato", () => {
  it("exige manager e nega sem tocar o banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden", "x", 403) });
    expect((await POST(req(), ctx())).status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "contacts" }));
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("suporte readonly nega antes do banco", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({
      id: org,
      is_platform_admin: true,
      support: { organization_id: org, status: "active", access_mode: "support_readonly" },
    } as Awaited<ReturnType<typeof loadAuthUser>>);
    expect((await POST(req(), ctx())).status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("contato de outra org: 404", async () => {
    expect((await POST(req(), ctx(outro))).status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("telefone fora da lista: 422 sem chamar a RPC", async () => {
    telefone = "+5511988887777";
    const r = await POST(req(), ctx());
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("contato_nao_e_de_teste");
    expect(rpc).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("lista só vale em canal pre_go_live", async () => {
    canais = [canal(["+5541999953255"], "allowlist")];
    expect((await POST(req(), ctx())).status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([["+5541999953255"], ["+554199953255"]])("número de teste %s: chama a RPC, audita e responde 200", async (tel) => {
    telefone = tel;
    const r = await POST(req(), ctx());
    expect(r.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_reiniciar_teste_do_contato", { p_org: org, p_contact: contato });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.teste_reiniciado",
        organizationId: org,
        resourceId: contato,
        metadata: expect.objectContaining(contagens),
      }),
    );
    const corpo = JSON.stringify(await r.json());
    expect(corpo).not.toContain("5541999953255");
    expect(corpo).not.toContain("ai_test_phone_numbers");
  });

  it("erro da RPC: 500 sem audit", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect((await POST(req(), ctx())).status).toBe(500);
    expect(audit).not.toHaveBeenCalled();
  });

  it("corrida: RPC recusa com contato_nao_e_de_teste vira 422", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "contato_nao_e_de_teste", code: "P0001" } });
    expect((await POST(req(), ctx())).status).toBe(422);
    expect(audit).not.toHaveBeenCalled();
  });
});
