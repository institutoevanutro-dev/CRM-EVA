// @vitest-environment node
/**
 * NENHUM CONTATO É ANONIMIZADO POR PEDIDO SEM APROVAÇÃO PROVADA.
 *
 * O `lgpd-redact-worker` anonimizava ao receber `lgpd.redact_received`, sem
 * olhar se alguém tinha aprovado: o evento era a autorização. O webhook da loja
 * emitia ao criar o pedido, e qualquer outro emissor do servidor faria o mesmo
 * com um pedido registrado à mão. Anonimização não tem volta.
 *
 * O que este arquivo prende, com o worker e a rota de verdade sobre um banco
 * que só RESPONDE:
 *
 *   1. o portão: antes de gravar qualquer coisa o worker pergunta ao banco
 *      (`fn_lgpd_recusa_do_redact`, a regra única, medida em
 *      `tests/invariants/lgpd-anonimizacao-exige-aprovacao.test.ts`) e, recusado,
 *      não chama a cascata, não marca o pedido como falho e devolve `skipped`
 *      (o dreno consome o evento, sem nova tentativa);
 *   2. nada do EVENTO entra na decisão;
 *   3. toda gravação de estado é conferida, e o que vem DEPOIS do irreversível
 *      nunca devolve o pedido a "não feito";
 *   4. a rota de aprovação grava a prova na linha do pedido ANTES de emitir o
 *      evento, e só o pedido ainda `received` é aprovado;
 *   5. só a aprovação emite o evento.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Patch = Record<string, unknown>;
const ORG = "11111111-1111-4111-8111-111111111111";
const PEDIDO = "22222222-2222-4222-8222-222222222222";
const CONTATO = "55555555-5555-4555-8555-555555555555";
const ADMIN = "33333333-3333-4333-8333-333333333333";

const estado = vi.hoisted(() => ({
  /** Tudo que o código fez no "banco", na ordem. */
  passos: [] as string[],
  updates: [] as Array<{ tabela: string; patch: Patch; filtros: Record<string, unknown> }>,
  recusarEstado: new Set<string>(),
  /** Linhas que o UPDATE diz ter alcançado (a rota pede `.select("id")`). */
  linhasDoUpdate: [{ id: "x" }] as Array<{ id: string }>,
  erroDoUpdateSemEstado: null as { code: string; message: string } | null,
  pedido: null as Record<string, unknown> | null,
  recusa: null as string | null,
  erroDaRegra: null as { code: string; message: string } | null,
  emitErro: null as { code: string; message: string } | null,
  contatoJaAnonimizado: false,
  cascata: [] as Array<Record<string, unknown>>,
  cascataResposta: { alreadyAnonymized: false, counts: { contacts: 1, messages: 3 } as Record<string, number>, mediaPaths: [] as string[] },
  cascataErro: null as string | null,
  contatosDaOrg: [] as Array<{ id: string }>,
}));

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/lgpd/repository", () => ({
  findLgpdRequest: async () => estado.pedido,
  findContactByExternalId: async () => null,
}));
vi.mock("@/lib/lgpd/redact-cascade", () => ({
  cascadeRedactContact: async (args: Record<string, unknown>) => {
    estado.passos.push("cascata");
    estado.cascata.push(args);
    if (estado.cascataErro) throw new Error(estado.cascataErro);
    return estado.cascataResposta;
  },
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { id: ADMIN, idioma: "pt-BR" }, org: { orgId: ORG } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () => {
        const q: Record<string, unknown> = {
          eq: () => q,
          order: () => q,
          range: () => q,
          maybeSingle: async () => ({
            data:
              tabela === "lgpd_requests"
                ? estado.pedido
                : tabela === "contacts"
                  ? { is_anonymized: estado.contatoJaAnonimizado }
                  : null,
            error: null,
          }),
          then: (ok: (v: unknown) => unknown) =>
            Promise.resolve({ data: tabela === "contacts" ? estado.contatosDaOrg : [], error: null }).then(ok),
        };
        return q;
      },
      insert: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }),
      update: (patch: Patch) => {
        const filtros: Record<string, unknown> = {};
        estado.updates.push({ tabela, patch, filtros });
        estado.passos.push(`update:${tabela}:${String(patch.status ?? "sem_estado")}`);
        const recusa = estado.recusarEstado.has(String(patch.status));
        const erro = recusa
          ? { code: "57014", message: "canceling statement due to statement timeout" }
          : patch.status === undefined
            ? estado.erroDoUpdateSemEstado
            : null;
        const q: Record<string, unknown> = {
          eq: (coluna: string, valor: unknown) => {
            filtros[coluna] = valor;
            return q;
          },
          neq: (coluna: string, valor: unknown) => {
            filtros[`${coluna}!=`] = valor;
            return q;
          },
          select: () => q,
          then: (ok: (v: unknown) => unknown) =>
            Promise.resolve({ data: erro ? null : estado.linhasDoUpdate, error: erro }).then(ok),
        };
        return q;
      },
    }),
    rpc: async (nome: string, args: Record<string, unknown>) => {
      if (nome === "fn_lgpd_recusa_do_redact") {
        estado.passos.push(`regra:${String(args.p_request_id)}:${String(args.p_organization_id)}:${String(args.p_contact_id)}`);
        return { data: estado.recusa, error: estado.erroDaRegra };
      }
      estado.passos.push(`emit:${String(args.p_event_type)}`);
      return { data: null, error: estado.emitErro };
    },
  }),
}));

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { processLgpdRedact } from "@/workers/lgpd-redact-worker";
import { POST as aprovar } from "@/app/api/v1/lgpd/requests/[id]/approve/route";

