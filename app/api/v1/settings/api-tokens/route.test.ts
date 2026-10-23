import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";

import { EPHEMERAL_TOKEN_PREFIX } from "@/lib/ai/runtime/mcp_token";

/**
 * O filtro das chaves temporárias da IA mora na CONSULTA: a lista de pessoas
 * não traz as 1.410 linhas `agent-run:` para depois escondê-las.
 */

const chamadas = vi.hoisted(() => [] as Array<{ consulta: number; metodo: string; args: unknown[] }>);
const resultados = vi.hoisted(() => [] as Array<{ data: unknown; error: null; count?: number }>);

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: "org-1", role: "admin" },
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    let consulta = 0;
    return {
      from: () => {
        const n = consulta++;
        const resultado = resultados[n];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cadeia: any = new Proxy({}, {
          get(_t, metodo: string) {
            if (metodo === "then") {
              return (ok: (v: unknown) => void) => ok(resultado);
            }
            return (...args: unknown[]) => {
              chamadas.push({ consulta: n, metodo, args });
              return cadeia;
            };
          },
        });
        return cadeia;
      },
    };
  }),
}));

import { GET } from "./route";

const padrao = `${EPHEMERAL_TOKEN_PREFIX}%`;
const req = (q: string) => new NextRequest(`http://localhost/api/v1/settings/api-tokens${q}`);

beforeEach(() => {
  chamadas.length = 0;
  resultados.length = 0;
});

it("origem=pessoas exclui as temporárias na consulta e só CONTA as da IA", async () => {
  resultados.push({ data: [{ id: "p1" }], error: null }, { data: null, error: null, count: 1410 });
  const res = await GET(req("?origem=pessoas"));
  const corpo = await res.json();

  expect(corpo).toEqual({ data: [{ id: "p1" }], meta: { temporarias_da_ia: 1410 } });
  expect(chamadas).toContainEqual({ consulta: 0, metodo: "not", args: ["prefix", "like", padrao] });
  expect(chamadas).toContainEqual({ consulta: 1, metodo: "like", args: ["prefix", padrao] });
  expect(chamadas).toContainEqual({ consulta: 1, metodo: "select", args: ["id", { count: "exact", head: true }] });
});

it("origem=ia traz só as temporárias", async () => {
  resultados.push({ data: [{ id: "r1" }], error: null });
  const corpo = await (await GET(req("?origem=ia"))).json();
  expect(corpo).toEqual({ data: [{ id: "r1" }] });
  expect(chamadas).toContainEqual({ consulta: 0, metodo: "like", args: ["prefix", padrao] });
});

it("sem o parâmetro a resposta é a de sempre, sem filtro", async () => {
  resultados.push({ data: [{ id: "p1" }, { id: "r1" }], error: null });
  const corpo = await (await GET(req(""))).json();
  expect(corpo).toEqual({ data: [{ id: "p1" }, { id: "r1" }] });
  expect(chamadas.some((c) => c.metodo === "like" || c.metodo === "not")).toBe(false);
});
