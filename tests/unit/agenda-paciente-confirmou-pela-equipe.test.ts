/**
 * "PACIENTE CONFIRMOU" PELA EQUIPE — o PATCH `/api/v1/agenda/agendamentos` com
 * `patient_confirmed: true` (migration 0441, decisão 8 da spec
 * docs/superpowers/specs/2026-11-28-paciente-confirma-pelo-lembrete-design.md).
 *
 * A recepção marca quando o paciente confirma por telefone. Provado pela ROTA
 * inteira: papel, organização da sessão (o RPC não recebe organização, então a
 * rota confere ANTES de chamá-lo), revisão do pedido, o RPC pelo client de
 * serviço (só `service_role` o executa), os três desfechos e os efeitos
 * (auditoria e timeline) só quando houve confirmação.
 *
 * A regra do banco (status, horário futuro, revisão, já confirmado) mora em
 * `tests/invariants/` da 0441; aqui o RPC é um dublê que devolve o desfecho.
 *
 *     npx vitest run tests/unit/agenda-paciente-confirmou-pela-equipe.test.ts
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const OUTRA_ORG = "aaaaaaaa-0000-4000-8000-00000000000b";
const USUARIO = "bbbbbbbb-0000-4000-8000-00000000000b";
const CONTATO = "dddddddd-0000-4000-8000-00000000000d";
const NEGOCIO = "eeeeeeee-0000-4000-8000-00000000000e";
const ID = "ffffffff-0000-4000-8000-00000000000f";
const ID_ALHEIO = "ffffffff-0000-4000-8000-0000000000ff";

type Linha = Record<string, unknown>;
const RANK = { viewer: 1, agent: 2, manager: 3, admin: 4 } as const;
type Papel = keyof typeof RANK;

const estado = vi.hoisted(() => ({
  papel: "agent" as string,
  linhas: [] as Record<string, unknown>[],
  leads: [] as Record<string, unknown>[],
  desfecho: "confirmado" as string,
  erroDoRpc: null as { code: string; message: string } | null,
  rpcDeServico: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcDaSessao: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  inserido: {} as Record<string, Record<string, unknown>[]>,
  /** A releitura de `calendar_appointments` falha DEPOIS que o RPC já gravou. */
  releituraQuebra: false,
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: () => true }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async (min: Papel) => {
    if (RANK[estado.papel as Papel] < RANK[min]) {
      return { ok: false, response: Response.json({ error: { code: "forbidden_role" } }, { status: 403 }) };
    }
    return { ok: true, org: { orgId: ORG, role: estado.papel }, user: { id: USUARIO, idioma: "pt-BR" } };
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => sessao()) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => servico()) }));

const { PATCH } = await import("@/app/api/v1/agenda/agendamentos/route");
const { audit } = await import("@/lib/audit");

/** O client da SESSÃO: lê com o filtro de organização aplicado de verdade. Não executa o RPC (como no banco). */
function sessao() {
  return {
    from: (tabela: string) => {
      const filtros: Array<[string, unknown]> = [];
      const daTabela = () =>
        tabela === "calendar_appointments"
          ? ((l) => (l ? { ...l } : null))(estado.linhas.find((l) => filtros.every(([c, v]) => l[c] === v)))
          : null;
      const cadeia: Record<string, unknown> = {
        select: () => cadeia,
        eq: (coluna: string, valor: unknown) => {
          filtros.push([coluna, valor]);
          return cadeia;
        },
        maybeSingle: async () =>
          estado.releituraQuebra && tabela === "calendar_appointments" && estado.rpcDeServico.length > 0
            ? { data: null, error: { message: "boom na releitura" } }
            : { data: daTabela(), error: null },
        then: (r: (v: unknown) => unknown) =>
          r({ data: tabela === "crm_leads" ? estado.leads : daTabela(), error: null }),
        insert: (linha: Linha) => {
          (estado.inserido[tabela] ??= []).push(linha);
          return { then: (r: (v: unknown) => unknown) => r({ data: null, error: null }) };
        },
      };
      return cadeia;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      estado.rpcDaSessao.push({ fn, args });
      return fn === "fn_appointment_patient_confirm"
        ? { data: null, error: { code: "42501", message: "permission denied for function" } }
        : { data: null, error: null };
    },
  };
}

