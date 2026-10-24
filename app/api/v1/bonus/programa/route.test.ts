import { beforeEach, describe, expect, it, vi } from "vitest";

const APROVADOR = "11111111-1111-4111-8111-111111111111";
const PARTICIPANTE = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";
const DONO = "44444444-4444-4444-8444-444444444444";
const OUTRO_ADMIN = "55555555-5555-4555-8555-555555555555";

// `vi.hoisted`: as fábricas de `vi.mock` sobem para o topo do arquivo.
const estado = vi.hoisted(() => ({
  auditados: [] as unknown[],
  atualizados: [] as unknown[],
  filtros: [] as [string, string, unknown][],
  quemPede: "",
  platformAdmin: false,
  aprovadorNaEquipe: true,
  membro: true,
}));
const { auditados, atualizados } = estado;

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: async (e: unknown) => void estado.auditados.push(e) }));
vi.mock("@/lib/tarefas/responsavel", () => ({ responsavelValido: async () => estado.membro }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: {
      id: estado.quemPede,
      idioma: "pt-BR",
      is_platform_admin: estado.platformAdmin,
      platform_admin_scope: estado.platformAdmin ? "full" : null,
      support: null,
    },
    org: { orgId: "33333333-3333-4333-8333-333333333333", role: "admin" },
  }),
}));
vi.mock("@/lib/bonus/fatos", async () => {
  const { regrasSchema } = await import("@/lib/bonus/regras");
  return {
    lerPrograma: async () => ({
      status: "ok",
      programa: {
        id: "prog",
        organizationId: ORG,
        aprovadorUserId: APROVADOR,
        ativo: true,
        regras: regrasSchema.parse({ participantes: [PARTICIPANTE], tarefas: { valor_cents: 20_000 } }),
        fuso: "America/Sao_Paulo",
        etapasDeSinalPago: [],
        inicio: "2026-01-01",
      },
    }),
  };
});
vi.mock("@/lib/supabase/admin", () => {
  // Uma cadeia por tabela: `organizations` responde o dono, `user_organizations`
  // se o aprovador segue na equipe, `bonus_programas` grava. Cada filtro fica
  // guardado com a tabela e a operação, para afirmar o filtro DO UPDATE.
  const cadeia = (onde: string, resposta: () => unknown) => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.is = () => c;
    c.eq = (coluna: string, valor: unknown) => {
      estado.filtros.push([onde, coluna, valor]);
      return c;
    };
    c.maybeSingle = async () => ({ data: resposta(), error: null });
    return c;
  };
  return {
    createAdminClient: () => ({
      from: (tabela: string) => {
        if (tabela === "organizations") return cadeia("organizations.select", () => ({ created_by: DONO }));
        if (tabela === "user_organizations") {
          return cadeia("user_organizations.select", () => (estado.aprovadorNaEquipe ? { id: "vinculo" } : null));
        }
        return {
          update: (v: unknown) => {
            estado.atualizados.push(v);
            return cadeia(`${tabela}.update`, () => ({ id: "prog" }));
          },
        };
      },
    }),
  };
});

import { GET, PUT } from "./route";

const pedido = (corpo: unknown) =>
  new Request("http://x/api/v1/bonus/programa", { method: "PUT", body: JSON.stringify(corpo) }) as never;

describe("PUT /api/v1/bonus/programa", () => {
  beforeEach(() => {
    auditados.length = 0;
    atualizados.length = 0;
    estado.filtros.length = 0;
    estado.platformAdmin = false;
    estado.aprovadorNaEquipe = true;
    estado.membro = true;
  });

  it("admin participante (não aprovador) leva 403, e nada é gravado nem auditado", async () => {
    estado.quemPede = PARTICIPANTE;
    const res = await PUT(pedido({ regras: { participantes: [PARTICIPANTE], tarefas: { valor_cents: 99_999 } } }));
    expect(res.status).toBe(403);
    expect(atualizados).toEqual([]);
    expect(auditados).toEqual([]);
  });

  it("participante não se torna aprovador", async () => {
    estado.quemPede = PARTICIPANTE;
    const res = await PUT(pedido({ aprovador_user_id: PARTICIPANTE }));
    expect(res.status).toBe(403);
  });

  it("o aprovador grava, e a auditoria não leva valor nenhum", async () => {
    estado.quemPede = APROVADOR;
    const res = await PUT(pedido({ regras: { participantes: [PARTICIPANTE], tarefas: { valor_cents: 25_000 } } }));
    expect(res.status).toBe(200);
    expect(atualizados).toHaveLength(1);
    expect(JSON.stringify(auditados)).not.toContain("25000");
    expect(auditados).toEqual([expect.objectContaining({ action: "bonus.regras_alteradas", metadata: { chaves: ["tarefas"] } })]);
  });

  it("`ativo` igual ao atual não entra nas chaves alteradas", async () => {
    estado.quemPede = APROVADOR;
    const res = await PUT(pedido({ ativo: true, regras: { participantes: [PARTICIPANTE], tarefas: { valor_cents: 25_000 } } }));
    expect(res.status).toBe(200);
    expect(auditados).toEqual([expect.objectContaining({ metadata: { chaves: ["tarefas"] } })]);
  });

  it("desligar o programa audita a chave `ativo`", async () => {
    estado.quemPede = APROVADOR;
    expect((await PUT(pedido({ ativo: false }))).status).toBe(200);
    expect(auditados).toEqual([expect.objectContaining({ action: "bonus.regras_alteradas", metadata: { chaves: ["ativo"] } })]);
  });
});

