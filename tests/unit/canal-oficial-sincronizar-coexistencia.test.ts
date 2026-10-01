import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/v1/channels/official/cadastro-incorporado/sincronizar — o "Tentar de
 * novo" da tela. A Meta aceita `smb_app_data` só nas 24 h após o onboarding, e
 * um pedido que já tem `request_id` não pode ser repetido (duplicaria a importação).
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const CANAL = "aaaaaaaa-0000-4000-8000-000000000001";
const PNID = "111222333";

const m = vi.hoisted(() => ({
  sincronizar: vi.fn(),
  sessao: vi.fn(),
  creds: vi.fn(),
  auditorias: [] as Array<Record<string, unknown>>,
  avisos: [] as Array<[string, Record<string, unknown>]>,
  consumidor: true,
}));

vi.mock("@/lib/channels/meta/coexistencia", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/channels/meta/coexistencia")>();
  return {
    ...real,
    get SINCRONIZACAO_TEM_CONSUMIDOR() {
      return m.consumidor;
    },
  };
});
vi.mock("@/lib/logger", () => ({
  logger: { warn: (msg: string, ctx: Record<string, unknown>) => void m.avisos.push([msg, ctx]), info: () => undefined, error: () => undefined, debug: () => undefined },
}));

vi.mock("@/lib/channels/meta/cadastro-incorporado", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/channels/meta/cadastro-incorporado")>()),
  pedirSincronizacao: m.sincronizar,
}));
vi.mock("@/lib/channels/meta/session", () => ({ metaSessionForOrg: m.sessao }));
vi.mock("@/lib/channels/meta/credentials", () => ({ resolveMetaCreds: m.creds }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { id: "u1", idioma: "pt-BR", is_platform_admin: false }, org: { orgId: ORG, role: "admin" } }),
}));
vi.mock("@/lib/audit", () => ({ audit: async (e: Record<string, unknown>) => void m.auditorias.push(e) }));

const db = { metadata: {} as Record<string, unknown>, updates: [] as Array<Record<string, unknown>> };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      let patch: Record<string, unknown> | null = null;
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: { metadata: structuredClone(db.metadata) }, error: null }),
        update: (p: Record<string, unknown>) => ((patch = p), q),
        then: (res: (v: unknown) => unknown) => {
          if (patch) {
            db.updates.push(patch);
            db.metadata = patch.metadata as Record<string, unknown>;
          }
          return Promise.resolve({ error: null }).then(res);
        },
      };
      return q;
    },
  }),
}));

import { POST } from "@/app/api/v1/channels/official/cadastro-incorporado/sincronizar/route";

const horasAtras = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const coexistencia = () => db.metadata.coexistencia as { pedidos: Record<string, unknown> };

beforeEach(() => {
  vi.clearAllMocks();
  m.sincronizar.mockReset();
  m.auditorias.length = 0;
  m.avisos.length = 0;
  m.consumidor = true;
  db.updates = [];
  m.sessao.mockResolvedValue({ id: CANAL, organizationId: ORG, wabaId: "222333444555", phoneNumberId: PNID });
  m.creds.mockResolvedValue({ phoneNumberId: PNID, token: "EAAX", graphVersion: "v23.0", source: "session" });
});

describe("POST /channels/official/cadastro-incorporado/sincronizar", () => {
  it("pedido que já tem request_id NÃO é repetido; o que faltou é pedido e gravado", async () => {
    db.metadata = { ai_gate: "allowlist", coexistencia: { onboarding_em: horasAtras(2), pedidos: { contatos: { request_id: "c-1" }, historico: null }, historico: null } };
    m.sincronizar.mockResolvedValueOnce({ request_id: "h-2" });

    const res = await POST();

    expect(res.status).toBe(200);
    expect(m.sincronizar).toHaveBeenCalledTimes(1);
    expect(m.sincronizar).toHaveBeenCalledWith("EAAX", PNID, "history");
    expect(coexistencia().pedidos).toEqual({ contatos: { request_id: "c-1" }, historico: { request_id: "h-2" } });
    expect(db.metadata.ai_gate).toBe("allowlist"); // mescla, não sobrescreve
    expect(m.auditorias[0]).toMatchObject({ action: "channel.official_sync_requested", resourceId: CANAL });
    expect(JSON.stringify(m.auditorias)).not.toContain("EAAX");
  });

  it("24 h depois do onboarding → 422 e pedirSincronizacao não é chamado", async () => {
    db.metadata = { coexistencia: { onboarding_em: horasAtras(25), pedidos: { contatos: { erro: "x" }, historico: { erro: "x" } }, historico: null } };
    const res = await POST();
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toContain("24 horas");
    expect(m.sincronizar).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
  });

  it("erro anterior é tentado de novo e o novo resultado é gravado", async () => {
    db.metadata = { coexistencia: { onboarding_em: horasAtras(1), pedidos: { contatos: { erro: "x" }, historico: { erro: "y" } }, historico: null } };
    m.sincronizar.mockResolvedValueOnce({ request_id: "c-9" }).mockResolvedValueOnce({ erro: "z" });

    const res = await POST();

    expect(res.status).toBe(200);
    expect(m.sincronizar.mock.calls.map((c) => c[2])).toEqual(["smb_app_state_sync", "history"]);
    expect(coexistencia().pedidos).toEqual({ contatos: { request_id: "c-9" }, historico: { erro: "z" } });
    expect((await res.json()).data.pedidos).toEqual({ contatos: { request_id: "c-9" }, historico: { erro: "z" } });
  });

  it("canal que não é de coexistência → 422; sem canal oficial → 404; credencial do .env não serve → 422", async () => {
    db.metadata = {};
    expect((await POST()).status).toBe(422);

    m.sessao.mockResolvedValueOnce(null);
    expect((await POST()).status).toBe(404);

    db.metadata = { coexistencia: { onboarding_em: horasAtras(1), pedidos: { contatos: null, historico: null }, historico: null } };
    m.creds.mockResolvedValueOnce({ phoneNumberId: PNID, token: "ENV", graphVersion: "v23.0", source: "env" });
    expect((await POST()).status).toBe(422);

    // decifra que lança (GUC ausente, banco fora) também é "sem credencial", não 500
    m.creds.mockRejectedValueOnce(new Error("decrypt failed"));
    const res = await POST();
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toBe("sem credencial da sessão");
    expect(m.sincronizar).not.toHaveBeenCalled();
    // a causa vai ao log (sem segredo), não some no `.catch`
    expect(JSON.stringify(m.avisos)).toContain("decrypt failed");
  });

  it("sem consumidor do webhook (SINCRONIZACAO_TEM_CONSUMIDOR=false): NÃO chama smb_app_data e grava pedidos nulos", async () => {
    m.consumidor = false;
    db.metadata = { coexistencia: { onboarding_em: horasAtras(1), pedidos: { contatos: { erro: "x" }, historico: { erro: "y" } }, historico: null } };
    const res = await POST();
    expect(res.status).toBe(200);
    expect(m.sincronizar).not.toHaveBeenCalled();
    expect(coexistencia().pedidos).toEqual({ contatos: null, historico: null });
  });
});
