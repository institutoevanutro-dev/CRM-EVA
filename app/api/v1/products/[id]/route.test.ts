import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

import { PATCH } from "./route";

const ID = "33333333-3333-4333-8333-333333333333";
let atualizado: Record<string, unknown> | null = null;

/** Lê `origem` e grava; os `.eq()` são encadeáveis e ignorados. */
function supabaseCom(origem: string) {
  const eqs = (fim: Record<string, unknown>) => {
    const o: Record<string, unknown> = { ...fim };
    o.eq = () => o;
    return o;
  };
  return {
    from: () => ({
      select: () => eqs({ maybeSingle: async () => ({ data: { origem }, error: null }) }),
      update: (patch: Record<string, unknown>) => {
        atualizado = patch;
        return eqs({ select: () => ({ maybeSingle: async () => ({ data: { id: ID, ...patch }, error: null }) }) });
      },
    }),
  };
}

const pedido = (corpo: unknown) =>
  new NextRequest(`http://localhost/api/v1/products/${ID}`, {
    method: "PATCH",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
const params = { params: Promise.resolve({ id: ID }) };

beforeEach(() => {
  atualizado = null;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111" },
    org: { orgId: "22222222-2222-4222-8222-222222222222" },
  } as never);
});

/**
 * Item da Precificação: código, nome, categoria, preço, custo e situação só
 * mudam lá. Antes a rota dizia "salvo" e a sincronização de hora em hora
 * desfazia (ou, com código novo, duplicava o item com o preço velho).
 */
describe("PATCH /api/v1/products/:id — item da Precificação", () => {
  it("recusa desativar e não grava", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom("precificaeva") as never);
    const res = await PATCH(pedido({ ativo: false }), params);
    expect(res.status).toBe(409);
    expect(atualizado).toBeNull();
  });

  it("deixa mudar o que é do CRM (marca, estoque)", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom("precificaeva") as never);
    const res = await PATCH(pedido({ marca: "Eva", quantidade: 3 }), params);
    expect(res.status).toBe(200);
    expect(atualizado).toEqual({ marca: "Eva", quantidade: 3 });
  });

  it("não reativa nem zera estoque de quem não mandou esses campos", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom("manual") as never);
    await PATCH(pedido({ preco_cents: 1000 }), params);
    expect(atualizado).toEqual({ preco_cents: 1000 });
  });

  it("item manual continua editável por inteiro", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom("manual") as never);
    const res = await PATCH(pedido({ nome: "Consulta nova", ativo: false }), params);
    expect(res.status).toBe(200);
  });
});
