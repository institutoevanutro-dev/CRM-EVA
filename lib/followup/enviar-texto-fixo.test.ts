/**
 * R1 — o envio INLINE de texto fixo do follow-up (`enviarTextoFixoPendente`, o
 * atalho "sem cron e sem agent-worker") BYPASSA `executarTurnoDoAgente`, então
 * precisa do gate de elegibilidade por conta própria. Sem isto, um fluxo de
 * follow-up com nó de texto fixo mandaria mensagem para uma conversa que o gate
 * `allowlist` barra.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Bloqueios from "@/lib/followup/bloqueios-obrigatorios";

const sendMessageHandler = vi.fn(async (..._a: unknown[]) => ({ id: "msg-1",status:"sent" }));
const decidir = vi.fn();
const completeTurnForEnrollment = vi.fn(async (..._a: unknown[]) => {});

vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: (...a: unknown[]) => sendMessageHandler(...a) }));
vi.mock("@/lib/automation/start-conversation", () => ({
  ensureConversation: async () => "conv-1",
  sessaoProntaParaEnvio: async () => "sess-1",
}));
vi.mock("@/lib/ai/elegibilidade/consulta-supabase", () => ({
  decidirElegibilidadeDaConversaViaSupabase: (...a: unknown[]) => decidir(...a),
}));
vi.mock("@/lib/followup/turn-bridge", () => ({
  completeTurnForEnrollment: (...a: unknown[]) => completeTurnForEnrollment(...a),
}));
vi.mock("@/lib/followup/engine", () => ({ createSupabaseAdminClient: () => ({}) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// A decisão de envio é a MESMA do worker (`conferirAntesDoEnvio`); aqui ela é
// controlada, e os textos/desfechos são os reais.
const conferir = vi.fn();
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/followup/bloqueios-obrigatorios", async (importOriginal) => ({
  ...(await importOriginal<typeof Bloqueios>()),
  conferirAntesDoEnvio: (...a: unknown[]) => conferir(...a),
}));
const adiarAteAJanelaAbrir = vi.fn();
vi.mock("@/lib/automation/janela-do-canal", () => ({
  adiarAteAJanelaAbrir: (...a: unknown[]) => adiarAteAJanelaAbrir(...a),
}));
const espacarEnvio = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@/lib/automation/throttle", () => ({ espacarEnvio: (...a: unknown[]) => espacarEnvio(...a) }));

import { enviarTextoFixoPendente } from "./enviar-texto-fixo";
import { CHANNEL_PROVIDER_INSTAGRAM } from "@/lib/channels/capabilities";
import { TEXTO_DO_BLOQUEIO } from "@/lib/followup/bloqueios-obrigatorios";

/** A conversa do follow-up, como o banco a devolve (canal + última mensagem do cliente). */
let conversa: Record<string, unknown> | null = null;
/** O contato do job, como `contacts` o devolve (nome escolhido + nome do perfil). */
let contato: Record<string, unknown> | null = null;

const boundary = { organization_id: "org-1", contact_id: "contact-1", conversation_id: "conv-1", service_revision: 1, demanda_id: null, demanda_revision: null };
const JOB = {
  id: "job-1",
  organization_id: "org-1",
  contact_id: "contact-1",
  payload: { service_boundary: boundary, fixed_body: "Oi, tudo bem?", followup_enrollment_id: "enr-1", node_id: "node-1" },
};

const statusUpdates: string[] = [];
/** Os argumentos de cada `fn_followup_inline_settle`, na ordem. */
const settles: Array<Record<string, unknown>> = [];

