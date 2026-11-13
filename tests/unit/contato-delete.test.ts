import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerCtx } from "@/lib/api/handlers/types";

const auditSpy = vi.fn(async () => undefined);

vi.mock("@/lib/audit", () => ({
  audit: auditSpy,
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

const ORG = "c05e7a00-0000-4000-8000-000000000001";
const CONTATO = "c05e7a00-0000-4000-8000-0000000000c1";
const USUARIO = "c05e7a00-0000-4000-8000-0000000000a1";

/** A função da transação única (migration 0340) — a ÚNICA escrita da rota. */
const FUNCAO = "fn_apagar_contato_com_historico";

const chamadas: Array<{ tabela: string; op: string }> = [];
const contagens: Array<{ tabela: string; filtros: Array<[string, unknown]> }> = [];
const rpcs: Array<{ nome: string; args: Record<string, unknown> | undefined }> = [];

interface CadeiaContagem {
  eq: (coluna: string, valor: unknown) => CadeiaContagem;
  then: (resolve: (valor: unknown) => unknown) => unknown;
}

/** Uma linha de `calendar_appointments` como a pré-checagem a lê. */
function compromisso(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "c05e7a00-0000-4000-8000-0000000000e1",
    status: "confirmed",
    excluded_at: null,
    google_event_id: null,
    google_pending_write: null,
    google_local_revision: 1,
    google_synced_local_revision: 0,
    google_conflict: null,
    ...over,
  };
}

interface OpcoesFake {
  missing?: boolean;
  /** Os compromissos do contato que a pré-checagem lê na agenda. */
  compromissos?: Array<Record<string, unknown>>;
  /** A leitura da agenda falha (tabela/RLS fora do ar). */
  erroContagem?: { message: string };
  /** A função nova devolve erro (23503 de corrida, 42501 residual, 500…). */
  rpcErro?: { code?: string; message: string };
  /** A função devolve false: a ficha não estava acessível para quem chamou. */
  rpcFalse?: boolean;
}

function clienteFalso(opts?: OpcoesFake): unknown {
  return {
    from: (tabela: string) => {
      const del = {
        eq: () => del,
        select: () => del,
        maybeSingle: async () => ({
          data: opts?.missing ? null : { id: CONTATO, organization_id: ORG },
          error: null,
        }),
        then: (r: (v: unknown) => unknown) => r({ error: null }),
      };
      return {
        // A pré-checagem lê os compromissos do contato (migration 0413).
        select: (_colunas?: string) => {
          if (tabela === "calendar_appointments") {
            const filtros: Array<[string, unknown]> = [];
            const cadeia: CadeiaContagem = {
              eq: (coluna, valor) => {
                filtros.push([coluna, valor]);
                return cadeia;
              },
              then: (resolve) => {
                contagens.push({ tabela, filtros });
                return resolve(
                  opts?.erroContagem
                    ? { data: null, error: opts.erroContagem }
                    : { data: opts?.compromissos ?? [], error: null },
                );
              },
            };
            return cadeia;
          }
          return {
            eq: () => ({
              eq: () => ({
                maybeSingle: async () =>
                  opts?.missing
                    ? { data: null, error: null }
                    : { data: { id: CONTATO, organization_id: ORG }, error: null },
              }),
            }),
          };
        },
        // A rota NÃO apaga tabela nenhuma por conta própria (issue #1862).
        delete: () => {
          chamadas.push({ tabela, op: "delete" });
          return del;
        },
      };
    },
    rpc: (nome: string, args?: Record<string, unknown>) => {
      rpcs.push({ nome, args });
      if (nome !== FUNCAO) return Promise.resolve({ data: null, error: null });
      if (opts?.rpcErro) return Promise.resolve({ data: null, error: opts.rpcErro });
      return Promise.resolve({ data: opts?.rpcFalse ? false : true, error: null });
    },
  };
}

function ctxFalso(): HandlerCtx {
  return { organization_id: ORG, actor: { type: "user", id: USUARIO }, requestId: "req-1" };
}

function ultimaAuditoria(): Record<string, unknown> | undefined {
  return (auditSpy.mock.calls.at(-1) as unknown as [Record<string, unknown>] | undefined)?.[0];
}

describe("deleteContactHandler", () => {
  beforeEach(() => {
    auditSpy.mockClear();
    chamadas.length = 0;
    contagens.length = 0;
    rpcs.length = 0;
  });

  it("apaga a ficha inteira com UMA chamada de função — nenhuma tabela apagada pela rota", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    const out = await deleteContactHandler(clienteFalso() as never, ctxFalso(), CONTATO);
    expect(out).toEqual({ id: CONTATO });

    // O conserto da #1862: um só chamado, com a organização explícita. Os três
    // DELETE separados da versão antiga eram o que deixava histórico órfão.
    expect(chamadas).toEqual([]);
    expect(rpcs.filter((r) => r.nome === FUNCAO)).toEqual([
      { nome: FUNCAO, args: { p_contact_id: CONTATO, p_organization_id: ORG } },
    ]);

    // A pré-checagem da #752 continua contando com os DOIS filtros (contato +
    // organização): sem o de organização, contato de outra org bloquearia.
    expect(contagens).toEqual([
      {
        tabela: "calendar_appointments",
        filtros: [
          ["contact_id", CONTATO],
          ["organization_id", ORG],
        ],
      },
    ]);
    expect(ultimaAuditoria()).toMatchObject({
      action: "contact.deleted",
      resourceId: CONTATO,
      organizationId: ORG,
    });
  });

  it("compromissos visíveis: 409 com a contagem por situação, e a função nem é chamada", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    const visiveis = [
      compromisso({ id: "c05e7a00-0000-4000-8000-0000000000e1", status: "confirmed" }),
      compromisso({ id: "c05e7a00-0000-4000-8000-0000000000e2", status: "completed" }),
      // Cancelado SEM `excluded_at` aparece na Agenda: é histórico e segura.
      compromisso({ id: "c05e7a00-0000-4000-8000-0000000000e3", status: "cancelled" }),
      // Excluído e quitado com o Google: não segura, mas não salva a ficha.
      compromisso({ id: "c05e7a00-0000-4000-8000-0000000000e4", status: "cancelled", excluded_at: "2026-11-01T10:00:00Z" }),
    ];
    await expect(
      deleteContactHandler(clienteFalso({ compromissos: visiveis }) as never, ctxFalso(), CONTATO),
    ).rejects.toMatchObject({
      status: 409,
      code: "state_conflict",
      details: {
        vinculos: ["3 compromisso(s) na agenda"],
        por_tabela: { calendar_appointments: 3 },
        agenda: {
          por_situacao: { confirmed: 1, completed: 1, cancelled: 1 },
          pendentes_no_google: 0,
          compromisso_id: null,
        },
      },
    });
    // O ponto da issue #752: nada foi apagado antes de saber que a ficha não sai.
    expect(chamadas).toEqual([]);
    expect(rpcs.some((r) => r.nome === FUNCAO)).toBe(false);
    expect(auditSpy).not.toHaveBeenCalledWith(expect.objectContaining({ action: "contact.deleted" }));
    expect(ultimaAuditoria()).toMatchObject({
      action: "contact.delete_blocked",
      resourceId: CONTATO,
      organizationId: ORG,
      metadata: { motivo: "vinculo_restrict", vinculos: ["3 compromisso(s) na agenda"], apagados: [] },
    });
  });

  it("um só compromisso visível: o 409 aponta qual abrir na Agenda", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    const id = "c05e7a00-0000-4000-8000-0000000000e9";
    await expect(
      deleteContactHandler(
        clienteFalso({ compromissos: [compromisso({ id, status: "no_show" })] }) as never,
        ctxFalso(),
        CONTATO,
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: { agenda: { por_situacao: { no_show: 1 }, pendentes_no_google: 0, compromisso_id: id } },
    });
  });

  it("só compromissos excluídos: exclui tudo numa chamada e audita a contagem (incidente 13/11)", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    const excluidos = [
      // O caso do incidente: cancelado e excluído, nunca foi ao Google.
      compromisso({ id: "c05e7a00-0000-4000-8000-0000000000f1", status: "cancelled", excluded_at: "2026-11-10T12:00:00Z" }),
      // Foi ao Google e a retirada já foi confirmada (revisões iguais).
      compromisso({
        id: "c05e7a00-0000-4000-8000-0000000000f2",
        status: "cancelled",
        excluded_at: "2026-11-11T12:00:00Z",
        google_event_id: "evento-ficticio",
        google_local_revision: 3,
        google_synced_local_revision: 3,
      }),
    ];
    const out = await deleteContactHandler(
      clienteFalso({ compromissos: excluidos }) as never,
      ctxFalso(),
      CONTATO,
    );
    expect(out).toEqual({ id: CONTATO });
    expect(chamadas).toEqual([]);
    expect(rpcs.filter((r) => r.nome === FUNCAO)).toEqual([
      { nome: FUNCAO, args: { p_contact_id: CONTATO, p_organization_id: ORG } },
    ]);
    expect(ultimaAuditoria()).toMatchObject({
      action: "contact.deleted",
      resourceId: CONTATO,
      metadata: {
        compromissos_excluidos_apagados: 2,
        compromissos_ids: ["c05e7a00-0000-4000-8000-0000000000f1", "c05e7a00-0000-4000-8000-0000000000f2"],
      },
    });
  });

  it("excluído com o Google pendente: bloqueia e diz o motivo", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    const excluido = { status: "cancelled", excluded_at: "2026-11-10T12:00:00Z" };
    const pendencias = [
      compromisso({ ...excluido, google_pending_write: { method: "DELETE" } }),
      compromisso({ ...excluido, google_event_id: "evento-ficticio", google_local_revision: 4, google_synced_local_revision: 3 }),
      compromisso({ ...excluido, google_event_id: "evento-ficticio", google_local_revision: 3, google_synced_local_revision: 3, google_conflict: { reason: "missing" } }),
    ];
    for (const pendente of pendencias) {
      rpcs.length = 0;
      await expect(
        deleteContactHandler(clienteFalso({ compromissos: [pendente] }) as never, ctxFalso(), CONTATO),
      ).rejects.toMatchObject({
        status: 409,
        details: {
          vinculos: ["1 compromisso(s) excluído(s) ainda pendente(s) no Google"],
          por_tabela: { calendar_appointments: 1 },
          agenda: { por_situacao: {}, pendentes_no_google: 1, compromisso_id: null },
        },
      });
      expect(rpcs.some((r) => r.nome === FUNCAO)).toBe(false);
    }
  });

  it("isolamento: a leitura da agenda e a função levam a organização da sessão", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    await deleteContactHandler(clienteFalso() as never, ctxFalso(), CONTATO);
    expect(contagens).toEqual([
      { tabela: "calendar_appointments", filtros: [["contact_id", CONTATO], ["organization_id", ORG]] },
    ]);
    expect(rpcs.find((r) => r.nome === FUNCAO)?.args).toEqual({ p_contact_id: CONTATO, p_organization_id: ORG });
  });

  it("a função falha: audita apagados VAZIO e propaga o 409 (nada saiu pela metade)", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    await expect(
      deleteContactHandler(
        clienteFalso({ rpcErro: { code: "23503", message: "fk" } }) as never,
        ctxFalso(),
        CONTATO,
      ),
    ).rejects.toMatchObject({ status: 409, code: "state_conflict" });
    // Uma transação só: a falha da função desfaz tudo, então `apagados` é vazio
    // — e não mais "chegou até messages/conversations" (era o rastro do #1862).
    expect(chamadas).toEqual([]);
    expect(ultimaAuditoria()).toMatchObject({
      action: "contact.delete_blocked",
      resourceId: CONTATO,
      metadata: { motivo: "falha_ao_apagar", vinculos: [], apagados: [] },
    });
  });

  it("erro que não é RESTRICT vira 500, ainda sem tocar em tabela", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    await expect(
      deleteContactHandler(
        clienteFalso({ rpcErro: { code: "42501", message: "followup_job_internal" } }) as never,
        ctxFalso(),
        CONTATO,
      ),
    ).rejects.toMatchObject({ status: 500, code: "internal_error" });
    expect(chamadas).toEqual([]);
  });

  it("falha ao ler a agenda não segue apagando o histórico", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    await expect(
      deleteContactHandler(
        clienteFalso({ erroContagem: { message: "contagem fora do ar" } }) as never,
        ctxFalso(),
        CONTATO,
      ),
    ).rejects.toMatchObject({ status: 500, code: "internal_error" });
    expect(chamadas).toEqual([]);
    expect(rpcs.some((r) => r.nome === FUNCAO)).toBe(false);
  });

  it("a função devolve false (ficha inacessível): 404 sem auditar exclusão", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    await expect(
      deleteContactHandler(clienteFalso({ rpcFalse: true }) as never, ctxFalso(), CONTATO),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(auditSpy).not.toHaveBeenCalledWith(expect.objectContaining({ action: "contact.deleted" }));
  });

  it("404 se o contato não existe na org", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    await expect(
      deleteContactHandler(clienteFalso({ missing: true }) as never, ctxFalso(), CONTATO),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(auditSpy).not.toHaveBeenCalled();
    expect(rpcs.some((r) => r.nome === FUNCAO)).toBe(false);
  });
});
