/**
 * O quadro traz abertos + fechados dos últimos 30 dias; `?fechados=antigos` traz
 * só o resto. Sem a janela, o histórico de ganhos e perdidos crescia sem fim e
 * era relido a cada mudança num lead.
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const PIPE = "33333333-3333-4333-8333-333333333333";

function stub(chamadas: Array<{ tabela: string; metodo: string; args: unknown[] }>, contagem: number) {
  const cadeia = (tabela: string) => {
    let head = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proxy: any = new Proxy(() => proxy, {
      get(_t, prop) {
        if (prop === "then") {
          const data = tabela === "crm_pipelines" ? { id: PIPE, organization_id: "org" } : [];
          const r = head ? { data: null, error: null, count: contagem } : { data, error: null };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (ok: any, ko: any) => Promise.resolve(r).then(ok, ko);
        }
        return (...args: unknown[]) => {
          if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
          chamadas.push({ tabela, metodo: String(prop), args });
          return proxy;
        };
      },
    });
    return proxy;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
    from: cadeia,
  };
}

async function abrir(qs = "", contagem = 7) {
  const chamadas: Array<{ tabela: string; metodo: string; args: unknown[] }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createClient).mockResolvedValue(stub(chamadas, contagem) as any);
  const { GET } = await import("@/app/api/v1/pipelines/[id]/board/route");
  const res = await GET(new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/board${qs}`), {
    params: Promise.resolve({ id: PIPE }),
  });
  const body = (await res.json()) as { data: { fechadosAntigos: number } };
  const recorte = chamadas.find((c) => c.tabela === "crm_leads" && c.metodo === "or")?.args[0] as string;
  return { body, recorte };
}

describe("quadro do funil — janela de fechados", () => {
  it("padrão: abertos, fechados recentes e legado sem closed_at; conta os antigos", async () => {
    const { body, recorte } = await abrir();
    expect(recorte).toMatch(/^status\.eq\.open,closed_at\.gte\.\d{4}-.+,closed_at\.is\.null$/);
    expect(body.data.fechadosAntigos).toBe(7);
  });

  it("?fechados=antigos: só ganhos/perdidos anteriores ao corte", async () => {
    const { body, recorte } = await abrir("?fechados=antigos");
    expect(recorte).toMatch(/^and\(status\.in\.\(won,lost\),closed_at\.lt\.\d{4}-.+\)$/);
    expect(body.data.fechadosAntigos).toBe(0);
  });
});