/** Admin stub: job_queue (select pending / claim / status) + followup_enrollments. */
function admin() {
  const make = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      _table: table,
      _upd: null as Record<string, unknown> | null,
      select: () => chain,
      eq: () => chain,
      lte: () => chain,
      in: () => chain,
      single: () => Promise.resolve({data:table==="send_ledger"?{id:"ledger-1"}:{settings:{}},error:null}),
      insert: () => chain,
      order: () => chain,
      limit: () => chain,
      update: (p: Record<string, unknown>) => {
        chain._upd = p;
        if (table === "job_queue" && typeof p.status === "string") statusUpdates.push(p.status);
        return chain;
      },
      maybeSingle: () => {
        if (table === "job_queue" && chain._upd) return Promise.resolve({ data: { id: JOB.id, locked_by:chain._upd.locked_by, locked_at:chain._upd.locked_at }, error: null });
        if (table === "conversations") return Promise.resolve({ data: conversa, error: null });
        if (table === "contacts") return Promise.resolve({ data: contato, error: null });
        if (table === "followup_enrollments")
          return Promise.resolve({ data: { current_node_id: "node-1",status:"active",revision:1 }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then: (r: (v: unknown) => unknown) => {
        if (table === "job_queue" && !chain._upd) {
          return Promise.resolve({ data: [JOB], error: null }).then(r);
        }
        return Promise.resolve({ data: null, error: null }).then(r);
      },
    };
    return chain;
  };
  return { from: (t: string) => make(t), rpc: async (name:string,args:Record<string,unknown>) => {
    if(name==="fn_followup_inline_settle") {statusUpdates.push(args.p_done?"done":"pending");settles.push(args);return {data:true,error:null};}
    if(name==="fn_appointment_enrollment_current" || name==="fn_followup_job_current") return {data:true,error:null};
    return {data:{...boundary,status:"open",demanda_fechada_em:null},error:null};
  }} as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  statusUpdates.length = 0;
  settles.length = 0;
  conversa = { last_inbound_at: null, channel_session_id: "sess-1", channel_sessions: { provider: null } };
  contato = { name: null, display_name: null };
  JOB.payload.fixed_body = "Oi, tudo bem?";
  conferir.mockResolvedValue({ envia: true });
  adiarAteAJanelaAbrir.mockResolvedValue(null);
});

describe("enviarTextoFixoPendente · gate de elegibilidade", () => {
  it("conversa NÃO elegível → NÃO envia, job vira 'done'", async () => {
    decidir.mockResolvedValue({ permite: false, motivo: "sem_autorizacao", bloqueioPorAllowlist: true });
    const enviados = await enviarTextoFixoPendente(admin());
    expect(enviados).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(statusUpdates).toContain("done");
  });

  it("conversa elegível → envia normalmente", async () => {
    decidir.mockResolvedValue({ permite: true, motivo: "autorizado", bloqueioPorAllowlist: false });
    const enviados = await enviarTextoFixoPendente(admin());
    expect(enviados).toBe(1);
    expect(sendMessageHandler).toHaveBeenCalledOnce();
    // A marca que deixa o follow-up sair no Instagram dentro das 24h.
    expect(sendMessageHandler.mock.calls[0]?.[1]).toMatchObject({ origemDoEnvio: "followup" });
  });

  it("erro ao ler elegibilidade → NÃO envia, job volta pra 'pending' (fail-closed)", async () => {
    decidir.mockRejectedValue(new Error("db down"));
    const enviados = await enviarTextoFixoPendente(admin());
    expect(enviados).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(statusUpdates).toContain("pending");
  });
});

it.each(["queued","failed"])("%s não conta envio nem avança o fluxo",async status=>{
 decidir.mockResolvedValue({permite:true});sendMessageHandler.mockResolvedValueOnce({id:"msg-1",status});
 expect(await enviarTextoFixoPendente(admin())).toBe(0);
 expect(completeTurnForEnrollment).not.toHaveBeenCalled();expect(statusUpdates).toContain("pending");
});

