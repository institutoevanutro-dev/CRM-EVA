import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Desconexão pelo celular (coexistência) é um estado que a sonda não enxerga: a
 * Graph pode seguir respondendo 200 ao número. Sem a guarda, a varredura devolvia
 * `WORKING` em ≤1 min e desfazia o `FAILED` — o aviso ficava, a faixa sumia.
 */
const SEGREDO = "segredo-de-cron-coex";
const ORG = "org-1";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: SEGREDO, INTERNAL_SECRET: "" } }));

const checkHealth = vi.fn();
vi.mock("@/lib/channels", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels")>()),
  getAdapter: () => ({ checkHealth: (...a: unknown[]) => checkHealth(...a) }),
  resolveSessionRef: () => "111222333",
}));

const sincronizar = vi.fn();
vi.mock("@/lib/channels/health", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels/health")>()),
  sincronizarSaudeDaConexao: (...a: unknown[]) => {
    sincronizar(...a);
    return Promise.resolve("sem_mudanca");
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const db: { sessoes: Array<Record<string, unknown>>; updates: Array<{ patch: Record<string, unknown> }> } = { sessoes: [], updates: [] };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const cadeia: Record<string, unknown> = {};
      for (const m of ["select", "is", "eq"]) cadeia[m] = () => cadeia;
      cadeia.update = (patch: Record<string, unknown>) => {
        db.updates.push({ patch });
        return cadeia;
      };
      cadeia.limit = async () => ({ data: db.sessoes, error: null });
      return cadeia;
    },
  }),
}));

const SESSAO_CAIDA = {
  id: "s1", organization_id: ORG, status: "FAILED", status_reason: "coexistencia_desconectada",
  display_name: "Clínica", phone_number: "+5527999049879", archived_at: null, provider: "meta_cloud", meta_phone_number_id: "111222333",
};

async function rodar() {
  const { GET } = await import("@/app/api/v1/cron/channel-health/route");
  return GET({ headers: new Headers({ authorization: `Bearer ${SEGREDO}` }) } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  db.updates = [];
});

describe("cron channel-health e a desconexão pelo celular", () => {
  it("sonda WORKING numa sessão FAILED por desconexão no app NÃO promove: só account_reconnected tira dali", async () => {
    db.sessoes = [SESSAO_CAIDA];
    checkHealth.mockResolvedValue({ reachable: true, status: "WORKING", detail: null });
    await rodar();
    expect(db.updates.filter((u) => "status" in u.patch)).toHaveLength(0);
    expect(sincronizar).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "s1", status: "FAILED" }), expect.anything(), "Clínica");
  });

  it("FAILED por OUTRO motivo continua sendo promovido pela sonda (comportamento de hoje)", async () => {
    db.sessoes = [{ ...SESSAO_CAIDA, status_reason: "token_vencido" }];
    checkHealth.mockResolvedValue({ reachable: true, status: "WORKING", detail: null });
    await rodar();
    expect(db.updates.at(-1)?.patch).toMatchObject({ status: "WORKING" });
  });
});
