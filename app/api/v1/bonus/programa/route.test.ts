import { beforeEach, describe, expect, it, vi } from "vitest";

const APROVADOR = "11111111-1111-4111-8111-111111111111";
const PARTICIPANTE = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";

// `vi.hoisted`: as fábricas de `vi.mock` sobem para o topo do arquivo.
const estado = vi.hoisted(() => ({ auditados: [] as unknown[], atualizados: [] as unknown[], quemPede: "" }));
const { auditados, atualizados } = estado;

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: async (e: unknown) => void estado.auditados.push(e) }));
vi.mock("@/lib/tarefas/responsavel", () => ({ responsavelValido: async () => true }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: estado.quemPede, idioma: "pt-BR", is_platform_admin: false },
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
  const cadeia: Record<string, unknown> = {};
  for (const m of ["eq", "select"]) cadeia[m] = () => cadeia;
  cadeia.maybeSingle = async () => ({ data: { id: "prog" }, error: null });
  return {
    createAdminClient: () => ({
      from: () => ({
        update: (v: unknown) => {
          estado.atualizados.push(v);
          return cadeia;
        },
      }),
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
