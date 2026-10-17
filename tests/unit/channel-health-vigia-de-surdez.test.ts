import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O vigia de surdez DENTRO do cron: a regra pura está provada em
 * `lib/channels/vigia-de-surdez.test.ts`; aqui se prova a fiação. O que não
 * pode acontecer: reiniciar sem a trava (laço, ou duas rodadas reiniciando a
 * mesma sessão), pisar nas outras chaves de `metadata`, reiniciar por cima de
 * uma pessoa conectando ou de uma atualização, auditar rodada que não fez nada,
 * e abrir o aviso na mesma rodada do reinício (ele seria fechado pelos eventos
 * do próprio reinício).
 */
const SEGREDO = "segredo-de-cron-surdez";
const ORG = "org-1";
const MIN = 60_000;
const CAMINHO_DA_FICHA = "metadata->vigia_surdez->>versao";

const ambiente = vi.hoisted(() => ({
  INTERNAL_CRON_SECRET: "segredo-de-cron-surdez",
  INTERNAL_SECRET: "",
  CHANNEL_DEAF_RESTART_MAX: "",
  CHANNEL_DEAF_RESTART_WINDOW_HOURS: "",
}));
vi.mock("@/lib/env", () => ({ env: ambiente }));

const saude = vi.hoisted(() => ({ atual: { reachable: true, status: "WORKING", detail: null as string | null } }));
const restart = vi.fn();
vi.mock("@/lib/channels", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels")>()),
  getAdapter: () => ({
    checkHealth: async () => saude.atual,
    restart: (...a: unknown[]) => restart(...a),
  }),
  resolveSessionRef: () => "org_1_sessao",
}));
vi.mock("@/lib/channels/health", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels/health")>()),
  sincronizarSaudeDaConexao: async () => "sem_mudanca",
}));
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger }));
const audit = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));

type Filtro = [op: string, coluna: string, valor: unknown];
const db: {
  sessao: Record<string, unknown>;
  entradas: Array<{ created_at: string }>;
  erroNasMensagens: { message: string } | null;
  avisos: Array<Record<string, unknown>>;
  resolucoes: Filtro[][];
  filtrosDeMensagem: Filtro[];
  conexao: { id: string; lease_until: string } | null;
  atualizacoes: Array<{ id: string }>;
  /** Outra rodada grava entre a nossa leitura e a nossa escrita. */
  antesDaTrava: (() => void) | null;
} = {
  sessao: {}, entradas: [], erroNasMensagens: null, avisos: [], resolucoes: [], filtrosDeMensagem: [],
  conexao: null, atualizacoes: [], antesDaTrava: null,
};

const vigia = () => (db.sessao.metadata as Record<string, Record<string, unknown> | undefined>)?.vigia_surdez;

/** A trava como o Postgres a aplica: o UPDATE só pega a linha se a ficha bate. */
function fichaBate(filtros: Filtro[]): boolean {
  const atual = vigia()?.versao;
  return filtros
    .filter(([, coluna]) => coluna === CAMINHO_DA_FICHA)
    .every(([op, , valor]) => (op === "is" ? atual === undefined || atual === null : String(atual) === valor));
}

function responder(tabela: string, op: string, patch: unknown, filtros: Filtro[], unico: boolean) {
  if (tabela === "channel_sessions") {
    if (op === "update") {
      const comTrava = filtros.some(([, c]) => c === CAMINHO_DA_FICHA);
      if (comTrava && db.antesDaTrava) {
        db.antesDaTrava();
        db.antesDaTrava = null;
      }
      if (!fichaBate(filtros)) return { data: [], error: null };
      Object.assign(db.sessao, patch);
      return { data: [{ id: db.sessao.id }], error: null };
    }
    return unico ? { data: { metadata: db.sessao.metadata }, error: null } : { data: [db.sessao], error: null };
  }
  if (tabela === "messages") return { data: db.erroNasMensagens ? null : db.entradas, error: db.erroNasMensagens };
  if (tabela === "agent_inbox_items") {
    if (op === "insert") db.avisos.push(patch as Record<string, unknown>);
    if (op === "update") db.resolucoes.push(filtros);
    return { data: null, error: null };
  }
  if (tabela === "channel_connection_requests") return { data: db.conexao, error: null };
  if (tabela === "system_update_runs") return { data: db.atualizacoes, error: null };
  if (tabela === "organizations") return { data: { timezone: "America/Sao_Paulo", locale: "pt-BR" }, error: null };
  return { data: null, error: null };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      let op = "select";
      let patch: unknown = null;
      const filtros: Filtro[] = [];
      const cadeia: Record<string, unknown> = {};
      cadeia.select = () => cadeia;
      cadeia.update = (p: unknown) => ((op = "update"), (patch = p), cadeia);
      cadeia.insert = async (p: unknown) => responder(tabela, "insert", p, filtros, false);
      for (const f of ["eq", "is", "gt", "in"]) {
        cadeia[f] = (coluna: string, valor: unknown) => {
          filtros.push([f, coluna, valor]);
          if (tabela === "messages") db.filtrosDeMensagem.push([f, coluna, valor]);
          return cadeia;
        };
      }
      cadeia.order = () => cadeia;
      cadeia.limit = () => cadeia;
      cadeia.maybeSingle = async () => responder(tabela, op, patch, filtros, true);
      cadeia.then = (ok: (v: unknown) => void, erro: (e: unknown) => void) =>
        Promise.resolve(responder(tabela, op, patch, filtros, false)).then(ok, erro);
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
  saude.atual = { reachable: true, status: "WORKING", detail: null };
  ambiente.CHANNEL_DEAF_RESTART_MAX = "";
  Object.assign(db, {
    entradas: [], erroNasMensagens: null, avisos: [], resolucoes: [], filtrosDeMensagem: [],
    conexao: null, atualizacoes: [], antesDaTrava: null,
  });
  db.sessao = {
    id: "s1", organization_id: ORG, status: "WORKING", status_reason: null,
    display_name: "Recepção", phone_number: "+5500000000000", archived_at: null,
    provider: "waha", waha_session_name: "org_1_sessao",
    last_status_change_at: ha(60 * MIN),
    metadata: { ai_gate: { ligado: true } },
  };
});

