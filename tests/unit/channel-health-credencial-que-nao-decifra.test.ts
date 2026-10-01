import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Credencial da SESSÃO que não decifra (chave mestra trocada, GUC ausente):
 * `resolveMetaCreds` lança `meta_creds_decrypt_failed`. O `checkHealth` chamava
 * isso fora do `try`, o cron caía no `catch` da iteração e só logava — o canal
 * ficava mudo, sem aviso na Central. Agora a sonda devolve FAILED com detalhe
 * próprio, e o cron abre o aviso como em qualquer queda.
 */
const SEGREDO = "segredo-de-cron-decifra";
const ORG = "00000000-0000-4000-8000-000000000296";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: SEGREDO, INTERNAL_SECRET: "" } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const metaCreds = vi.fn();
vi.mock("@/lib/channels/meta/credentials", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveMetaCreds: (...a: unknown[]) => metaCreds(...a),
}));

const sincronizar = vi.fn();
vi.mock("@/lib/channels/health", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels/health")>()),
  sincronizarSaudeDaConexao: (...a: unknown[]) => {
    sincronizar(...a);
    return Promise.resolve("avisou");
  },
}));

const db = { sessoes: [] as Array<Record<string, unknown>> };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const cadeia: Record<string, unknown> = {};
      for (const m of ["select", "is", "eq", "update"]) cadeia[m] = () => cadeia;
      cadeia.limit = async () => ({ data: db.sessoes, error: null });
      cadeia.then = (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res);
      return cadeia;
    },
  }),
}));

const SESSAO = {
  id: "s1", organization_id: ORG, status: "WORKING", status_reason: null, display_name: "Clínica",
  phone_number: "+5527999049879", archived_at: null, provider: "meta_cloud", meta_phone_number_id: "111222333",
};

beforeEach(() => {
  vi.clearAllMocks();
  metaCreds.mockRejectedValue(new Error("meta_creds_decrypt_failed: a credencial da sessão não decifrou; o .env não é usado"));
});

describe("credencial da sessão que não decifra", () => {
  it("checkHealth devolve FAILED com detalhe próprio, sem chamar a Graph", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { metaCloudAdapter } = await import("@/lib/channels/adapters/meta-cloud");
    const r = await metaCloudAdapter.checkHealth!({ organizationId: ORG, sessionRef: "111222333" });
    expect(r).toEqual({ reachable: true, status: "FAILED", detail: "credencial_da_sessao_nao_decifra" });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("outra falha de leitura (lookup) continua lançando — só a decifra vira FAILED", async () => {
    metaCreds.mockRejectedValueOnce(new Error("meta_creds_lookup_failed: 57014 timeout"));
    const { metaCloudAdapter } = await import("@/lib/channels/adapters/meta-cloud");
    await expect(metaCloudAdapter.checkHealth!({ organizationId: ORG, sessionRef: "111222333" })).rejects.toThrow(/lookup_failed/);
  });

  it("o cron leva o FAILED ao aviso (crítico) em vez de só logar", async () => {
    db.sessoes = [SESSAO];
    const { GET } = await import("@/app/api/v1/cron/channel-health/route");
    await GET({ headers: new Headers({ authorization: `Bearer ${SEGREDO}` }) } as never);
    expect(sincronizar).toHaveBeenCalledTimes(1);
    const saude = sincronizar.mock.calls[0]![2] as { reachable: boolean; status: string | null; detail: string | null };
    expect(saude).toMatchObject({ status: "FAILED", detail: "credencial_da_sessao_nao_decifra" });
    const { avisoDaConexao } = await import("@/lib/channels/health");
    expect(avisoDaConexao(saude, "Clínica", "meta_cloud")).toMatchObject({ severity: "critical", kind: "channel_number_alert" });
  });
});
