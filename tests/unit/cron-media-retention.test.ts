/**
 * O cron `media-retention` (migration 0341): drena em tandas e só audita quando
 * a rodada teve efeito. Numa instalação em que ninguém ligou a limpeza, a
 * função devolve zeros todo dia — e isso não pode virar linha de auditoria.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const respostas: Array<{ data: unknown; error: { message: string } | null }> = [];
const chamadas: unknown[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (_nome: string, args: unknown) => {
      chamadas.push(args);
      return respostas.shift() ?? { data: { vencidas: 0, orfas: 0, expurgadas: 0 }, error: null };
    },
  }),
}));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
const auditSpy = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditSpy(...a) }));

const req = () => new NextRequest("http://localhost/api/v1/cron/media-retention");

beforeEach(() => {
  respostas.length = 0;
  chamadas.length = 0;
  auditSpy.mockClear();
});

describe("cron media-retention", () => {
  it("rodada vazia (interruptor desligado em todo lugar): 200, uma tanda, sem auditoria", async () => {
    const { GET } = await import("@/app/api/v1/cron/media-retention/route");
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(chamadas).toHaveLength(1);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("tanda cheia pede outra; a rodada com efeito audita a soma", async () => {
    respostas.push(
      { data: { vencidas: 500, orfas: 3, expurgadas: 1 }, error: null },
      { data: { vencidas: 7, orfas: 0, expurgadas: 0 }, error: null },
    );
    const { GET } = await import("@/app/api/v1/cron/media-retention/route");
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(chamadas).toHaveLength(2);
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]![0]).toMatchObject({
      action: "retention.sweep_run",
      metadata: { origem: "media-retention", vencidas: 507, orfas: 3, expurgadas: 1, tandas: 2 },
    });
  });

  it("falha sem efeito anterior: 500 e nenhuma linha de auditoria", async () => {
    respostas.push({ data: null, error: { message: "boom" } });
    const { GET } = await import("@/app/api/v1/cron/media-retention/route");
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(auditSpy).not.toHaveBeenCalled();
  });
});