describe("enviarTextoFixoPendente · 24h do Instagram", () => {
  const RAZAO = "Passo pulado: fora das 24h do Instagram.";
  const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  it("a elegibilidade é pedida como follow-up (o silêncio de roteamento não conta)", async () => {
    decidir.mockResolvedValue({ permite: true });
    await enviarTextoFixoPendente(admin());
    expect(decidir.mock.calls[0]?.[1]).toMatchObject({ followup: true });
  });

  it("última mensagem há 30h: não envia, o passo é pulado e o fluxo segue", async () => {
    decidir.mockResolvedValue({ permite: true });
    conversa = { last_inbound_at: horasAtras(30), channel_session_id: "sess-1", channel_sessions: { provider: CHANNEL_PROVIDER_INSTAGRAM } };
    expect(await enviarTextoFixoPendente(admin())).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(completeTurnForEnrollment).toHaveBeenCalledWith(
      expect.anything(), "org-1", "enr-1", "node-1", { kind: "pulado", reason: RAZAO }, undefined, "job-1", expect.anything(),
    );
    expect(statusUpdates).toContain("done");
  });

  it("última mensagem há 2h: envia", async () => {
    decidir.mockResolvedValue({ permite: true });
    conversa = { last_inbound_at: horasAtras(2), channel_session_id: "sess-1", channel_sessions: { provider: CHANNEL_PROVIDER_INSTAGRAM } };
    expect(await enviarTextoFixoPendente(admin())).toBe(1);
    expect(sendMessageHandler).toHaveBeenCalledOnce();
  });

  it("o servidor recusa com fora_das_24h_do_instagram: pulo, não falha", async () => {
    decidir.mockResolvedValue({ permite: true });
    conversa = { last_inbound_at: horasAtras(2), channel_session_id: "sess-1", channel_sessions: { provider: CHANNEL_PROVIDER_INSTAGRAM } };
    sendMessageHandler.mockResolvedValueOnce({ id: "msg-1", status: "failed", error_code: "fora_das_24h_do_instagram" } as never);
    expect(await enviarTextoFixoPendente(admin())).toBe(0);
    expect(completeTurnForEnrollment).toHaveBeenCalledWith(
      expect.anything(), "org-1", "enr-1", "node-1", { kind: "pulado", reason: RAZAO }, undefined, "job-1", expect.anything(),
    );
    expect(statusUpdates).toContain("done");
    expect(statusUpdates).not.toContain("pending");
  });
});

