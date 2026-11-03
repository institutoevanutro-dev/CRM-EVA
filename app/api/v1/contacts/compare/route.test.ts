/**
 * GET /api/v1/contacts/compare — duas fichas lado a lado (porte do #3640).
 *
 * O que se prova aqui: só gestor; a forma do pedido (exatamente dois ids); o
 * que a sessão enxerga (1 ficha visível → 404); todo filtro pela organização da
 * SESSÃO; a resposta sem `custom_fields`, `source_metadata` nem a cifra do CPF;
 * o vínculo com o prontuário lido de forma estrita; e a trilha `contact.viewed`
 * só na abertura.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { auditarLeitura } from "@/lib/audit/leitura";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit/leitura", () => ({ auditarLeitura: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Linha = Record<string, unknown>;

function ficha(id: string, parcial: Linha = {}): Linha {
  return {
    id,
    organization_id: ORG_ID,
    name: `Ficha ${id.slice(0, 2)}`,
    display_name: null,
    email: null,
    phone_number: "+5531999990000",
    birthdate: "1990-05-20",
    cpf_encrypted: null,
    source: "whatsapp",
    source_metadata: { telefone_em_conflito: "+5531999990001" },
    custom_fields: { endereco: "Rua das Flores, 10", outro_campo: "não sai" },
    is_blocked: false,
    force_human: false,
    ai_opt_out: false,
    inbox_hidden_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    last_activity_at: null,
    is_merged_into: null,
    is_anonymized: false,
    ...parcial,
  };
}

/**
 * Dublê do PostgREST para as tabelas da rota: `eq` e `in` são APLICADOS, e
 * `count` vale quando pedido com `head`. Registra cada consulta.
 */
function fakeSupabase(
  dados: Record<string, Linha[]>,
  opcoes: { contagens?: Record<string, number>; erroEm?: string } = {},
) {
  const consultas: Array<{ tabela: string; filtros: Array<[string, unknown]> }> = [];
  const client = {
    from(tabela: string) {
      const registro = { tabela, filtros: [] as Array<[string, unknown]> };
      consultas.push(registro);
      const predicados: Array<(l: Linha) => boolean> = [];
      const builder: Record<string, unknown> = {};
      let head = false;
      builder.select = (_c: string, o?: { head?: boolean }) => {
        head = o?.head === true;
        return builder;
      };
      builder.eq = (coluna: string, valor: unknown) => {
        registro.filtros.push([coluna, valor]);
        predicados.push((l) => l[coluna] === valor);
        return builder;
      };
      builder.in = (coluna: string, valores: unknown[]) => {
        registro.filtros.push([coluna, valores]);
        predicados.push((l) => valores.includes(l[coluna]));
        return builder;
      };
      builder.then = (cb: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        const resposta =
          opcoes.erroEm === tabela
            ? { data: null, error: { message: "timeout" }, count: null }
            : head
              ? { data: null, error: null, count: opcoes.contagens?.[tabela] ?? 0 }
              : { data: (dados[tabela] ?? []).filter((l) => predicados.every((p) => p(l))), error: null, count: null };
        return Promise.resolve(resposta).then(cb, rej);
      };
      return builder;
    },
  };
  vi.mocked(createClient).mockResolvedValue(client as never);
  return { consultas };
}

