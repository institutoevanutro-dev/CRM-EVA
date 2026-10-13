/**
 * A ACTION DE "PACIENTES PELO CADASTRO" — o que o Postgres não vê.
 *
 * Quem decide é o corpo de `fn_definir_paciente_pelo_cadastro`, provado em
 * `tests/invariants/paciente-pelo-cadastro.test.ts`. Aqui ficam as coisas da
 * action que nenhum banco enxerga:
 *
 *   1. a organização vem da SESSÃO (`resolveActiveOrg`), nunca de argumento;
 *   2. quem não é admin, ou está em suporte somente leitura, nem chega à RPC;
 *   3. a PRÉVIA (o número mostrado antes de confirmar) não grava, não audita e
 *      não invalida nada;
 *   4. a auditoria sai só quando algo mudou, com as contagens, ao ligar E ao
 *      desligar, e o layout é invalidado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";

let papel = "admin";
let suporte: Record<string, unknown> | null = null;
let respostaDaRpc: { data: unknown; error: { code: string; message: string } | null } = {
  data: null,
  error: null,
};
const rpc = vi.fn(async (_nome: string, _args: Record<string, unknown>) => respostaDaRpc);
const auditadas: Array<Record<string, unknown>> = [];
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (e: Record<string, unknown>) => {
    auditadas.push(e);
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: USER, is_platform_admin: false, support: suporte })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Clínica", role: papel })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: (nome: string, args: Record<string, unknown>) => rpc(nome, args) }),
}));

const { definirPacientePeloCadastro, contarPacientesPeloCadastro } = await import(
  "@/app/actions/settings/definirPacientePeloCadastro"
);

const CONTAGEM = { pacientes: 1200, ja_clientes_pela_agenda: 130, tem_funil_de_clientes: false };
const LIGOU = { ligado: true, mudou: true, ...CONTAGEM };
const PREVIA = { ligado: false, mudou: false, ...CONTAGEM };

beforeEach(() => {
  papel = "admin";
  suporte = null;
  respostaDaRpc = { data: LIGOU, error: null };
  rpc.mockClear();
  revalidatePath.mockClear();
  auditadas.length = 0;
});

describe("definirPacientePeloCadastro", () => {
  it.each(["manager", "agent", "viewer"])("%s → sem_permissao, e a RPC NÃO é chamada", async (p) => {
    papel = p;
    expect(await definirPacientePeloCadastro(true)).toEqual({ ok: false, erro: "sem_permissao" });
    expect(await contarPacientesPeloCadastro()).toEqual({ ok: false, erro: "sem_permissao" });
    expect(rpc).not.toHaveBeenCalled();
    expect(auditadas).toEqual([]);
  });

  it("suporte somente leitura → somente_leitura, e a RPC não é chamada", async () => {
    suporte = {
      id: "s",
      organization_id: ORG,
      actor_user_id: USER,
      auth_session_id: "a",
      previous_organization_id: null,
      expires_at: "2099-01-01",
      name: "Clínica",
      locale: null,
      access_mode: "support_readonly",
      status: "active",
    };
    expect(await definirPacientePeloCadastro(true)).toEqual({ ok: false, erro: "somente_leitura" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("admin → a RPC recebe a organização DA SESSÃO, e grava", async () => {
    await definirPacientePeloCadastro(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("fn_definir_paciente_pelo_cadastro", {
      p_org: ORG,
      p_ligado: true,
      p_so_contar: false,
    });
  });

  it("entrada que não é booleano (a action é endpoint público) não chega à RPC", async () => {
    const qualquer: unknown = "true";
    expect(await definirPacientePeloCadastro(qualquer as boolean)).toEqual({ ok: false, erro: "falha" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("42501 com mfa_required → mfa; 42501 sem → sem_permissao; erro qualquer → falha", async () => {
    respostaDaRpc = { data: null, error: { code: "42501", message: "paciente_pelo_cadastro_mfa_required" } };
    expect(await definirPacientePeloCadastro(true)).toEqual({ ok: false, erro: "mfa" });
    respostaDaRpc = { data: null, error: { code: "42501", message: "paciente_pelo_cadastro_forbidden" } };
    expect(await definirPacientePeloCadastro(true)).toEqual({ ok: false, erro: "sem_permissao" });
    respostaDaRpc = { data: null, error: { code: "XX000", message: "qualquer" } };
    expect(await definirPacientePeloCadastro(true)).toEqual({ ok: false, erro: "falha" });
    expect(auditadas).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("corpo inesperado da RPC → falha, sem auditoria", async () => {
    respostaDaRpc = { data: { ligado: true }, error: null };
    expect(await definirPacientePeloCadastro(true)).toEqual({ ok: false, erro: "falha" });
    expect(auditadas).toEqual([]);
  });

  it("ligou → auditoria com as contagens e o layout invalidado; devolve o corpo da RPC", async () => {
    expect(await definirPacientePeloCadastro(true)).toEqual({ ok: true, ...LIGOU });
    expect(auditadas).toEqual([
      expect.objectContaining({
        action: "crm.paciente_pelo_cadastro_alterado",
        actorUserId: USER,
        organizationId: ORG,
        resourceType: "organization",
        resourceId: ORG,
        metadata: LIGOU,
      }),
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/app", "layout");
  });

  it("desligou → também audita, com ligado: false", async () => {
    const desligou = { ligado: false, mudou: true, ...CONTAGEM };
    respostaDaRpc = { data: desligou, error: null };
    expect(await definirPacientePeloCadastro(false)).toEqual({ ok: true, ...desligou });
    expect(rpc).toHaveBeenCalledWith("fn_definir_paciente_pelo_cadastro", {
      p_org: ORG,
      p_ligado: false,
      p_so_contar: false,
    });
    expect(auditadas).toHaveLength(1);
    expect(auditadas[0]).toMatchObject({ metadata: desligou });
  });

  it("não mudou (já estava ligada) → sem auditoria", async () => {
    respostaDaRpc = { data: { ...LIGOU, mudou: false }, error: null };
    expect(await definirPacientePeloCadastro(true)).toMatchObject({ ok: true, mudou: false });
    expect(auditadas).toEqual([]);
  });
});

describe("contarPacientesPeloCadastro (a prévia antes de confirmar)", () => {
  it("chama a RPC SÓ PARA CONTAR, com a organização da sessão", async () => {
    respostaDaRpc = { data: PREVIA, error: null };
    expect(await contarPacientesPeloCadastro()).toEqual({ ok: true, ...PREVIA });
    expect(rpc).toHaveBeenCalledWith("fn_definir_paciente_pelo_cadastro", {
      p_org: ORG,
      p_ligado: true,
      p_so_contar: true,
    });
  });

  it("não audita e não invalida nada: contar não é mutação", async () => {
    respostaDaRpc = { data: PREVIA, error: null };
    await contarPacientesPeloCadastro();
    expect(auditadas).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("recusa de MFA chega ANTES do diálogo", async () => {
    respostaDaRpc = { data: null, error: { code: "42501", message: "paciente_pelo_cadastro_mfa_required" } };
    expect(await contarPacientesPeloCadastro()).toEqual({ ok: false, erro: "mfa" });
  });
});