/** O client de SERVIÇO: o único que executa `fn_appointment_patient_confirm`. */
function servico() {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      estado.rpcDeServico.push({ fn, args });
      if (estado.erroDoRpc) return { data: null, error: estado.erroDoRpc };
      if (estado.desfecho === "confirmado") {
        Object.assign(estado.linhas.find((l) => l.id === args.p_appointment_id) ?? {}, {
          patient_confirmed_at: "2026-11-28T15:00:00.000Z",
          patient_confirmed_source: args.p_source,
          patient_confirmed_user_id: args.p_user_id,
        });
      }
      return { data: estado.desfecho, error: null };
    },
  };
}

function linha(extra: Linha = {}): Linha {
  return {
    id: ID,
    organization_id: ORG,
    contact_id: CONTATO,
    status: "confirmed",
    revision: 4,
    patient_confirmed_at: null,
    patient_confirmed_source: null,
    patient_confirmed_user_id: null,
    ...extra,
  };
}

async function marcar(corpo: unknown) {
  const res = await PATCH(
    new NextRequest("http://x/api/v1/agenda/agendamentos", { method: "PATCH", body: JSON.stringify(corpo) }),
  );
  return { status: res.status, corpo: (await res.json()) as { data?: Linha; error?: { code: string } } };
}

const confirmacoes = () => estado.rpcDeServico.filter((c) => c.fn === "fn_appointment_patient_confirm");
const auditorias = () => vi.mocked(audit).mock.calls.map((c) => c[0] as unknown as Record<string, unknown>);
const atividades = () => estado.inserido["crm_lead_activities"] ?? [];

beforeEach(() => {
  vi.mocked(audit).mockClear();
  estado.papel = "agent";
  estado.linhas = [linha(), linha({ id: ID_ALHEIO, organization_id: OUTRA_ORG })];
  estado.leads = [
    { id: NEGOCIO, organization_id: ORG, pipeline_id: "p-1", status: "open", last_activity_at: null, created_at: "2026-11-01T10:00:00Z" },
  ];
  estado.desfecho = "confirmado";
  estado.erroDoRpc = null;
  estado.rpcDeServico = [];
  estado.rpcDaSessao = [];
  estado.inserido = {};
  estado.releituraQuebra = false;
});

