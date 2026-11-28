/**
 * PACIENTE ANTIGO NÃO TEM CONVERSÃO (decisão do André, 27/11/2026).
 *
 * A marcação de paciente antigo manda `converted_by_kind: null` EXPLÍCITO:
 * "não houve conversão aqui", e as duas colunas da 0422 ficam nulas. Ausente
 * continua como sempre foi — quem está marcando. Sem isto a rota caía no
 * padrão e a recepcionista aparecia como "Quem converteu" de uma aplicação
 * (`DetalheDoCompromisso`).
 *
 * Dois lados, porque um sozinho deixa o defeito passar: a ROTA tem de aceitar
 * o `null` (senão a marcação de paciente antigo vira 422) e entregá-lo ao
 * handler; o handler tem de resolver `null` em nada. Que o banco aceita as duas
 * nulas (CHECKs da 0422) prova `tests/invariants/agenda-quem-converteu-o-lead.test.ts`.
 *
 *     pnpm vitest run tests/unit/agenda-paciente-antigo-sem-conversao.test.ts
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import type * as Handler from "@/app/api/v1/agenda/agendamentos/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));
vi.mock("@/app/api/v1/agenda/agendamentos/_handler", async (original) => ({
  ...(await original<typeof Handler>()),
  marcarAgendamentoHandler: vi.fn(async () => ({ id: "novo" })),
}));

const { requireRole } = await import("@/lib/auth/require-role");
const { marcarAgendamentoHandler, quemConverteu, autorParaCriacao } = await import("@/app/api/v1/agenda/agendamentos/_handler");
const { POST } = await import("@/app/api/v1/agenda/agendamentos/route");

const ORG = "22222222-2222-4222-8222-222222222222";
const RECEPCAO = "11111111-1111-4111-8111-111111111111";
const COLEGA = "44444444-4444-4444-8444-444444444444";
const TIPO = "33333333-3333-4333-8333-333333333333";

const usuario: AuthUser = {
  id: RECEPCAO,
  email: "recepcao@clinica.test",
  full_name: "Recepção Fictícia",
  avatar_url: null,
  is_platform_admin: false,
  idioma: "pt-BR" as const,
  organizations: [{ organization_id: ORG, organization_name: "Clínica", role: "agent" }],
};
const orgAtiva: ActiveOrg = { orgId: ORG, name: "Clínica", role: "agent" };

/** O banco não pode ser lido: `null` e "ausente" se resolvem sem perguntar à equipe. */
const semBanco = new Proxy({}, {
  get: () => {
    throw new Error("não devia consultar o banco");
  },
}) as never;
const ctx = (actor: HandlerCtx["actor"]): HandlerCtx => ({ organization_id: ORG, actor, requestId: "req-antigo" });

function marcar(corpo: Record<string, unknown>) {
  return POST(
    new NextRequest("https://crm.exemplo/api/v1/agenda/agendamentos", {
      method: "POST",
      body: JSON.stringify({ event_type_id: TIPO, starts_at: "2026-12-02T13:00:00.000Z", ...corpo }),
    }),
  );
}

beforeEach(() => {
  vi.mocked(marcarAgendamentoHandler).mockClear();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: usuario, org: orgAtiva } as never);
});

describe("a rota aceita o `null` de paciente antigo", () => {
  it("`converted_by_kind: null` passa e chega ao handler como null", async () => {
    const res = await marcar({ converted_by_kind: null });
    expect(res.status).toBe(201);
    expect(vi.mocked(marcarAgendamentoHandler).mock.calls[0]?.[2]).toMatchObject({ converted_by_kind: null });
  });

  it("ausente continua ausente (o handler decide: quem marca)", async () => {
    const res = await marcar({});
    expect(res.status).toBe(201);
    expect(vi.mocked(marcarAgendamentoHandler).mock.calls[0]?.[2]).not.toHaveProperty("converted_by_kind");
  });
});

describe("quemConverteu: null é nenhuma conversão", () => {
  const PESSOA = { type: "user", id: RECEPCAO, role: "agent" } as const;

  it("null grava as duas nulas, mesmo com uma pessoa no corpo", async () => {
    await expect(quemConverteu(semBanco, ctx(PESSOA), { event_type_id: TIPO, starts_at: "", converted_by_kind: null })).resolves.toEqual({
      kind: null,
      userId: null,
    });
    await expect(
      quemConverteu(semBanco, ctx(PESSOA), {
        event_type_id: TIPO,
        starts_at: "",
        converted_by_kind: null,
        converted_by_user_id: COLEGA,
      }),
    ).resolves.toEqual({ kind: null, userId: null });
  });

  it("ausente grava quem está marcando", async () => {
    await expect(quemConverteu(semBanco, ctx(PESSOA), { event_type_id: TIPO, starts_at: "" })).resolves.toEqual({
      kind: "user",
      userId: RECEPCAO,
    });
  });

  it("a IA continua `ai`, mesmo que o corpo diga null", async () => {
    await expect(
      quemConverteu(semBanco, ctx({ type: "ai_agent", id: "run-1", role: "agent" }), {
        event_type_id: TIPO,
        starts_at: "",
        converted_by_kind: null,
      }),
    ).resolves.toEqual({ kind: "ai", userId: null });
  });

  it("chave de integração (o Prontuário marcando as datas do tratamento) não converte nem vira IA", async () => {
    await expect(
      quemConverteu(semBanco, ctx({ type: "api_token", id: "tok-1", role: "ai_operator" }), { event_type_id: TIPO, starts_at: "" }),
    ).resolves.toEqual({ kind: null, userId: null });
    expect(autorParaCriacao({ type: "api_token", id: "tok-1" })).toBe("system");
    expect(autorParaCriacao({ type: "ai_agent", id: "run-1", role: "agent" })).toBe("ai");
    expect(autorParaCriacao({ type: "user", id: RECEPCAO })).toBe("user");
  });
});
