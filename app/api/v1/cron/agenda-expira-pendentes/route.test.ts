/**
 * O pedido que ninguém decidiu solta o horário, e só ele.
 *
 * O que este arquivo protege, em ordem de gravidade:
 *
 * 1. Cancelar um compromisso CONFIRMADO seria o pior desfecho possível desta
 *    rota: cliente com horário marcado perde o horário sozinho, sem ninguém
 *    saber. A guarda aparece na leitura e no cancelamento (status + revisão).
 * 2. O prazo conta de quando o compromisso FICOU pendente, não de quando foi
 *    criado (incidente de 12/10/2026: 23 consultas confirmadas rebaixadas a
 *    `pending` já nasciam "vencidas").
 * 3. O prazo é POR ORGANIZAÇÃO.
 * 4. Uma rodada não cancela às dezenas, e uma linha que falha não derruba as
 *    outras.
 * 5. Rodada sem efeito não audita (lei do CLAUDE.md).
 *
 * O banco de verdade (constraint, triggers, revisão) é medido em
 * `tests/invariants/agenda-pedido-pendente-expira.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "segredo", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({
  cancelarAgendamentoHandler: vi.fn(async (_s: unknown, _c: unknown, input: { id: string }) => ({
    id: input.id,
    status: "cancelled",
  })),
}));

import { cancelarAgendamentoHandler } from "@/app/api/v1/agenda/agendamentos/_handler";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

import { MOTIVO_DA_EXPIRACAO, TETO_DE_EXPIRACOES_POR_RODADA } from "./route";

const ORG_RAPIDA = "11111111-1111-4111-8111-111111111111";
const ORG_LENTA = "22222222-2222-4222-8222-222222222222";

const hAtras = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

/** Uma linha como a leitura devolve. `pendenteHa` = horas desde que FICOU pendente. */
const pendente = (id: string, org: string, pendenteHa: number, revision = 3) => ({
  id,
  organization_id: org,
  revision,
  revision_started_at: hAtras(pendenteHa),
});

/** Captura os filtros da leitura, na ordem em que a rota os encadeia. */
function admin(pendentes: Array<Record<string, unknown>>, filtros: Array<[string, string, unknown]>) {
  const leitura = {
    eq: (c: string, v: unknown) => (filtros.push(["eq", c, v]), leitura),
    neq: (c: string, v: unknown) => (filtros.push(["neq", c, v]), leitura),
    gt: (c: string, v: unknown) => (filtros.push(["gt", c, v]), leitura),
    order: (c: string) => (filtros.push(["order", c, null]), leitura),
    limit: async () => ({ data: pendentes, error: null }),
  };
  return {
    from(tabela: string) {
      if (tabela === "organizations") {
        return {
          select: () => ({
            in: async () => ({
              data: [
                { id: ORG_RAPIDA, settings: { agenda: { confirmation_delay_minutes: 10, unknown_protection_minutes: 1440, pending_expires_after_minutes: 60 } } },
                // Sem o campo: cai no default de 1440 (24h).
                { id: ORG_LENTA, settings: { agenda: { confirmation_delay_minutes: 10, unknown_protection_minutes: 1440 } } },
              ],
            }),
          }),
        };
      }
      return {
        select: () => leitura,
        // A rota NÃO escreve na tabela por conta própria: cancelar é do handler.
        update: () => {
          throw new Error("UPDATE cru em calendar_appointments: o cancelamento passa pelo handler");
        },
      };
    },
  };
}

function req() {
  return new NextRequest("http://localhost/x", { headers: { authorization: "Bearer segredo" } });
}

async function roda(pendentes: Array<Record<string, unknown>>, filtros: Array<[string, string, unknown]> = []) {
  vi.mocked(createAdminClient).mockReturnValue(admin(pendentes, filtros) as never);
  const { POST } = await import("./route");
  const res = await POST(req());
  return { res, body: (await res.json()) as { data: Record<string, number> } };
}

const cancelados = () => vi.mocked(cancelarAgendamentoHandler).mock.calls.map((c) => c[2].id);

beforeEach(() => vi.clearAllMocks());