describe("a equipe marca 'Paciente confirmou'", () => {
  it("viewer não marca (403) e o RPC nem é chamado", async () => {
    estado.papel = "viewer";
    const r = await marcar({ id: ID, revision: 4, patient_confirmed: true });
    expect(r.status).toBe(403);
    expect(confirmacoes()).toEqual([]);
  });

  it.each(["agent", "manager", "admin"])("%s marca: o RPC recebe a origem equipe, a pessoa da sessão e a revisão do pedido", async (papel) => {
    estado.papel = papel;
    const r = await marcar({ id: ID, revision: 4, patient_confirmed: true });
    expect(r.status).toBe(200);
    expect(confirmacoes()).toEqual([
      {
        fn: "fn_appointment_patient_confirm",
        args: { p_appointment_id: ID, p_expected_revision: 4, p_source: "equipe", p_message_id: null, p_user_id: USUARIO },
      },
    ]);
    // Pela sessão o RPC é recusado (só service_role o executa): ele não pode ir por lá.
    expect(estado.rpcDaSessao.map((c) => c.fn)).not.toContain("fn_appointment_patient_confirm");
  });

  it("confirmado: devolve os campos novos, audita e grava a atividade na timeline", async () => {
    const r = await marcar({ id: ID, revision: 4, patient_confirmed: true });
    expect(r.corpo.data).toMatchObject({
      id: ID,
      revision: 4,
      patient_confirmed_at: "2026-11-28T15:00:00.000Z",
      patient_confirmed_source: "equipe",
    });
    expect(r.corpo.data).not.toHaveProperty("ja_estava");
    expect(auditorias()).toEqual([
      expect.objectContaining({
        action: "agenda.paciente_confirmou",
        actorUserId: USUARIO,
        organizationId: ORG,
        resourceType: "calendar_appointment",
        resourceId: ID,
        metadata: { appointment_id: ID, source: "equipe" },
      }),
    ]);
    expect(atividades()).toEqual([
      expect.objectContaining({
        organization_id: ORG,
        lead_id: NEGOCIO,
        contact_id: CONTATO,
        type: "appointment_patient_confirmed",
        source_module: "agenda",
        source_id: ID,
        actor_kind: "user",
      }),
    ]);
  });

  it("confirmado e a releitura falha: a auditoria e a atividade saem mesmo assim", async () => {
    // Sem isto, a confirmação ficava gravada sem rastro, e o retry da tela cai em
    // `ja_confirmado`, que não grava nada: a perda seria permanente.
    estado.releituraQuebra = true;
    const r = await marcar({ id: ID, revision: 4, patient_confirmed: true });
    expect(r.status).toBe(500);
    expect(confirmacoes()).toHaveLength(1);
    expect(auditorias()).toEqual([expect.objectContaining({ action: "agenda.paciente_confirmou", resourceId: ID })]);
    expect(atividades()).toEqual([expect.objectContaining({ type: "appointment_patient_confirmed", source_id: ID })]);
  });

  it("já confirmado: 200 idempotente, sem segunda auditoria nem atividade", async () => {
    estado.desfecho = "ja_confirmado";
    estado.linhas[0] = linha({ patient_confirmed_at: "2026-11-27T12:00:00.000Z", patient_confirmed_source: "mensagem" });
    const r = await marcar({ id: ID, revision: 4, patient_confirmed: true });
    expect(r.status).toBe(200);
    expect(r.corpo.data).toMatchObject({ id: ID, patient_confirmed_source: "mensagem", ja_estava: true });
    expect(auditorias()).toEqual([]);
    expect(atividades()).toEqual([]);
  });

  it("não se aplica (passado, pendente, cancelado ou revisão antiga): 409 com o código canônico", async () => {
    estado.desfecho = "nao_se_aplica";
    const r = await marcar({ id: ID, revision: 3, patient_confirmed: true });
    expect(r.status).toBe(409);
    expect(r.corpo.error?.code).toBe("appointment_patient_confirmation_not_applicable");
    expect(auditorias()).toEqual([]);
    expect(atividades()).toEqual([]);
  });

  it("compromisso sem paciente (pessoal): 409 sem chamar o RPC", async () => {
    estado.linhas[0] = linha({ contact_id: null });
    const r = await marcar({ id: ID, revision: 4, patient_confirmed: true });
    expect(r.status).toBe(409);
    expect(r.corpo.error?.code).toBe("appointment_patient_confirmation_not_applicable");
    expect(confirmacoes()).toEqual([]);
  });

  it("compromisso de OUTRA organização é 404, e o RPC (que não recebe organização) nem é chamado", async () => {
    const r = await marcar({ id: ID_ALHEIO, revision: 4, patient_confirmed: true, organization_id: OUTRA_ORG });
    expect(r.status).toBe(404);
    expect(confirmacoes()).toEqual([]);
  });

  it("erro do RPC é 500, sem auditoria", async () => {
    estado.erroDoRpc = { code: "XX000", message: "boom" };
    const r = await marcar({ id: ID, revision: 4, patient_confirmed: true });
    expect(r.status).toBe(500);
    expect(auditorias()).toEqual([]);
  });

  it.each([
    ["sem revisão", { id: ID, patient_confirmed: true }],
    ["com situação", { id: ID, revision: 4, patient_confirmed: true, status: "completed" }],
    ["com horário novo", { id: ID, revision: 4, patient_confirmed: true, starts_at: "2026-12-01T13:00:00.000Z" }],
    ["com duração", { id: ID, revision: 4, patient_confirmed: true, duration_minutes: 45 }],
    ["com anotação", { id: ID, revision: 4, patient_confirmed: true, notes: "x" }],
    ["false", { id: ID, revision: 4, patient_confirmed: false }],
  ])("a ação vem sozinha e com a revisão (%s → 422)", async (_caso, corpo) => {
    const r = await marcar(corpo);
    expect(r.status).toBe(422);
    expect(confirmacoes()).toEqual([]);
  });
});
