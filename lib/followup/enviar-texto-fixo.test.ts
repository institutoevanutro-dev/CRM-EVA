/**
 * R1 — o envio INLINE de texto fixo do follow-up (`enviarTextoFixoPendente`, o
 * atalho "sem cron e sem agent-worker") BYPASSA `executarTurnoDoAgente`, então
 * precisa do gate de elegibilidade por conta própria. Sem isto, um fluxo de
 * follow-up com nó de texto fixo mandaria mensagem para uma conversa que o gate
 * `allowlist` barra.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { enviarTextoFixoPendente } from "./enviar-texto-fixo";
import { CHANNEL_PROVIDER_INSTAGRAM } from "@/lib/channels/capabilities";

/** A conversa do follow-up, como o banco a devolve (canal + última mensagem do cliente). */
let conversa: Record<string, unknown> | null = null;

const boundary = { organization_id: "org-1", contact_id: "contact-1", conversation_id: "conv-1", service_revision: 1, demanda_id: null, demanda_revision: null };
const JOB = {
  id: "job-1",
  organization_id: "org-1",
  contact_id: "contact-1",
  payload: { service_boundary: boundary, fixed_body: "Oi, tudo bem?", followup_enrollment_id: "enr-1", node_id: "node-1" },
};

const statusUpdates: string[] = [];

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
    if(name==="fn_followup_inline_settle") {statusUpdates.push(args.p_done?"done":"pending");return {data:true,error:null};}
    if(name==="fn_appointment_enrollment_current" || name==="fn_followup_job_current") return {data:true,error:null};
    return {data:{...boundary,status:"open",demanda_fechada_em:null},error:null};
  }} as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  statusUpdates.length = 0;
  conversa = null;
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
    conversa = { last_inbound_at: horasAtras(30), channel_sessions: { provider: CHANNEL_PROVIDER_INSTAGRAM } };
    expect(await enviarTextoFixoPendente(admin())).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(completeTurnForEnrollment).toHaveBeenCalledWith(
      expect.anything(), "org-1", "enr-1", "node-1", { kind: "pulado", reason: RAZAO }, undefined, "job-1", expect.anything(),
    );
    expect(statusUpdates).toContain("done");
  });

  it("última mensagem há 2h: envia", async () => {
    decidir.mockResolvedValue({ permite: true });
    conversa = { last_inbound_at: horasAtras(2), channel_sessions: { provider: CHANNEL_PROVIDER_INSTAGRAM } };
    expect(await enviarTextoFixoPendente(admin())).toBe(1);
    expect(sendMessageHandler).toHaveBeenCalledOnce();
  });

  it("o servidor recusa com fora_das_24h_do_instagram: pulo, não falha", async () => {
    decidir.mockResolvedValue({ permite: true });
    conversa = { last_inbound_at: horasAtras(2), channel_sessions: { provider: CHANNEL_PROVIDER_INSTAGRAM } };
    sendMessageHandler.mockResolvedValueOnce({ id: "msg-1", status: "failed", error_code: "fora_das_24h_do_instagram" } as never);
    expect(await enviarTextoFixoPendente(admin())).toBe(0);
    expect(completeTurnForEnrollment).toHaveBeenCalledWith(
      expect.anything(), "org-1", "enr-1", "node-1", { kind: "pulado", reason: RAZAO }, undefined, "job-1", expect.anything(),
    );
    expect(statusUpdates).toContain("done");
    expect(statusUpdates).not.toContain("pending");
  });
});