describe("PUT /api/v1/bonus/programa: assumir quando o aprovador saiu", () => {
  beforeEach(() => {
    auditados.length = 0;
    atualizados.length = 0;
    estado.filtros.length = 0;
    estado.platformAdmin = false;
    estado.aprovadorNaEquipe = false;
    estado.membro = true;
  });

  it("aprovador ainda na equipe: o dono não assume, nada gravado nem auditado", async () => {
    estado.aprovadorNaEquipe = true;
    estado.quemPede = DONO;
    const res = await PUT(pedido({ aprovador_user_id: DONO }));
    expect(res.status).toBe(403);
    expect(atualizados).toEqual([]);
    expect(auditados).toEqual([]);
  });

  it("aprovador revogado: o dono assume, com compare-and-set no aprovador antigo", async () => {
    estado.quemPede = DONO;
    const res = await PUT(pedido({ aprovador_user_id: DONO }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ id: "prog", transferido: true });
    expect(atualizados).toEqual([{ aprovador_user_id: DONO }]);
    expect(estado.filtros).toContainEqual(["bonus_programas.update", "aprovador_user_id", APROVADOR]);
    expect(estado.filtros).toContainEqual(["bonus_programas.update", "organization_id", ORG]);
    expect(auditados).toEqual([
      expect.objectContaining({ action: "bonus.aprovador_assumido", actorUserId: DONO, metadata: { aprovador_anterior_user_id: APROVADOR } }),
    ]);
  });

  it("aprovador revogado: platform admin pleno e membro assume", async () => {
    estado.quemPede = OUTRO_ADMIN;
    estado.platformAdmin = true;
    expect((await PUT(pedido({ aprovador_user_id: OUTRO_ADMIN }))).status).toBe(200);
    expect(atualizados).toEqual([{ aprovador_user_id: OUTRO_ADMIN }]);
  });

  it("aprovador revogado: platform admin que não é membro leva 422", async () => {
    estado.quemPede = OUTRO_ADMIN;
    estado.platformAdmin = true;
    estado.membro = false;
    expect((await PUT(pedido({ aprovador_user_id: OUTRO_ADMIN }))).status).toBe(422);
    expect(atualizados).toEqual([]);
  });

  it("aprovador revogado: outro admin da organização não assume", async () => {
    estado.quemPede = OUTRO_ADMIN;
    expect((await PUT(pedido({ aprovador_user_id: OUTRO_ADMIN }))).status).toBe(403);
    expect(atualizados).toEqual([]);
  });

  it("aprovador revogado: tomada não leva regras nem ativo junto", async () => {
    estado.quemPede = DONO;
    expect((await PUT(pedido({ aprovador_user_id: DONO, ativo: false }))).status).toBe(403);
    expect(
      (await PUT(pedido({ aprovador_user_id: DONO, regras: { participantes: [PARTICIPANTE], tarefas: { valor_cents: 30_000 } } }))).status,
    ).toBe(403);
    expect(atualizados).toEqual([]);
    expect(auditados).toEqual([]);
  });

  it("aprovador revogado: o dono não entrega a função a outra pessoa", async () => {
    estado.quemPede = DONO;
    expect((await PUT(pedido({ aprovador_user_id: PARTICIPANTE }))).status).toBe(403);
    expect(atualizados).toEqual([]);
  });
});

describe("GET /api/v1/bonus/programa", () => {
  it("participante recebe programa null", async () => {
    estado.quemPede = PARTICIPANTE;
    const corpo = await (await GET()).json();
    expect(corpo.data).toEqual({ programa: null, pode_criar: false });
  });

  it("o aprovador recebe a configuração", async () => {
    estado.quemPede = APROVADOR;
    const corpo = await (await GET()).json();
    expect(corpo.data.programa).toMatchObject({ id: "prog", aprovador_user_id: APROVADOR, ativo: true });
    expect(corpo.data.programa.regras.tarefas.valor_cents).toBe(20_000);
  });
});