async function chamar(ids: string | null, extra = ""): Promise<Response> {
  const { GET } = await import("./route");
  const qs = ids === null ? "" : `?ids=${encodeURIComponent(ids)}${extra}`;
  return GET(new NextRequest(`http://localhost/api/v1/contacts/compare${qs}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID } as never,
    org: { orgId: ORG_ID, name: "Org", role: "manager" } as never,
  });
});

describe("GET /contacts/compare: quem pode e a forma do pedido", () => {
  it("sem papel de gestor: 403 e nenhuma consulta", async () => {
    // Sabotagem: trocar `requireRole("manager")` por uma checagem só de sessão deixa vermelho.
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: Response.json({ error: { code: "forbidden_role", message: "x" } }, { status: 403 }),
    } as never);
    const { consultas } = fakeSupabase({ contacts: [ficha(A), ficha(B)] });

    const res = await chamar(`${A},${B}`);

    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
    expect(res.status).toBe(403);
    expect(consultas).toEqual([]);
  });

  it("um id só → 422, e nem consulta o banco", async () => {
    const { consultas } = fakeSupabase({ contacts: [ficha(A)] });

    const res = await chamar(A);
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(422);
    expect(json.error.code).toBe("validation_failed");
    expect(consultas).toEqual([]);
  });

  it("o mesmo id duas vezes (com outra caixa) → 422", async () => {
    fakeSupabase({ contacts: [ficha(A)] });
    expect((await chamar(`${A},${A.toUpperCase()}`)).status).toBe(422);
  });
});

describe("GET /contacts/compare: o que a sessão enxerga", () => {
  it("a sessão só enxerga uma das duas → 404", async () => {
    fakeSupabase({ contacts: [ficha(A)] });
    expect((await chamar(`${A},${B}`)).status).toBe(404);
  });

  it("ficha mesclada conta como não encontrada → 404", async () => {
    // Sabotagem: não filtrar `is_merged_into` deixa a lápide aparecer na comparação.
    fakeSupabase({ contacts: [ficha(A), ficha(B, { is_merged_into: A })] });
    expect((await chamar(`${A},${B}`)).status).toBe(404);
  });

  it("toda consulta filtra a organização da SESSÃO", async () => {
    const { consultas } = fakeSupabase({ contacts: [ficha(A), ficha(B)] });

    expect((await chamar(`${A},${B}`)).status).toBe(200);
    expect(consultas.map((c) => c.tabela).sort()).toEqual([
      "contacts",
      "conversations",
      "conversations",
      "crm_leads",
      "crm_leads",
      "prontuario_contact_links",
    ]);
    for (const c of consultas) expect(c.filtros, c.tabela).toContainEqual(["organization_id", ORG_ID]);
  });
});

describe("GET /contacts/compare: o recorte da resposta", () => {
  it("leva os campos da clínica e nunca custom_fields, source_metadata nem a cifra do CPF", async () => {
    fakeSupabase(
      {
        contacts: [
          ficha(A, { cpf_encrypted: "cifra-que-nao-sai", is_blocked: true, ai_opt_out: true, force_human: true }),
          ficha(B, { custom_fields: { endereco: 42 }, inbox_hidden_at: "2026-10-01T00:00:00.000Z" }),
        ],
        prontuario_contact_links: [{ organization_id: ORG_ID, contact_id: A }],
      },
      { contagens: { conversations: 2, crm_leads: 1 } },
    );

    const json = (await (await chamar(`${A},${B}`)).json()) as { data: { contatos: Array<Record<string, unknown>> } };
    const [a, b] = json.data.contatos;

    for (const c of [a!, b!]) {
      expect(c).not.toHaveProperty("custom_fields");
      expect(c).not.toHaveProperty("source_metadata");
      expect(c).not.toHaveProperty("cpf_encrypted");
    }
    expect(JSON.stringify(json)).not.toContain("cifra-que-nao-sai");
    expect(a).toMatchObject({
      id: A,
      cpf_available: true,
      prontuario_linked: true,
      endereco: "Rua das Flores, 10",
      is_blocked: true,
      force_human: true,
      ai_opt_out: true,
      inbox_hidden_at: null,
      birthdate: "1990-05-20",
      conversas: 2,
      negocios: 1,
    });
    // Endereço que não é texto não sai; a ficha sem vínculo diz `false`.
    expect(b).toMatchObject({ id: B, cpf_available: false, prontuario_linked: false, endereco: null });
    expect(b!.inbox_hidden_at).toBe("2026-10-01T00:00:00.000Z");
  });

  it("erro ao ler o vínculo com o prontuário → 500, nunca 'não ligada'", async () => {
    // Sabotagem: devolver `prontuario_linked: false` no erro levaria o gestor a
    // absorver a ficha ligada.
    fakeSupabase({ contacts: [ficha(A), ficha(B)] }, { erroEm: "prontuario_contact_links" });
    expect((await chamar(`${A},${B}`)).status).toBe(500);
  });
});

describe("GET /contacts/compare: a trilha de leitura", () => {
  it("a abertura deixa UMA linha contact.viewed com os ids; a recarga marcada, nenhuma", async () => {
    // Sabotagem: auditar sem olhar `ehAberturaDeLeitura` grava a recarga também.
    fakeSupabase({ contacts: [ficha(A), ficha(B)] });

    await chamar(`${A},${B}`);
    expect(auditarLeitura).toHaveBeenCalledTimes(1);
    expect(vi.mocked(auditarLeitura).mock.calls[0]![0]).toMatchObject({
      action: "contact.viewed",
      actorUserId: USER_ID,
      organizationId: ORG_ID,
      resourceType: "contact",
      resourceId: A,
      metadata: { recurso: "comparacao", ids: [A, B] },
    });

    vi.mocked(auditarLeitura).mockClear();
    await chamar(`${A},${B}`, "&atualizacao=1");
    expect(auditarLeitura).not.toHaveBeenCalled();
  });
});
