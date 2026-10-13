// @vitest-environment node
/**
 * O PEDIDO DO TITULAR NÃO FALHA CALADO.
 *
 * Casos 1 a 5 portados de melgarafael/DeskcommCRM #2788 (@melgarafael); os
 * demais são daqui.
 *
 * O worker de exportação gravava `pending_review`, o CHECK do banco recusava
 * (23514), e o worker não lia o erro: auditava `lgpd.export_generated`, devolvia
 * `ok` ao dreno (sem nova tentativa) e o pedido ficava em `processing` para
 * sempre. A migration 0356 faz o banco aceitar o estado
 * (`tests/invariants/pedido-lgpd-fecha-o-ciclo.test.ts`). Este arquivo prende a
 * OUTRA metade: se o banco recusar QUALQUER gravação de estado de novo, por
 * qualquer razão, o worker falha em voz alta. Não audita o que não aconteceu,
 * registra `logger.error`, devolve `error` ao dreno (que tenta de novo e, no
 * teto, abre aviso na Central) e nunca reenvia o e-mail ao titular por causa
 * de uma gravação recusada.
 *
 * O banco falso só RESPONDE; quem decide é o worker de verdade. `recusar` diz
 * quais estados o "banco" recusa naquele caso.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as EmailDelivery from "@/lib/lgpd/email-delivery";

type Patch = Record<string, unknown>;
const ORG_DA_SESSAO = vi.hoisted(() => "11111111-1111-4111-8111-111111111111");
const estado = vi.hoisted(() => ({
  updates: [] as Patch[],
  recusar: new Set<string>(),
  pedido: {} as Record<string, unknown>,
  email: "sem_transporte" as "sem_transporte" | "falha" | "ok",
  enviados: 0,
  detalhe: null as Record<string, unknown> | null,
  assinados: [] as string[],
  emitErro: null as { code: string; message: string } | null,
}));

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/lgpd/repository", () => ({ findLgpdRequest: async () => estado.pedido }));
vi.mock("@/lib/lgpd/export-collector", () => ({
  collectExportData: async () => ({ contact: { email: null } }),
}));
vi.mock("@/lib/lgpd/pdf-renderer", () => ({ renderLgpdPdf: async () => Buffer.from("pdf") }));
vi.mock("@/lib/lgpd/pades-signer", () => ({
  isPadesConfigured: () => false,
  signPdfPades: async (b: Buffer) => ({ signed: b, sha256: "abc", signed_pades: false, warning: "pades_key_missing" }),
}));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: async () => ({}) }));
vi.mock("@/lib/lgpd/email-delivery", async (original) => {
  const real = await original<typeof EmailDelivery>();
  return {
    ...real,
    sendExportEmail: async () => {
      if (estado.email === "sem_transporte") throw new real.EmailNotConfigured();
      if (estado.email === "falha") throw new real.EmailSendFailed("resend 500");
      estado.enviados += 1;
      return { messageId: "m1" };
    },
  };
});
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "33333333-3333-4333-8333-333333333333", idioma: "pt-BR" },
    org: { orgId: ORG_DA_SESSAO },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      // Leituras das rotas: a linha do pedido; chave de idempotência e trilha vazias.
      select: () => {
        const q: Record<string, unknown> = {
          eq: () => q,
          or: () => q,
          order: () => q,
          limit: () => q,
          maybeSingle: async () => ({ data: tabela === "lgpd_requests" ? estado.detalhe : null, error: null }),
          then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
        };
        return q;
      },
      insert: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }),
      update: (patch: Patch) => {
        estado.updates.push(patch);
        const recusa = estado.recusar.has(String(patch.status));
        const resposta = {
          // A reivindicação pede `.select("id")`: devolve a linha reivindicada.
          data: [{ id: "x" }],
          error: recusa
            ? {
                code: "23514",
                message: 'new row for relation "lgpd_requests" violates check constraint',
                details: "Failing row contains (… titular@exemplo.test …)",
              }
            : null,
        };
        const q: Record<string, unknown> = {
          eq: () => q,
          neq: () => q,
          or: () => q,
          select: () => q,
          then: (ok: (v: unknown) => unknown) => Promise.resolve(resposta).then(ok),
        };
        return q;
      },
    }),
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        createSignedUrl: async (caminho: string) => {
          estado.assinados.push(caminho);
          return { data: { signedUrl: "https://storage.test/x" }, error: null };
        },
      }),
    },
    rpc: async () => ({ data: null, error: estado.emitErro }),
  }),
}));

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { processLgpdExport } from "@/workers/lgpd-export-worker";
import { GET as detalhe } from "@/app/api/v1/lgpd/requests/[id]/route";
import { POST as aprovar } from "@/app/api/v1/lgpd/requests/[id]/approve/route";

const ORG = ORG_DA_SESSAO;
const PEDIDO = "22222222-2222-4222-8222-222222222222";
const evento = { id: 1, organization_id: ORG, entity_id: PEDIDO, payload: { request_id: PEDIDO } } as unknown as EventRow;

const auditou = (acao: string) =>
  vi.mocked(audit).mock.calls.some(([e]) => (e as { action: string }).action === acao);
const ultimo = () => estado.updates[estado.updates.length - 1]!;

beforeEach(() => {
  vi.mocked(audit).mockClear();
  vi.mocked(logger.error).mockClear();
  estado.updates = [];
  estado.recusar = new Set();
  estado.email = "sem_transporte";
  estado.enviados = 0;
  estado.emitErro = null;
  estado.pedido = {
    id: PEDIDO,
    organization_id: ORG,
    status: "received",
    request_type: "data_request",
    attempts: 0,
    contact_id: null,
    external_customer_id: null,
    request_payload: { delivery: { address: "titular@exemplo.test" } },
  };
});

describe("lgpd-export-worker: o desfecho pending_review é conferido", () => {
  it("1. sem transporte e o banco recusa: não audita 'exportado', devolve error e devolve o pedido à fila", async () => {
    estado.recusar.add("pending_review");

    const r = await processLgpdExport(evento);

    expect(r.status).toBe("error");
    expect(auditou("lgpd.export_generated")).toBe(false);
    expect(auditou("lgpd.export_failed")).toBe(true);
    expect(ultimo().status).toBe("received");
    expect(String(ultimo().error_message)).toContain("23514");
    // Só o código sai do erro: o detalhe do Postgres traz a linha, e a linha traz o e-mail.
    expect(JSON.stringify(estado.updates)).not.toContain("titular@exemplo.test");
    expect(logger.error).toHaveBeenCalled();
  });

  it("2. controle: sem transporte e o banco aceita, o pedido fica em pending_review e audita", async () => {
    const r = await processLgpdExport(evento);

    expect(r).toMatchObject({ status: "ok", detail: "email_not_configured" });
    expect(ultimo()).toMatchObject({
      status: "pending_review",
      error_message: "email_not_configured",
      result: { pdf_path: `${ORG}/${PEDIDO}/report.pdf`, json_path: `${ORG}/${PEDIDO}/data.json` },
    });
    expect(auditou("lgpd.export_generated")).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("3. titular sem endereço e o banco recusa: mesma falha em voz alta", async () => {
    estado.recusar.add("pending_review");
    estado.pedido = { ...estado.pedido, request_payload: {} };

    const r = await processLgpdExport(evento);

    expect(r.status).toBe("error");
    expect(auditou("lgpd.export_generated")).toBe(false);
    expect(ultimo().status).toBe("received");
  });
});

describe("GET /api/v1/lgpd/requests/[id]: o PDF da revisão pendente chega ao operador", () => {
  const pedirDetalhe = async (status: string) => {
    estado.assinados = [];
    estado.detalhe = {
      id: PEDIDO,
      organization_id: ORG,
      status,
      result: { pdf_path: `${ORG}/${PEDIDO}/report.pdf` },
    };
    const resposta = await detalhe({} as never, { params: Promise.resolve({ id: PEDIDO }) });
    return (await resposta.json()) as { data: { signed_pdf_url: string | null } };
  };

  it("4. pending_review com PDF gerado devolve o link assinado", async () => {
    const corpo = await pedirDetalhe("pending_review");
    expect(corpo.data.signed_pdf_url).toBe("https://storage.test/x");
    expect(estado.assinados).toEqual([`${ORG}/${PEDIDO}/report.pdf`]);
  });

  it("5. controle: processing não ganha link", async () => {
    const corpo = await pedirDetalhe("processing");
    expect(corpo.data.signed_pdf_url).toBeNull();
    expect(estado.assinados).toEqual([]);
  });
});

describe("lgpd-export-worker: as outras gravações de estado também são conferidas", () => {
  it("6. e-mail entregue e o banco recusa 'completed': não reenvia, marca failed com o motivo e devolve error", async () => {
    estado.email = "ok";
    estado.recusar.add("completed");

    const r = await processLgpdExport(evento);

    expect(r).toMatchObject({ status: "error", detail: "completed_update_failed: 23514" });
    // O titular recebeu UMA vez: a recusa não pode levar ao catch que devolve à fila.
    expect(estado.enviados).toBe(1);
    expect(estado.updates.filter((u) => u.status === "completed")).toHaveLength(2);
    expect(ultimo()).toMatchObject({
      status: "failed",
      error_message: "entregue_mas_conclusao_nao_gravada: 23514",
      result: { pdf_path: `${ORG}/${PEDIDO}/report.pdf`, message_id: "m1" },
    });
    expect(auditou("lgpd.export_generated")).toBe(false);
    expect(auditou("lgpd.export_failed")).toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });

  it("7. controle: e-mail entregue e o banco aceita, o pedido conclui", async () => {
    estado.email = "ok";

    const r = await processLgpdExport(evento);

    expect(r.status).toBe("ok");
    expect(ultimo().status).toBe("completed");
    expect(auditou("lgpd.export_generated")).toBe(true);
    expect(auditou("lgpd.export_delivered")).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("8. a exportação falha e o banco recusa a devolução à fila: o motivo vai no desfecho e na auditoria", async () => {
    estado.recusar.add("pending_review").add("received");

    const r = await processLgpdExport(evento);

    expect(r.status).toBe("error");
    expect(r.detail).toContain("status_write_failed: 23514");
    const falha = vi.mocked(audit).mock.calls.map(([e]) => e as { action: string; metadata: Patch })
      .find((e) => e.action === "lgpd.export_failed");
    expect(falha?.metadata.status_write_failed).toBe("23514");
  });

  it("9. falha de envio do e-mail e o banco recusa a devolução à fila: o desfecho diz", async () => {
    estado.email = "falha";
    estado.recusar.add("received");

    const r = await processLgpdExport(evento);

    expect(r).toMatchObject({ status: "error", detail: "email_send_failed; status_write_failed: 23514" });
    expect(logger.error).toHaveBeenCalled();
  });

  it("10. teto de tentativas e o banco recusa 'failed': o desfecho diz, e nada é exportado", async () => {
    estado.pedido = { ...estado.pedido, attempts: 3 };
    estado.recusar.add("failed");

    const r = await processLgpdExport(evento);

    expect(r).toMatchObject({ status: "error", detail: "max_attempts_exceeded; status_write_failed: 23514" });
    expect(estado.updates).toHaveLength(1);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("POST /api/v1/lgpd/requests/[id]/approve: sem evento, o pedido não vai a 'processing'", () => {
  const pedirAprovacao = async () => {
    estado.detalhe = { id: PEDIDO, organization_id: ORG, request_type: "data_request", status: "received" };
    const req = {
      headers: new Headers({ "Idempotency-Key": "44444444-4444-4444-8444-444444444444" }),
      json: async () => ({ approved_reason: "Titular confirmou a identidade por telefone." }),
    };
    return aprovar(req as never, { params: Promise.resolve({ id: PEDIDO }) });
  };

  it("11. emit_event falha: responde 500 e o pedido continua em received (dá para aprovar de novo)", async () => {
    estado.emitErro = { code: "57014", message: "canceling statement due to statement timeout" };

    const resposta = await pedirAprovacao();

    expect(resposta.status).toBe(500);
    // A única gravação é a da prova da aprovação, que não mexe no estado.
    expect(estado.updates.map((u) => u.status)).toEqual([undefined]);
    expect(auditou("lgpd.manually_approved")).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });

  it("12. controle: emit_event ok, o pedido vai a processing", async () => {
    const resposta = await pedirAprovacao();

    expect(resposta.status).toBe(200);
    // Primeiro a prova da aprovação (sem estado), depois o andamento.
    expect(estado.updates.map((u) => u.status)).toEqual([undefined, "processing"]);
  });
});
