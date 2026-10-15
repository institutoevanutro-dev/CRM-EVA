/**
 * `POST /api/v1/agenda/agendamentos/:id/excluir` — a porta do "lançado por
 * engano" (migration 0364), provada pela ROTA inteira: papel, organização da
 * sessão, motivo, idempotência e o que NÃO pode sair (o gatilho
 * `appointment.cancelled`, que avisaria o paciente).
 *
 * O dublê do banco aplica o filtro de organização de verdade: a linha de outra
 * organização só some porque `exigeAgendamento` filtra pela organização da
 * SESSÃO, nunca do corpo. A regra do banco (papel, constraint, guarda) mora em
 * `tests/invariants/agenda-excluir-agendamento.test.ts`.
 *
 *     npx vitest run tests/unit/agenda-excluir-agendamento-rota.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const OUTRA_ORG = "aaaaaaaa-0000-4000-8000-00000000000b";
const USUARIO = "bbbbbbbb-0000-4000-8000-00000000000b";
const ID = "ffffffff-0000-4000-8000-00000000000f";
const ID_ALHEIO = "ffffffff-0000-4000-8000-0000000000ff";

type Linha = Record<string, unknown>;
const RANK = { viewer: 1, agent: 2, manager: 3, admin: 4 } as const;
type Papel = keyof typeof RANK;

const estado = vi.hoisted(() => ({
  papel: "manager" as string,
  linhas: [] as Record<string, unknown>[],
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  erroDoBanco: null as { code: string; message: string } | null,
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: () => true }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async (min: Papel) => {
    if (RANK[estado.papel as Papel] < RANK[min]) {
      return { ok: false, response: Response.json({ error: { code: "forbidden" } }, { status: 403 }) };
    }
    return { ok: true, org: { orgId: ORG, role: estado.papel }, user: { id: USUARIO, idioma: "pt-BR" } };
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => banco()) }));

const { POST } = await import("@/app/api/v1/agenda/agendamentos/[id]/excluir/route");
const { audit } = await import("@/lib/audit");

function banco() {
  return {
    from: (tabela: string) => {
      const filtros: Array<[string, unknown]> = [];
      const cadeia: Record<string, unknown> = {
        select: () => cadeia,
        eq: (coluna: string, valor: unknown) => {
          filtros.push([coluna, valor]);
          return cadeia;
        },
        maybeSingle: async () => ({
          data:
            tabela === "calendar_appointments"
              ? ((l) => (l ? { ...l } : null))(estado.linhas.find((l) => filtros.every(([c, v]) => l[c] === v)))
              : null,
          error: null,
        }),
      };
      return cadeia;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      estado.rpc.push({ fn, args });
      if (fn !== "fn_appointment_exclude") return { data: null, error: null };
      if (estado.erroDoBanco) return { data: null, error: estado.erroDoBanco };
      const linha = estado.linhas.find((l) => l.organization_id === args.p_org && l.id === args.p_id);
      if (!linha) return { data: null, error: { code: "P0002", message: "appointment_not_found" } };
      Object.assign(linha, { status: "cancelled", excluded_at: "2026-10-15T12:00:00Z", exclusion_reason: args.p_reason });
      return { data: { ...linha }, error: null };
    },
  };
}

function linha(extra: Linha = {}): Linha {
  return {
    id: ID,
    organization_id: ORG,
    contact_id: null,
    event_type_id: null,
    status: "confirmed",
    time_zone: "America/Sao_Paulo",
    excluded_at: null,
    ...extra,
  };
}

async function excluir(id: string, corpo: unknown) {
  const res = await POST(
    new Request(`http://x/api/v1/agenda/agendamentos/${id}/excluir`, { method: "POST", body: JSON.stringify(corpo) }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, corpo: (await res.json()) as { data?: Linha; error?: { code: string } } };
}

const auditorias = () =>
  vi.mocked(audit).mock.calls.map((c) => c[0] as { action: string; metadata?: Record<string, unknown> });

beforeEach(() => {
  vi.mocked(audit).mockClear();
  estado.papel = "manager";
  estado.linhas = [linha(), linha({ id: ID_ALHEIO, organization_id: OUTRA_ORG })];
  estado.rpc = [];
  estado.erroDoBanco = null;
});

describe("excluir agendamento lançado por engano: a rota", () => {
  it.each(["viewer", "agent"])("%s não exclui (403) e o banco nem é chamado", async (papel) => {
    estado.papel = papel;
    const r = await excluir(ID, { reason: "teste do sistema" });
    expect(r.status).toBe(403);
    expect(estado.rpc).toEqual([]);
  });

  it.each(["manager", "admin"])("%s exclui, com auditoria agenda.appointment_excluded e o motivo", async (papel) => {
    estado.papel = papel;
    const r = await excluir(ID, { reason: "  teste do sistema " });
    expect(r.status).toBe(200);
    expect(r.corpo.data?.excluded_at).toBeTruthy();
    expect(estado.rpc).toEqual([
      { fn: "fn_appointment_exclude", args: { p_org: ORG, p_id: ID, p_reason: "teste do sistema" } },
    ]);
    expect(auditorias()).toEqual([
      expect.objectContaining({
        action: "agenda.appointment_excluded",
        metadata: { reason: "teste do sistema", status_anterior: "confirmed" },
      }),
    ]);
  });

  it("NÃO emite appointment.cancelled: nenhuma automação fala com o paciente", async () => {
    await excluir(ID, { reason: "lançado no paciente errado" });
    expect(estado.rpc.map((c) => c.fn)).not.toContain("emit_event");
  });

  it.each([{}, { reason: "" }, { reason: " ab " }])("motivo obrigatório (%j → 422)", async (corpo) => {
    const r = await excluir(ID, corpo);
    expect(r.status).toBe(422);
    expect(estado.rpc).toEqual([]);
  });

  it("compromisso de OUTRA organização é 404, e a organização do corpo é ignorada", async () => {
    const r = await excluir(ID_ALHEIO, { reason: "teste do sistema", organization_id: OUTRA_ORG });
    expect(r.status).toBe(404);
    expect(estado.rpc).toEqual([]);
    expect(estado.linhas.find((l) => l.id === ID_ALHEIO)?.excluded_at).toBeNull();
  });

  it("idempotente: excluir de novo devolve o mesmo estado, sem segunda auditoria", async () => {
    await excluir(ID, { reason: "teste do sistema" });
    const segunda = await excluir(ID, { reason: "outro motivo" });
    expect(segunda.status).toBe(200);
    expect(segunda.corpo.data).toMatchObject({ id: ID, status: "cancelled", ja_estava: true });
    expect(estado.rpc.filter((c) => c.fn === "fn_appointment_exclude")).toHaveLength(1);
    expect(auditorias()).toHaveLength(1);
    expect(estado.linhas[0]?.exclusion_reason).toBe("teste do sistema");
  });

  it("compromisso já CANCELADO também é excluído", async () => {
    estado.linhas[0] = linha({ status: "cancelled" });
    const r = await excluir(ID, { reason: "teste do sistema" });
    expect(r.status).toBe(200);
    expect(r.corpo.data?.excluded_at).toBeTruthy();
    expect(auditorias()[0]?.metadata).toMatchObject({ status_anterior: "cancelled" });
  });

  it("a recusa de papel do banco (42501) vira 403, não 500", async () => {
    estado.erroDoBanco = { code: "42501", message: "appointment_exclusion_forbidden" };
    const r = await excluir(ID, { reason: "teste do sistema" });
    expect(r.status).toBe(403);
    expect(auditorias()).toEqual([]);
  });
});