function pedido(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PEDIDO,
    organization_id: ORG,
    request_type: "redact",
    source: "manual",
    scope: "contact",
    status: "received",
    attempts: 0,
    contact_id: CONTATO,
    external_customer_id: null,
    request_payload: { channel: "whatsapp", note: "pediu no balcão" },
    ...extra,
  };
}

function evento(payload: Record<string, unknown> = { request_id: PEDIDO }): EventRow {
  return {
    id: "e1",
    organization_id: ORG,
    event_type: "lgpd.redact_received",
    entity_kind: "lgpd_request",
    entity_id: PEDIDO,
    payload,
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

const estadosGravados = () => estado.updates.filter((u) => u.tabela === "lgpd_requests").map((u) => u.patch.status);
const auditou = (acao: string) =>
  vi.mocked(audit).mock.calls.some(([entrada]) => (entrada as { action: string }).action === acao);

beforeEach(() => {
  vi.clearAllMocks();
  estado.passos = [];
  estado.updates = [];
  estado.recusarEstado = new Set();
  estado.linhasDoUpdate = [{ id: "x" }];
  estado.erroDoUpdateSemEstado = null;
  estado.pedido = pedido();
  estado.recusa = null;
  estado.erroDaRegra = null;
  estado.emitErro = null;
  estado.contatoJaAnonimizado = false;
  estado.cascata = [];
  estado.cascataResposta = { alreadyAnonymized: false, counts: { contacts: 1, messages: 3 }, mediaPaths: [] };
  estado.cascataErro = null;
  estado.contatosDaOrg = [];
});

describe("lgpd-redact-worker: sem aprovação provada, não anonimiza", () => {
  it.each<[string, Record<string, unknown>]>([
    ["emitido direto por qualquer um do servidor", { request_id: PEDIDO }],
    [
      "com 'aprovação' escrita no payload do evento",
      { request_id: PEDIDO, manually_approved: true, approved_by: ADMIN, approved_reason: "forjado no evento" },
    ],
    ["do webhook da loja", { request_id: PEDIDO, scope: "contact", emergency: false, external_customer_id: "991" }],
  ])("1. evento %s: skipped, nenhuma gravação, cascata não roda", async (_nome, payload) => {
    estado.recusa = "not_approved";

    const r = await processLgpdRedact(evento(payload));

    expect(r).toMatchObject({ status: "skipped", detail: "not_approved:not_approved" });
    expect(estado.cascata).toEqual([]);
    expect(estado.updates).toEqual([]);
    // A pergunta é feita com o que está na LINHA do pedido e na organização do
    // evento; nada do payload entra.
    expect(estado.passos).toEqual([`regra:${PEDIDO}:${ORG}:null`]);
    expect(auditou("lgpd.redact_failed")).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("2. o mesmo evento reprocessado continua recusado, e não gasta tentativa do pedido", async () => {
    estado.recusa = "not_approved";

    for (let i = 0; i < 3; i++) expect((await processLgpdRedact(evento())).status).toBe("skipped");

    expect(estado.cascata).toEqual([]);
    expect(estado.updates).toEqual([]);
  });

  it("3. pedido da organização inteira não aprovado: nenhum contato, e a organização não vira 'redacted'", async () => {
    estado.pedido = pedido({ request_type: "store_redact", scope: "tenant", contact_id: null, emergency: true });
    estado.contatosDaOrg = [{ id: CONTATO }];
    estado.recusa = "not_approved";

    const r = await processLgpdRedact(evento({ request_id: PEDIDO, scope: "tenant", emergency: true }));

    expect(r.status).toBe("skipped");
    expect(estado.cascata).toEqual([]);
    expect(estado.updates).toEqual([]);
  });

  it("4. recusado com o pedido em 'processing': volta a 'received' para poder ser aprovado de novo", async () => {
    estado.pedido = pedido({ status: "processing" });
    estado.recusa = "approver_not_admin";

    const r = await processLgpdRedact(evento());

    expect(r).toMatchObject({ status: "skipped", detail: "not_approved:approver_not_admin" });
    expect(estado.cascata).toEqual([]);
    expect(estadosGravados()).toEqual(["received"]);
    expect(estado.updates[0]!.filtros).toMatchObject({ organization_id: ORG, id: PEDIDO, status: "processing" });
  });

  it("5. o banco não respondeu à pergunta: error (o dreno tenta de novo), sem gravar e sem anonimizar", async () => {
    estado.erroDaRegra = { code: "57014", message: "timeout" };

    const r = await processLgpdRedact(evento());

    expect(r).toMatchObject({ status: "error", detail: "approval_check_failed: 57014" });
    expect(estado.cascata).toEqual([]);
    expect(estado.updates).toEqual([]);
  });
});

describe("lgpd-redact-worker: aprovado, anonimiza uma vez e toda gravação é conferida", () => {
  it("6. controle: aprovado, a cascata roda para o contato do pedido e o pedido conclui", async () => {
    const r = await processLgpdRedact(evento());

    expect(r).toMatchObject({ status: "ok", detail: "completed" });
    expect(estado.cascata).toEqual([{ organizationId: ORG, contactId: CONTATO, requestId: PEDIDO }]);
    expect(estadosGravados()).toEqual(["processing", "completed"]);
    expect(estado.passos.indexOf("update:lgpd_requests:processing")).toBeLessThan(estado.passos.indexOf("cascata"));
    expect(auditou("lgpd.redact_completed")).toBe(true);
  });

  it("7. o banco recusa 'processing': error, e a cascata NÃO roda", async () => {
    estado.recusarEstado.add("processing");

    const r = await processLgpdRedact(evento());

    expect(r.status).toBe("error");
    expect(r.detail).toContain("status_write_failed: 57014");
    expect(estado.cascata).toEqual([]);
  });

  it("8. anonimizou e o banco recusa 'completed': error para o dreno repetir, e o pedido NÃO volta a 'não feito'", async () => {
    estado.recusarEstado.add("completed");

    const r = await processLgpdRedact(evento());

    expect(r.status).toBe("error");
    expect(r.detail).toContain("redacted_but_status_write_failed: 57014");
    expect(estadosGravados()).toEqual(["processing", "completed"]);
    expect(auditou("lgpd.redact_failed")).toBe(false);
    expect(auditou("lgpd.redact_completed")).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });

  it("9. a nova tentativa depois do caso 8 não anonimiza de novo: a cascata diz 'já anonimizado' e o pedido conclui", async () => {
    estado.pedido = pedido({ status: "processing", attempts: 1 });
    estado.cascataResposta = { alreadyAnonymized: true, counts: {}, mediaPaths: [] };

    const r = await processLgpdRedact(evento());

    expect(r).toMatchObject({ status: "ok", detail: "already_anonymized" });
    expect(estadosGravados()).toEqual(["processing", "completed"]);
    // Não passa por cima de um 'completed' que outra execução já gravou com os números.
    expect(estado.updates[1]!.filtros).toMatchObject({ "status!=": "completed" });
  });

  it("10. no teto de tentativas com o contato JÁ anonimizado: conclui, em vez de marcar 'failed'", async () => {
    estado.pedido = pedido({ status: "processing", attempts: 3 });
    estado.contatoJaAnonimizado = true;
    estado.cascataResposta = { alreadyAnonymized: true, counts: {}, mediaPaths: [] };

    const r = await processLgpdRedact(evento());

    expect(r.status).toBe("ok");
    expect(estadosGravados()).not.toContain("failed");
  });

  it("11. no teto de tentativas sem ter anonimizado: 'failed' conferido, e nada roda", async () => {
    estado.pedido = pedido({ attempts: 3 });
    estado.recusarEstado.add("failed");

    const r = await processLgpdRedact(evento());

    expect(r.status).toBe("error");
    expect(r.detail).toBe("max_attempts_exceeded; status_write_failed: 57014");
    expect(estado.cascata).toEqual([]);
  });

  it("12. a cascata falha (nada foi anonimizado) e o banco recusa a devolução à fila: o desfecho diz", async () => {
    estado.cascataErro = "rpc failed: deadlock";
    estado.recusarEstado.add("received");

    const r = await processLgpdRedact(evento());

    expect(r.status).toBe("error");
    expect(r.detail).toBe("redact_failed_will_retry; status_write_failed: 57014");
    expect(vi.mocked(audit).mock.calls.at(-1)![0]).toMatchObject({
      action: "lgpd.redact_failed",
      metadata: { status_write_failed: "57014" },
    });
  });

  it("13. concluiu e o evento 'aplicado' não saiu: o pedido fica concluído, ninguém o devolve à fila", async () => {
    estado.emitErro = { code: "57014", message: "timeout" };

    const r = await processLgpdRedact(evento());

    expect(r.status).toBe("ok");
    expect(estadosGravados()).toEqual(["processing", "completed"]);
    expect(logger.error).toHaveBeenCalled();
  });

  it("14. sem contato local e o banco recusa 'pending_review': error, e nada é auditado como feito", async () => {
    estado.pedido = pedido({ contact_id: null, external_customer_id: "991", source: "nuvemshop" });
    estado.recusarEstado.add("pending_review");

    const r = await processLgpdRedact(evento());

    expect(r.status).toBe("error");
    expect(auditou("lgpd.redact_no_local_footprint")).toBe(false);
    expect(estadosGravados()).toEqual(["processing", "pending_review", "received"]);
  });

  it("15. organização inteira aprovada e o banco recusa o estado final: error, sem devolver a 'received'", async () => {
    estado.pedido = pedido({ request_type: "store_redact", scope: "tenant", contact_id: null });
    estado.contatosDaOrg = [{ id: CONTATO }];
    estado.recusarEstado.add("completed");

    const r = await processLgpdRedact(evento({ request_id: PEDIDO, scope: "tenant" }));

    expect(r.status).toBe("error");
    expect(r.detail).toContain("redacted_but_status_write_failed: 57014");
    expect(estado.cascata).toHaveLength(1);
    expect(estadosGravados()).not.toContain("received");
    expect(auditou("lgpd.tenant_redacted")).toBe(false);
  });
});

describe("POST /api/v1/lgpd/requests/[id]/approve: a prova fica na linha do pedido, antes do evento", () => {
  const pedir = () =>
    aprovar(
      {
        headers: new Headers({ "Idempotency-Key": "44444444-4444-4444-8444-444444444444" }),
        json: async () => ({ approved_reason: "Paciente pediu por escrito no balcão." }),
      } as never,
      { params: Promise.resolve({ id: PEDIDO }) },
    );

  it("16. grava quem, quando e por quê, para ESTE pedido e ESTE contato, e só então emite", async () => {
    const resposta = await pedir();

    expect(resposta.status).toBe(200);
    const [prova, andamento] = estado.updates;
    expect(prova!.patch.status).toBeUndefined();
    expect(prova!.filtros).toMatchObject({ organization_id: ORG, id: PEDIDO, status: "received" });
    const gravado = prova!.patch.request_payload as Record<string, unknown>;
    // O que o pedido já guardava continua lá.
    expect(gravado).toMatchObject({ channel: "whatsapp", note: "pediu no balcão" });
    expect(gravado.approval).toMatchObject({
      request_id: PEDIDO,
      organization_id: ORG,
      contact_id: CONTATO,
      approved_by: ADMIN,
      approved_reason: "Paciente pediu por escrito no balcão.",
    });
    expect((gravado.approval as { approved_at: string }).approved_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(estado.passos).toEqual([
      "update:lgpd_requests:sem_estado",
      "emit:lgpd.redact_received",
      "update:lgpd_requests:processing",
    ]);
    // 'processing' só sobre o pedido ainda 'received': não desfaz um 'completed' do worker.
    expect(andamento!.filtros).toMatchObject({ status: "received" });
  });

  it("17. outro clique chegou antes (a gravação da prova não alcança linha): 409 e nenhum evento", async () => {
    estado.linhasDoUpdate = [];

    const resposta = await pedir();

    expect(resposta.status).toBe(409);
    expect(estado.passos).toEqual(["update:lgpd_requests:sem_estado"]);
  });

  it("18. o banco recusa a gravação da prova: 500 e nenhum evento", async () => {
    estado.erroDoUpdateSemEstado = { code: "57014", message: "timeout" };

    const resposta = await pedir();

    expect(resposta.status).toBe(500);
    expect(estado.passos).toEqual(["update:lgpd_requests:sem_estado"]);
  });

  it("19. pedido que não está 'received': 409, sem prova e sem evento", async () => {
    estado.pedido = pedido({ status: "completed" });

    const resposta = await pedir();

    expect(resposta.status).toBe(409);
    expect(estado.passos).toEqual([]);
  });
});

describe("só a aprovação emite lgpd.redact_received", () => {
  it("20. nenhum outro arquivo do servidor emite o evento", () => {
    const raiz = process.cwd();
    const emissores: string[] = [];
    const varrer = (dir: string) => {
      for (const e of readdirSync(join(raiz, dir), { withFileTypes: true })) {
        const caminho = `${dir}/${e.name}`;
        if (e.isDirectory()) varrer(caminho);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          const texto = readFileSync(join(raiz, caminho), "utf8");
          if (/emit_event/.test(texto) && /["']lgpd\.redact_received["']/.test(texto)) emissores.push(caminho);
        }
      }
    };
    for (const dir of ["app", "lib", "workers"]) varrer(dir);
    expect(emissores).toEqual(["app/api/v1/lgpd/requests/[id]/approve/route.ts"]);
  });
});
