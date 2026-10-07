/**
 * QUANTAS CONSULTAS CUSTA ABRIR O QUADRO DO FUNIL.
 *
 * Incidente de 07/10/2026: banco do Supabase com média de 9 s e p95 de 29 s,
 * disco saturado. O quadro de ~800 negócios disparava ~46 consultas por
 * abertura (lotes de 100 ids em cinco tabelas), e o quadro é relido a cada
 * mudança em `crm_leads` (useBoard invalida no realtime).
 *
 * Este caso conta cada `.from()` que a rota faz com um quadro de 800 negócios,
 * cada um com contato próprio, e 10 contatos com próxima ação proposta. O teto
 * é o novo; o código antigo passava de 40.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const PIPE = "33333333-3333-4333-8333-333333333333";
const N = 800;

const leads = Array.from({ length: N }, (_, i) => ({
  id: `lead-${i}`,
  organization_id: ORG,
  pipeline_id: PIPE,
  stage_id: "st-1",
  contact_id: `contato-${i}`,
  status: "open",
  owner_kind: null,
  owner_agent_id: null,
  last_activity_at: null,
  created_at: "2026-01-01T00:00:00Z",
}));
const estados = Array.from({ length: 10 }, (_, i) => ({
  contact_id: `contato-${i}`,
  next_action: "Ligar amanhã",
  next_action_seq: 1,
  updated_at: "2026-10-07T00:00:00Z",
}));

function stub(consultas: Array<{ tabela: string; ids: number }>) {
  const tabelas: Record<string, unknown> = {
    crm_pipelines: { id: PIPE, organization_id: ORG, is_default: true },
    crm_stages: [],
    crm_leads: leads,
    lead_state: estados,
  };
  const cadeia = (tabela: string) => {
    const registro = { tabela, ids: 0 };
    consultas.push(registro);
    let filtro: ((linha: Record<string, unknown>) => boolean) | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proxy: any = new Proxy(() => proxy, {
      get(_t, prop) {
        if (prop === "then") {
          const todas = tabela in tabelas ? tabelas[tabela] : [];
          const data = filtro && Array.isArray(todas) ? todas.filter(filtro) : todas;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (ok: any, ko: any) => Promise.resolve({ data, error: null }).then(ok, ko);
        }
        if (prop === "in") {
          return (col: string, lista: string[]) => {
            registro.ids = lista.length;
            const alvo = new Set(lista);
            filtro = (linha) => alvo.has(linha[col] as string);
            return proxy;
          };
        }
        return () => proxy;
      },
    });
    return proxy;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
    from: cadeia,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("quadro do funil — consultas por abertura", () => {
  it("800 negócios abrem com no máximo 17 consultas, nenhum lote acima de 300 ids", async () => {
    const consultas: Array<{ tabela: string; ids: number }> = [];
    vi.mocked(loadAuthUser).mockResolvedValue(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(createClient).mockResolvedValue(stub(consultas) as any);

    const { GET } = await import("@/app/api/v1/pipelines/[id]/board/route");
    const res = await GET(new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/board`), {
      params: Promise.resolve({ id: PIPE }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { leads: Array<{ id: string; next_action?: { label: string } }> };
    };
    expect(body.data.leads).toHaveLength(N);
    // A próxima ação continua chegando ao card — só os candidatos ficaram menos.
    const comAcao = body.data.leads.filter((l) => l.next_action).map((l) => l.id);
    expect(comAcao).toEqual(estados.map((_, i) => `lead-${i}`));
    expect(Math.max(...consultas.map((c) => c.ids))).toBeLessThanOrEqual(300);
    // Antes: 44 (3 iniciais + funil padrão + 5 tabelas × 8 lotes de 100).
    // Agora: 3 iniciais + 3 tabelas × 3 lotes de 300 + lead_state (3) + 1 lote
    // de candidatos (só quem tem proposta) + funil padrão = 17.
    expect(consultas.length, JSON.stringify(consultas.map((c) => c.tabela))).toBeLessThanOrEqual(17);
  });
});
