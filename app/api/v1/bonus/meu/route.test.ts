import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { diaLocalISO } from "@/lib/agenda/fuso";
import { type Linha, supabaseEmMemoria } from "@/tests/helpers/supabase-em-memoria";

/**
 * Cada participante vê SÓ o próprio placar e a própria fila. O aprovador é uma
 * pessoa, e os participantes são admin: o papel não decide nada aqui.
 */
const ADMIN_FORA = "44444444-4444-4444-8444-444444444444";
const ORG = "org-a";
const HOJE = diaLocalISO(new Date(), "America/Sao_Paulo");

const ids = vi.hoisted(() => ({ A: "11111111-1111-4111-8111-111111111111", B: "22222222-2222-4222-8222-222222222222" }));
const { A, B } = ids;
const estado = vi.hoisted(() => ({ quemPede: "", lidos: [] as Array<Record<string, unknown>> }));
const banco = vi.hoisted(() => ({ atual: null as null | ReturnType<typeof supabaseEmMemoria> }));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { id: estado.quemPede, idioma: "pt-BR" }, org: { orgId: "org-a", role: "admin" } }),
}));
vi.mock("@/lib/audit/leitura", () => ({ auditarLeitura: (e: Record<string, unknown>) => void estado.lidos.push(e) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco.atual!.cliente }));
vi.mock("@/lib/bonus/fatos", async () => {
  const { regrasSchema } = await import("@/lib/bonus/regras");
  const regras = regrasSchema.parse({ participantes: [ids.A, ids.B], tarefas: { valor_cents: 20_000 } });
  return {
    lerPrograma: async () => ({
      status: "ok",
      programa: { id: "prog", organizationId: "org-a", aprovadorUserId: "apr", ativo: true, regras, fuso: "America/Sao_Paulo", etapasDeSinalPago: [] },
    }),
    fatosDoMes: async (_a: unknown, _p: unknown, mes: string, hoje: string) => ({
      mes,
      hoje,
      regras,
      pessoas: [ids.A, ids.B].map((userId) => ({ userId, tarefas: [], leads: [], ligacoes: [], diasDeExcecao: [] })),
      storiesPorDia: {},
      resultados: { comparecimento: 0, sinal_pago: 0, avaliacao_google: null },
    }),
    mensagensDaEquipe: async () => [],
  };
});

import { GET } from "./route";

const item = (id: string, user_id: string, organization_id = ORG): Linha => ({
  id,
  organization_id,
  dia: HOJE,
  tipo: "ligacao",
  user_id,
  contact_id: `c-${id}`,
  conversation_id: null,
  motivo: "faltou",
  ligacao_registrada_em: null,
  ligacao_resultado: null,
  ligacao_resumo: null,
  contacts: { display_name: `Pessoa ${id}`, name: null, phone_number: null },
});

const get = () => GET(new NextRequest("http://localhost/api/v1/bonus/meu"));

beforeEach(() => {
  estado.lidos.length = 0;
  banco.atual = supabaseEmMemoria({
    bonus_fila_itens: [item("a1", A), item("b1", B), item("a-outra-org", A, "org-b")],
  });
});

describe("GET /api/v1/bonus/meu", () => {
  it("admin que não participa: 403, e nada de paciente é lido", async () => {
    estado.quemPede = ADMIN_FORA;
    expect((await get()).status).toBe(403);
    expect(banco.atual!.cliente.from).not.toHaveBeenCalledWith("bonus_fila_itens");
  });

  it("o participante lê só a PRÓPRIA fila, da organização da sessão", async () => {
    estado.quemPede = A;
    const res = await get();
    expect(res.status).toBe(200);
    const corpo = (await res.json()).data;
    expect(corpo.pessoa.userId).toBe(A);
    expect(corpo.fila.map((f: { id: string }) => f.id)).toEqual(["a1"]);
    expect(corpo.fila[0]).toMatchObject({ contato_nome: "Pessoa a1", tipo: "ligacao", motivo: "faltou" });
  });

  it("a leitura da fila (nome de paciente) deixa rastro, só com ids", async () => {
    estado.quemPede = A;
    await get();
    expect(estado.lidos).toEqual([expect.objectContaining({ action: "contact.listed", organizationId: ORG, actorUserId: A, metadata: { ids: ["c-a1"] } })]);
    expect(JSON.stringify(estado.lidos)).not.toContain("Pessoa");
  });
});