describe("agenda-expira-pendentes", () => {
  it("expira o que passou do prazo DAQUELA organização, e mantém o resto", async () => {
    const { body } = await roda([
      pendente("c", ORG_LENTA, 30), // 30h pendente, prazo de 24h → expira.
      pendente("a", ORG_RAPIDA, 2), // 2h pendente, prazo de 1h → expira.
      pendente("b", ORG_LENTA, 2), // 2h pendente, prazo de 24h → fica.
    ]);

    expect(body.data).toMatchObject({ examinados: 3, expirados: 2, mantidos: 1, adiados: 0, falhas: 0 });
    expect(cancelados()).toEqual(["c", "a"]);
  });

  it("o prazo conta de quando FICOU pendente: `created_at` nem é lido", async () => {
    // O incidente: criado há 2 dias, rebaixado a pendente AGORA. A linha traz
    // `created_at` antigo de propósito; se a rota voltar a usá-lo, isto cancela.
    const { body } = await roda([
      { ...pendente("rebaixado", ORG_RAPIDA, 0), created_at: hAtras(48) },
    ]);

    expect(body.data).toMatchObject({ examinados: 1, expirados: 0, mantidos: 1 });
    expect(cancelarAgendamentoHandler).not.toHaveBeenCalled();
  });

  it("a leitura pede só pendentes, FUTUROS, fora da agenda importada", async () => {
    const filtros: Array<[string, string, unknown]> = [];
    const antes = Date.now();
    await roda([pendente("a", ORG_RAPIDA, 5)], filtros);

    expect(filtros).toContainEqual(["eq", "status", "pending"]);
    expect(filtros).toContainEqual(["neq", "source", "historical_import"]);
    const futuro = filtros.find((f) => f[0] === "gt" && f[1] === "starts_at");
    expect(Date.parse(futuro?.[2] as string)).toBeGreaterThanOrEqual(antes);
    expect(filtros).toContainEqual(["order", "revision_started_at", null]);
  });

  it("cancela pelo caminho comum, na organização DA LINHA, com a revisão lida e as duas guardas", async () => {
    await roda([pendente("a", ORG_RAPIDA, 5, 7), pendente("c", ORG_LENTA, 30, 2)]);

    const chamadas = vi.mocked(cancelarAgendamentoHandler).mock.calls;
    expect(chamadas.map((c) => [c[2].id, c[1].organization_id, c[2].revision])).toEqual([
      ["a", ORG_RAPIDA, 7],
      ["c", ORG_LENTA, 2],
    ]);
    for (const c of chamadas) {
      expect(c[2].reason).toBe(MOTIVO_DA_EXPIRACAO);
      // Só `pending`, e sem gatilho de automação: a expiração não fala com o cliente.
      expect(c[3]).toEqual({ apenasSeStatus: "pending", semGatilho: true });
      expect(c[1].actor.type).toBe("webhook_source");
    }
  });

  it("o teto: uma rodada não cancela mais que o limite, e o resto espera a próxima", async () => {
    const muitos = Array.from({ length: TETO_DE_EXPIRACOES_POR_RODADA + 3 }, (_, i) =>
      pendente(`p${i}`, ORG_RAPIDA, 100 - i),
    );
    const { res, body } = await roda(muitos);

    expect(res.status).toBe(200);
    expect(cancelarAgendamentoHandler).toHaveBeenCalledTimes(TETO_DE_EXPIRACOES_POR_RODADA);
    expect(body.data).toMatchObject({ expirados: TETO_DE_EXPIRACOES_POR_RODADA, adiados: 3 });
    // Os mais antigos primeiro (a ordem da leitura), nunca os mesmos para trás.
    expect(cancelados()[0]).toBe("p0");
    expect(cancelados()).not.toContain(`p${TETO_DE_EXPIRACOES_POR_RODADA}`);
  });

  it("uma linha que falha não derruba as outras, e a rodada conta a falha", async () => {
    vi.mocked(cancelarAgendamentoHandler).mockImplementationOnce(async () => {
      throw new Error("violates check constraint");
    });
    const { res, body } = await roda([pendente("ruim", ORG_RAPIDA, 9), pendente("boa", ORG_RAPIDA, 8)]);

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ expirados: 1, falhas: 1 });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ expirados: 1, falhas: 1 }) }),
    );
  });

  it("quem foi confirmado entre a leitura e a escrita (409) fica, e isso não é falha", async () => {
    vi.mocked(cancelarAgendamentoHandler).mockImplementationOnce(async () => {
      throw new ApiError(409, "conflict", undefined, "r");
    });
    const { res, body } = await roda([pendente("confirmado-agora", ORG_RAPIDA, 9)]);

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ expirados: 0, mudaram: 1, falhas: 0 });
    expect(audit).not.toHaveBeenCalled();
  });

  it("quando nada sai e tudo falha, a rodada responde erro e não audita", async () => {
    vi.mocked(cancelarAgendamentoHandler).mockImplementation(async () => {
      throw new Error("banco fora");
    });
    const { res } = await roda([pendente("a", ORG_RAPIDA, 9)]);

    expect(res.status).toBe(500);
    expect(audit).not.toHaveBeenCalled();
    vi.mocked(cancelarAgendamentoHandler).mockImplementation(async (_s, _c, input) => ({ id: input.id }));
  });

  it("rodada sem nada a expirar NÃO audita", async () => {
    await roda([pendente("b", ORG_LENTA, 1)]);
    expect(audit).not.toHaveBeenCalled();
    await roda([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("rodada que expirou audita uma vez, com a contagem", async () => {
    await roda([pendente("a", ORG_RAPIDA, 9), pendente("c", ORG_LENTA, 30)]);

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agenda.pendente_expirado",
        metadata: expect.objectContaining({
          expirados: 2,
          por_organizacao: { [ORG_RAPIDA]: 1, [ORG_LENTA]: 1 },
        }),
      }),
    );
  });

  it("sem o segredo, 403, e não lê nada", async () => {
    vi.mocked(createAdminClient).mockReturnValue(admin([], []) as never);
    const { POST } = await import("./route");
    const res = await POST(new NextRequest("http://localhost/x"));
    expect(res.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