describe("cron channel-health × vigia de surdez", () => {
  it("surda: reinicia pela trava, sem pisar no metadata, audita como sistema, e NÃO avisa ainda", async () => {
    const { data } = await rodar();

    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith({ organizationId: ORG, sessionRef: "org_1_sessao" });
    expect(data.surdez_reiniciada).toBe(1);

    const metadata = db.sessao.metadata as Record<string, unknown>;
    expect(metadata.ai_gate).toEqual({ ligado: true });
    expect(vigia()).toMatchObject({ versao: 1, queda_em: db.sessao.last_status_change_at });
    expect(vigia()?.reinicios).toHaveLength(1);

    // A consulta de mensagens leva a organização explícita (service role).
    expect(db.filtrosDeMensagem).toEqual(
      expect.arrayContaining([["eq", "organization_id", ORG], ["eq", "channel_session_id", "s1"], ["eq", "direction", "inbound"]]),
    );
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]?.[0]).toMatchObject({
      action: "channel.reconnected", organizationId: ORG, resourceId: "s1",
      metadata: { origem: "vigia_de_surdez", force: false, tentativa: 1, reiniciou: true },
    });
    expect(audit.mock.calls[0]?.[0]).not.toHaveProperty("actorUserId");
    expect(logger.info).toHaveBeenCalledWith(
      "[channel-health] reinício automático de conexão surda",
      expect.objectContaining({ sessionId: "s1", tentativa: 1, reiniciou: true }),
    );
    expect(db.avisos).toHaveLength(0);

    // Rodada seguinte, com a data intocada (o pior caso: nenhum evento chegou):
    // o relógio agora conta do reinício, nada reinicia de novo.
    await rodar();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("rodada seguinte: abre UM aviso na Central, com o nome da conexão e a hora", async () => {
    db.sessao.last_status_change_at = ha(5 * MIN - 10_000);
    db.sessao.metadata = {
      ai_gate: { ligado: true },
      vigia_surdez: { versao: 1, reiniciado_em: ha(5 * MIN), reinicios: [ha(5 * MIN)], queda_em: ha(60 * MIN) },
    };

    const { data } = await rodar();
    expect(data.surdez_avisada).toBe(1);
    expect(db.avisos).toHaveLength(1);
    expect(db.avisos[0]).toMatchObject({
      organization_id: ORG, kind: "channel_number_alert", severity: "warn",
      ref_kind: "channel_session", ref_id: "s1",
    });
    expect(db.avisos[0]?.title).toBe('WhatsApp "Recepção" ficou sem receber mensagens depois de uma queda');
    expect(db.avisos[0]?.body).toMatch(/^O CRM reiniciou a conexão sozinho às \d\d:\d\d/);
    expect(vigia()?.avisado_em).toBeTruthy();

    await rodar();
    expect(db.avisos).toHaveLength(1);
    expect(restart).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect((db.sessao.metadata as Record<string, unknown>).ai_gate).toEqual({ ligado: true });
  });

  it("não resolveu: tenta de novo 45 min depois; no teto desiste e chama gente, uma vez", async () => {
    db.sessao.last_status_change_at = ha(50 * MIN - 20_000);
    db.sessao.metadata = {
      vigia_surdez: { versao: 2, reiniciado_em: ha(50 * MIN), reinicios: [ha(50 * MIN)], queda_em: ha(2 * 60 * MIN), avisado_em: ha(45 * MIN) },
    };
    const primeira = await rodar();
    expect(primeira.data.surdez_reiniciada).toBe(1);
    expect(audit.mock.calls[0]?.[0]).toMatchObject({ metadata: { tentativa: 2 } });
    expect(vigia()?.reinicios).toHaveLength(2);
    expect(vigia()?.versao).toBe(3);

    // 50 min depois do segundo, nada ainda: sem tentativa sobrando.
    db.sessao.metadata = {
      vigia_surdez: { versao: 4, reiniciado_em: ha(50 * MIN), reinicios: [ha(100 * MIN), ha(50 * MIN)], queda_em: ha(2 * 60 * MIN), avisado_em: ha(45 * MIN) },
    };
    restart.mockClear();
    audit.mockClear();
    const segunda = await rodar();
    expect(segunda.data.surdez_escalada).toBe(1);
    expect(restart).not.toHaveBeenCalled();
    expect(db.avisos).toHaveLength(1);
    expect(db.avisos[0]).toMatchObject({ kind: "channel_number_alert", severity: "critical", ref_id: "s1" });
    expect(db.avisos[0]?.title).toBe('WhatsApp "Recepção" continua sem receber mensagens');
    expect(vigia()?.desfecho).toBe("escalado");
    // Escalar não é mutação de recurso do tenant: o aviso é o rastro.
    expect(audit).not.toHaveBeenCalled();

    await rodar();
    expect(db.avisos).toHaveLength(1);
  });

  it("voltou: fecha os avisos da sessão e abre o da volta, sem reiniciar nem auditar", async () => {
    db.sessao.last_status_change_at = ha(10 * MIN - 20_000);
    db.sessao.metadata = {
      vigia_surdez: { versao: 2, reiniciado_em: ha(10 * MIN), reinicios: [ha(10 * MIN)], queda_em: ha(2 * 60 * MIN), avisado_em: ha(5 * MIN) },
    };
    db.entradas = [{ created_at: ha(3 * MIN) }];

    const { data } = await rodar();
    expect(data.surdez_voltou).toBe(1);
    expect(restart).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(db.resolucoes).toHaveLength(1);
    expect(db.resolucoes[0]).toEqual(
      expect.arrayContaining([["eq", "organization_id", ORG], ["eq", "ref_kind", "channel_session"], ["eq", "ref_id", "s1"], ["eq", "status", "open"]]),
    );
    expect(db.avisos).toHaveLength(1);
    expect(db.avisos[0]?.title).toBe('WhatsApp "Recepção" voltou a receber mensagens');
    expect(db.avisos[0]?.body).toMatch(/celular/);
    expect(vigia()?.desfecho).toBe("voltou");

    await rodar();
    expect(db.avisos).toHaveLength(1);
  });

  it("entrou mensagem depois da queda: não reinicia, não marca, não audita", async () => {
    db.entradas = [{ created_at: ha(30 * MIN) }];
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

  it("não deu para consultar as mensagens: na dúvida não reinicia nem diz que voltou", async () => {
    db.erroNasMensagens = { message: "timeout" };
    await rodar();
    expect(restart).not.toHaveBeenCalled();
    expect(db.avisos).toHaveLength(0);
    expect(db.sessao.metadata).toEqual({ ai_gate: { ligado: true } });
  });

  it("transporte recusou o reinício: marca a falha, audita a tentativa, e não repete na rodada seguinte", async () => {
    restart.mockRejectedValue(new Error("waha_restart_500"));
    const { data } = await rodar();
    expect(data.surdez_reinicio_falhou).toBe(1);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]?.[0]).toMatchObject({ metadata: { origem: "vigia_de_surdez", reiniciou: false } });
    expect(vigia()?.falhou).toBe(true);

    await rodar();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("não está WORKING (QR pendente, caída): nada", async () => {
    for (const status of ["SCAN_QR_CODE", "STARTING", "FAILED"]) {
      saude.atual = { reachable: true, status, detail: null };
      db.sessao.status = status;
      await rodar();
    }
    expect(restart).not.toHaveBeenCalled();
    expect(db.filtrosDeMensagem).toHaveLength(0);
  });

  it("alguém conectando a sessão agora (QR, pareamento): não reinicia por cima, nem marca", async () => {
    db.conexao = { id: "req-1", lease_until: new Date(Date.now() + 60_000).toISOString() };
    const { data } = await rodar();
    expect(data.surdez_conexao_em_andamento).toBe(1);
    expect(restart).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(db.sessao.metadata).toEqual({ ai_gate: { ligado: true } });
  });

  it("atualização da instalação em andamento: não reinicia", async () => {
    db.atualizacoes = [{ id: "run-1" }];
    const { data } = await rodar();
    expect(data.surdez_atualizacao_em_andamento).toBe(1);
    expect(restart).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("rodada concorrente: quem perde a trava não reinicia nem audita", async () => {
    // Outra rodada gravou a marca entre a nossa leitura e a nossa escrita.
    db.antesDaTrava = () => {
      db.sessao.metadata = { ai_gate: { ligado: true }, vigia_surdez: { versao: 1, reiniciado_em: ha(0), reinicios: [ha(0)] } };
    };
    const { data } = await rodar();
    expect(data.surdez_concorrente).toBe(1);
    expect(restart).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("teto 0 no .env: não reinicia, só avisa (e uma vez)", async () => {
    ambiente.CHANNEL_DEAF_RESTART_MAX = "0";
    const { data } = await rodar();
    expect(data.surdez_escalada).toBe(1);
    expect(restart).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(db.avisos[0]?.body).toMatch(/desligado/);

    await rodar();
    expect(db.avisos).toHaveLength(1);
  });
});
