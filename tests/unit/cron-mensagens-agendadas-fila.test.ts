import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A FILA NÃO TRAVA: o que a rodada pula sai do lote (revisão do porte do
 * DeskcommCRM #4131). Antes, 50 linhas presas num número desconectado com
 * "esperar" ocupavam o lote inteiro a cada minuto, e as de outros números
 * nunca saíam.
 */
type Chamada = { tabela: string; ops: Array<[string, unknown[]]> };
const chamadas: Chamada[] = [];
let devidas: Array<Record<string, unknown>> = [];
let linhas: Record<string, Record<string, unknown>> = {};

function fakeAdmin() {
  return {
    from(tabela: string) {
      const c: Chamada = { tabela, ops: [] };
      chamadas.push(c);
      const q: Record<string, unknown> = {};
      for (const op of ["select", "eq", "lte", "or", "order", "limit", "update", "is"]) {
        q[op] = (...args: unknown[]) => (c.ops.push([op, args]), q);
      }
      const resultado = () => {
        const update = c.ops.find(([op]) => op === "update");
        const id = c.ops.find(([op, a]) => op === "eq" && a[0] === "id")?.[1][1] as string | undefined;
        if (!update) return { data: tabela === "mensagens_agendadas" ? devidas : null, error: null };
        const temSelect = c.ops.some(([op]) => op === "select");
        return { data: temSelect && id ? [linhas[id]] : null, error: null };
      };
      q.maybeSingle = async () => ({ data: null, error: null });
      q.then = (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) => Promise.resolve(resultado()).then(ok, erro);
      return q;
    },
  };
}

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin() }));
vi.mock("@/lib/automation/janela-do-canal", () => ({ adiarAteAJanelaAbrir: vi.fn(async () => null) }));
const conectados = new Set<string>();
const encaminhar = vi.fn(async (_a: unknown, ag: { id: string }) => ({ desfecho: "encaminhada", message_id: `m-${ag.id}` }));
vi.mock("@/lib/agendamento-mensagem/envio", () => ({
  autorAindaTemAcesso: async () => true,
  sessaoEstaConectada: async (_a: unknown, _o: string, sessao: string) => conectados.has(sessao),
  encaminharAgendamento: (a: unknown, ag: { id: string }) => encaminhar(a, ag),
}));

const linha = (id: string, sessao: string, minutosAtras = 1) => ({
  id,
  organization_id: "org-1",
  contact_id: "c-1",
  channel_session_id: sessao,
  created_by_user_id: "u-1",
  body: "Lembrete fictício",
  scheduled_at: new Date(Date.now() - minutosAtras * 60_000).toISOString(),
  se_desconectado: "esperar",
});

beforeEach(() => {
  chamadas.length = 0;
  conectados.clear();
  encaminhar.mockClear();
});

async function rodar() {
  const { POST } = await import("@/app/api/v1/cron/mensagens-agendadas/route");
  return POST(new NextRequest("http://localhost/api/v1/cron/mensagens-agendadas", { method: "POST" }));
}

describe("cron de mensagens agendadas — fila", () => {
  it("a consulta do lote exclui org parada e o que está adiado", async () => {
    devidas = [];
    linhas = {};
    await rodar();
    const lote = chamadas[0]!;
    expect(lote.ops).toContainEqual(["eq", ["organizations.status", "active"]]);
    const or = lote.ops.find(([op]) => op === "or")?.[1][0] as string;
    expect(or).toMatch(/^adiada_ate\.is\.null,adiada_ate\.lte\./);
  });

  it("número fora com 'esperar' é ADIADO (sai do lote), e o de outro número sai", async () => {
    const presa = linha("presa", "numero-fora");
    const livre = linha("livre", "numero-ok");
    devidas = [presa, livre].map(({ id, organization_id }) => ({ id, organization_id, organizations: { status: "active" } }));
    linhas = { presa, livre };
    conectados.add("numero-ok");

    await rodar();

    const adiamento = chamadas.find(
      (c) =>
        c.ops.some(([op, a]) => op === "eq" && a[1] === "presa") &&
        c.ops.some(([op, a]) => op === "update" && (a[0] as Record<string, unknown>).adiada_ate),
    );
    const ate = new Date((adiamento!.ops.find(([op]) => op === "update")![1][0] as { adiada_ate: string }).adiada_ate);
    expect(ate.getTime()).toBeGreaterThan(Date.now());
    expect(encaminhar).toHaveBeenCalledTimes(1);
    expect(encaminhar.mock.calls[0]![1]).toMatchObject({ id: "livre" });
  });

  it("atrasada há mais de 12h é cancelada como expirada, sem envio", async () => {
    const velha = linha("velha", "numero-ok", 13 * 60);
    devidas = [{ id: "velha", organization_id: "org-1", organizations: { status: "active" } }];
    linhas = { velha };
    conectados.add("numero-ok");

    await rodar();

    expect(encaminhar).not.toHaveBeenCalled();
    const desfecho = chamadas.find((c) =>
      c.ops.some(([op, a]) => op === "update" && (a[0] as Record<string, unknown>).status === "cancelada"),
    );
    expect(desfecho!.ops.find(([op]) => op === "update")![1][0]).toMatchObject({ motivo: "expirada" });
  });
});