describe("enviarTextoFixoPendente · a mesma decisão de envio do worker", () => {
  const ABRE = "2026-10-07T10:00:00.000Z";
  const fechou = (resultado: Record<string, unknown>) =>
    expect(completeTurnForEnrollment).toHaveBeenCalledWith(
      expect.anything(), "org-1", "enr-1", "node-1", resultado, undefined, "job-1", expect.anything(),
    );

  beforeEach(() => {
    decidir.mockResolvedValue({ permite: true });
  });

  it("a decisão é pedida com a inscrição e a conversa do job", async () => {
    await enviarTextoFixoPendente(admin());
    expect(conferir).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: "org-1", contactId: "contact-1", conversationId: "conv-1", enrollmentId: "enr-1" },
      expect.any(Date),
    );
  });

  it("o contato respondeu (cancel_on_reply) → não envia; encerra com 'replied'", async () => {
    conferir.mockResolvedValue({ envia: false, motivo: "resposta_do_contato", invalida: true });
    expect(await enviarTextoFixoPendente(admin())).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    fechou({ kind: "skipped", reason: TEXTO_DO_BLOQUEIO.resposta_do_contato, outcome: "replied" });
    expect(settles.at(-1)).toMatchObject({ p_done: true });
  });

  it("humano ativo → não envia; encerra com 'handoff'", async () => {
    conferir.mockResolvedValue({ envia: false, motivo: "atendimento_humano", invalida: true });
    expect(await enviarTextoFixoPendente(admin())).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    fechou({ kind: "skipped", reason: TEXTO_DO_BLOQUEIO.atendimento_humano, outcome: "handoff" });
    expect(settles.at(-1)).toMatchObject({ p_done: true });
  });

  it("etapa que bloqueia → encerra sem desfecho", async () => {
    conferir.mockResolvedValue({ envia: false, motivo: "etapa_bloqueia_followup", invalida: true });
    await enviarTextoFixoPendente(admin());
    expect(sendMessageHandler).not.toHaveBeenCalled();
    fechou({ kind: "skipped", reason: TEXTO_DO_BLOQUEIO.etapa_bloqueia_followup });
  });

  it("fora da janela da organização → adia para a abertura, sem gastar tentativa", async () => {
    conferir.mockResolvedValue({ envia: false, motivo: "fora_da_janela", adiarPara: new Date(ABRE) });
    expect(await enviarTextoFixoPendente(admin())).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(completeTurnForEnrollment).not.toHaveBeenCalled();
    expect(settles.at(-1)).toMatchObject({ p_done: false, p_hold: true, p_retry_at: ABRE });
  });

  it("não verificável → não envia; volta à fila gastando tentativa (falha fechada)", async () => {
    conferir.mockResolvedValue({ envia: false, motivo: "nao_verificavel", invalida: false });
    expect(await enviarTextoFixoPendente(admin())).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(settles.at(-1)).toMatchObject({ p_done: false, p_hold: false });
  });

  it("inscrição já encerrada → não envia; job encerrado sem fechar o turno", async () => {
    conferir.mockResolvedValue({ envia: false, motivo: "inscricao_encerrada", invalida: false });
    await enviarTextoFixoPendente(admin());
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(completeTurnForEnrollment).not.toHaveBeenCalled();
    expect(settles.at(-1)).toMatchObject({ p_done: true });
  });

  it("fora das 24h do Instagram pela decisão → pula o passo", async () => {
    conferir.mockResolvedValue({ envia: false, motivo: "fora_das_24h_do_instagram", pula: true });
    await enviarTextoFixoPendente(admin());
    expect(sendMessageHandler).not.toHaveBeenCalled();
    fechou({ kind: "pulado", reason: TEXTO_DO_BLOQUEIO.fora_das_24h_do_instagram });
  });

  it("janela anti-ban do canal fechada → adia para a abertura do canal", async () => {
    adiarAteAJanelaAbrir.mockResolvedValue(ABRE);
    expect(await enviarTextoFixoPendente(admin())).toBe(0);
    expect(adiarAteAJanelaAbrir).toHaveBeenCalledWith(expect.anything(), "org-1", "sess-1");
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(settles.at(-1)).toMatchObject({ p_done: false, p_hold: true, p_retry_at: ABRE });
  });

  it("janela do canal aberta → espaça o envio pelo número e envia", async () => {
    expect(await enviarTextoFixoPendente(admin())).toBe(1);
    expect(espacarEnvio).toHaveBeenCalledWith("sess-1");
    expect(espacarEnvio.mock.invocationCallOrder[0]!).toBeLessThan(sendMessageHandler.mock.invocationCallOrder[0]!);
  });
});

describe("enviarTextoFixoPendente · {{nome}} e {{primeiro_nome}}", () => {
  beforeEach(() => {
    decidir.mockResolvedValue({ permite: true });
    JOB.payload.fixed_body = "Oi {{primeiro_nome}}!";
  });
  const corpo = () => (sendMessageHandler.mock.calls[0]?.[2] as { body?: string } | undefined)?.body;

  it("o nome do perfil (display_name) preenche quando não há name", async () => {
    contato = { name: null, display_name: "Bia Ramos" };
    expect(await enviarTextoFixoPendente(admin())).toBe(1);
    expect(corpo()).toBe("Oi Bia!");
  });

  it("sem nome nenhum, a variável sai do texto", async () => {
    contato = { name: null, display_name: null };
    expect(await enviarTextoFixoPendente(admin())).toBe(1);
    expect(corpo()).toBe("Oi!");
  });

  it("texto que era só a variável, sem nome: não envia '' — pula o passo, como o worker", async () => {
    JOB.payload.fixed_body = "{{primeiro_nome}}";
    contato = { name: null, display_name: null };
    expect(await enviarTextoFixoPendente(admin())).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(completeTurnForEnrollment.mock.calls[0]?.[4]).toEqual({
      kind: "pulado",
      reason: "Passo pulado: sem o nome do contato, a mensagem ficaria vazia.",
    });
    expect(statusUpdates).toContain("done");
  });
});
