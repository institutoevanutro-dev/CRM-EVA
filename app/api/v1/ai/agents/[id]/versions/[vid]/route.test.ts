/**
 * PATCH de versão grava SÓ o que veio no corpo.
 *
 * Medido em produção em 2026-10-11: um PATCH com `{ system_prompt }` num
 * rascunho zerou `tool_ids`, `cases_enabled`, `split_messages`, `followup` e
 * mais. O schema era `versionShapeSchema.partial()`, e no Zod `.partial()`
 * preserva `.default(...)`: campo OMITIDO saía do parse com o default e a rota
 * o gravava. O rascunho foi publicado e o agente ficou sem ferramenta nenhuma.
 *
 * O stub guarda a linha do rascunho e aplica o `update` por cima, como o banco:
 * a afirmação é sobre a linha que SOBRA, não sobre a forma do payload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/ai/agents/escopo", () => ({
  validarEscopoDaVersao: vi.fn(async () => ({ ok: true })),
  mensagemDoEscopo: vi.fn(() => ""),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";
const FLUXO = "55555555-5555-4555-8555-555555555555";

const RASCUNHO = {
  id: VERSION,
  agent_id: AGENT,
  organization_id: ORG,
  status: "draft",
  system_prompt: "Você é a atendente da clínica.",
  tool_ids: ["schedule_appointment"],
  max_steps: 15,
  handoff_keywords: ["quero a doutora"],
  cases_enabled: true,
  split_messages: true,
  split_max_chars: 300,
  followup: { enabled: true, flow_pointer_ids: [FLUXO] },
  operator_enabled: true,
};

function stubAdmin(linha: Record<string, unknown>) {
  const chain = (fim: () => Promise<unknown>) => {
    const c: Record<string, unknown> = { eq: () => c, select: () => c, maybeSingle: fim, single: fim };
    return c;
  };
  return {
    from: () => ({
      select: () => chain(async () => ({ data: linha, error: null })),
      update: (payload: Record<string, unknown>) => {
        Object.assign(linha, payload);
        return chain(async () => ({ data: linha, error: null }));
      },
    }),
  };
}

async function patch(linha: Record<string, unknown>, corpo: unknown) {
  vi.mocked(createAdminClient).mockReturnValue(stubAdmin(linha) as never);
  const { PATCH } = await import("./route");
  const req = new NextRequest("http://localhost/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
  return PATCH(req, { params: Promise.resolve({ id: AGENT, vid: VERSION }) });
}

describe("PATCH .../versions/:vid — só o campo enviado muda", () => {
  beforeEach(() => {
    const user: AuthUser = {
      id: USER,
      email: "a@example.com",
      full_name: null,
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR" as const,
      organizations: [{ organization_id: ORG, organization_name: "Org", role: "admin" }],
    };
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user,
      org: { orgId: ORG, name: "Org", role: "admin" },
    } as never);
  });

  it("PATCH só com system_prompt preserva ferramentas, casos, bolhas e follow-up", async () => {
    const linha = structuredClone(RASCUNHO);
    const novo = "Você é a atendente da clínica. Confirme sempre o horário.";

    const res = await patch(linha, { system_prompt: novo });

    expect(res.status).toBe(200);
    expect(linha).toEqual({ ...RASCUNHO, system_prompt: novo });
  });

  it("campo enviado com o valor do default é gravado (false explícito desliga)", async () => {
    const linha = structuredClone(RASCUNHO);

    const res = await patch(linha, { cases_enabled: false, tool_ids: [] });

    expect(res.status).toBe(200);
    expect(linha).toEqual({ ...RASCUNHO, cases_enabled: false, tool_ids: [] });
  });

  it("campo do papel Operador enviado é gravado, e não descartado com 200", async () => {
    const linha = structuredClone(RASCUNHO);

    const res = await patch(linha, { operator_enabled: false });

    expect(res.status).toBe(200);
    expect(linha).toEqual({ ...RASCUNHO, operator_enabled: false });
  });

  it("corpo vazio segue recusado", async () => {
    const res = await patch(structuredClone(RASCUNHO), {});
    expect(res.status).toBe(400);
  });
});
