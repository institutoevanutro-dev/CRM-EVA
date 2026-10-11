import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O vigia de surdez DENTRO do cron: a regra pura está provada em
 * `lib/channels/vigia-de-surdez.test.ts`; aqui se prova a fiação. O que não
 * pode acontecer: reiniciar sem marcar (laço), pisar nas outras chaves de
 * `metadata`, auditar rodada que não fez nada, e abrir o aviso na mesma rodada
 * do reinício (ele seria fechado pelos eventos do próprio reinício).
 */
const SEGREDO = "segredo-de-cron-surdez";
const ORG = "org-1";
const MIN = 60_000;

vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: SEGREDO, INTERNAL_SECRET: "" } }));

const restart = vi.fn();
vi.mock("@/lib/channels", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels")>()),
  getAdapter: () => ({
    checkHealth: async () => ({ reachable: true, status: "WORKING", detail: null }),
    restart: (...a: unknown[]) => restart(...a),
  }),
  resolveSessionRef: () => "org_1_sessao",
}));
vi.mock("@/lib/channels/health", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels/health")>()),
  sincronizarSaudeDaConexao: async () => "sem_mudanca",
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
const audit = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));

const db: {
  sessao: Record<string, unknown>;
  entradas: Array<{ id: string }>;
  avisos: Array<Record<string, unknown>>;
  filtrosDeMensagem: Array<[string, unknown]>;
} = { sessao: {}, entradas: [], avisos: [], filtrosDeMensagem: [] };

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const cadeia: Record<string, unknown> = {};
      for (const m of ["select", "is"]) cadeia[m] = () => cadeia;
      for (const m of ["eq", "gt"]) {
        cadeia[m] = (coluna: string, valor: unknown) => {
          if (tabela === "messages") db.filtrosDeMensagem.push([coluna, valor]);
          return cadeia;
        };
      }
      cadeia.limit = async () =>
        tabela === "messages" ? { data: db.entradas, error: null } : { data: [db.sessao], error: null };
      cadeia.maybeSingle = async () => ({ data: { metadata: db.sessao.metadata }, error: null });
      cadeia.update = (patch: Record<string, unknown>) => {
        Object.assign(db.sessao, patch);
        return cadeia;
      };
      cadeia.insert = async (linha: Record<string, unknown>) => {
        db.avisos.push(linha);
        return { error: null };
      };
      // `await admin.from(...).update(...).eq(...)` — a cadeia é aguardável.
      cadeia.then = (resolve: (v: unknown) => void) => resolve({ error: null });
      return cadeia;
    },
  }),
}));

const ha = (ms: number) => new Date(Date.now() - ms).toISOString();

async function rodar() {
  const { GET } = await import("@/app/api/v1/cron/channel-health/route");
  const res = await GET({ headers: new Headers({ authorization: `Bearer ${SEGREDO}` }) } as never);
  return (await res.json()) as { data: Record<string, number> };
}

beforeEach(() => {
  vi.clearAllMocks();
  restart.mockResolvedValue({ status: "STARTING" });
  db.entradas = [];
  db.avisos = [];
  db.filtrosDeMensagem = [];
  db.sessao = {
    id: "s1", organization_id: ORG, status: "WORKING", status_reason: null,
    display_name: "Recepção", phone_number: "+5527999990000", archived_at: null,
    provider: "waha", waha_session_name: "org_1_sessao",
    last_status_change_at: ha(60 * MIN),
    metadata: { ai_gate: { ligado: true } },
  };
});

describe("cron channel-health × vigia de surdez", () => {
  it("surda: reinicia uma vez, marca sem pisar no metadata, audita, e NÃO avisa ainda", async () => {
    const { data } = await rodar();

    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith({ organizationId: ORG, sessionRef: "org_1_sessao" });
    expect(data.surdez_reiniciada).toBe(1);

    const metadata = db.sessao.metadata as Record<string, { reiniciado_em?: string }>;
    expect(metadata.ai_gate).toEqual({ ligado: true });
    expect(metadata.vigia_surdez.reiniciado_em).toMatch(/^\d{4}-/);

    // A consulta de mensagens leva a organização explícita (service role).
    expect(db.filtrosDeMensagem).toEqual(
      expect.arrayContaining([["organization_id", ORG], ["channel_session_id", "s1"], ["direction", "inbound"]]),
    );
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({
      action: "channel.reconnected", organizationId: ORG, resourceId: "s1",
      metadata: { origem: "vigia_de_surdez", force: false },
    });
    expect(db.avisos).toHaveLength(0);

    // Rodada seguinte, com a data intocada (o pior caso: nenhum evento chegou):
    // a trava segura, nada reinicia de novo.
    await rodar();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("rodada seguinte: abre UM aviso na Central, com o nome da conexão", async () => {
    db.sessao.last_status_change_at = ha(5 * MIN - 10_000);
    db.sessao.metadata = { ai_gate: { ligado: true }, vigia_surdez: { reiniciado_em: ha(5 * MIN) } };

    const { data } = await rodar();
    expect(data.surdez_avisada).toBe(1);
    expect(db.avisos).toHaveLength(1);
    expect(db.avisos[0]).toMatchObject({
      organization_id: ORG, kind: "channel_number_alert", severity: "warn",
      ref_kind: "channel_session", ref_id: "s1",
    });
    expect(db.avisos[0].title).toContain("Recepção");

    await rodar();
    expect(db.avisos).toHaveLength(1);
    expect(restart).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect((db.sessao.metadata as Record<string, unknown>).ai_gate).toEqual({ ligado: true });
  });

  it("entrou mensagem depois da queda: não reinicia, não marca, não audita", async () => {
    db.entradas = [{ id: "m1" }];
    await rodar();
    expect(restart).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(db.sessao.metadata).toEqual({ ai_gate: { ligado: true } });
  });

  it("fora da janela: nem consulta as mensagens", async () => {
    db.sessao.last_status_change_at = ha(10 * MIN);
    await rodar();
    expect(db.filtrosDeMensagem).toHaveLength(0);
    expect(restart).not.toHaveBeenCalled();
  });

  it("transporte recusou o reinício: marca a falha, não audita e não tenta de novo", async () => {
    restart.mockRejectedValue(new Error("waha_stop_500"));
    const { data } = await rodar();
    expect(data.surdez_reinicio_falhou).toBe(1);
    expect(audit).not.toHaveBeenCalled();
    expect((db.sessao.metadata as Record<string, { falhou?: boolean }>).vigia_surdez.falhou).toBe(true);

    await rodar();
    expect(restart).toHaveBeenCalledTimes(1);
  });
});
