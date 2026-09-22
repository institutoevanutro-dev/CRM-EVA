/**
 * RESPONSÁVEL DA TAREFA — só alguém da própria clínica.
 *
 * `crm_tasks.assigned_to` referencia `auth.users`, não a organização: sem esta
 * conferência, um POST com o id de um usuário de OUTRA organização passava, e a
 * tarefa aparecia no Início dele. O dublê aplica os filtros de verdade — tirar
 * o `.eq("organization_id", …)` do helper deixa o caso de outra org vermelho.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { responsavelValido } from "@/lib/tarefas/responsavel";
import { fakeDb } from "@/lib/inicio/fake-db.test-helper";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: () => false }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn(async () => ({ ok: true })) }));

import { POST } from "@/app/api/v1/tasks/route";
import { PATCH } from "@/app/api/v1/tasks/[id]/route";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA = "33333333-3333-4333-8333-333333333333";
const ANA = "11111111-1111-4111-8111-111111111111";
const ERICK = "44444444-4444-4444-8444-444444444444";
const DE_FORA = "66666666-6666-4666-8666-666666666666";
const SAIU = "77777777-7777-4777-8777-777777777777";
const VIEWER = "88888888-8888-4888-8888-888888888888";

const MEMBROS = [
  { organization_id: ORG, user_id: ANA, role: "admin", revoked_at: null },
  { organization_id: ORG, user_id: ERICK, role: "agent", revoked_at: null },
  { organization_id: ORG, user_id: SAIU, role: "agent", revoked_at: "2026-09-01T00:00:00Z" },
  { organization_id: ORG, user_id: VIEWER, role: "viewer", revoked_at: null },
  { organization_id: OUTRA, user_id: DE_FORA, role: "admin", revoked_at: null },
];

describe("responsavelValido", () => {
  const { db } = fakeDb({ user_organizations: MEMBROS });
  it("aceita membro ativo da organização", async () => {
    expect(await responsavelValido(db, ORG, ERICK)).toBe(true);
  });
  it("recusa quem é de outra organização", async () => {
    expect(await responsavelValido(db, ORG, DE_FORA)).toBe(false);
  });
  it("recusa quem saiu da equipe", async () => {
    expect(await responsavelValido(db, ORG, SAIU)).toBe(false);
  });
  it("recusa visualizador — ele não pode mexer em tarefa", async () => {
    expect(await responsavelValido(db, ORG, VIEWER)).toBe(false);
  });
});

describe("rotas de tarefa conferem o responsável", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: ANA, idioma: "pt-BR" },
      org: { orgId: ORG, role: "admin" },
    } as never);
    vi.mocked(createClient).mockResolvedValue(fakeDb({ user_organizations: MEMBROS }).db as never);
  });

  it("POST recusa responsável de outra organização com 422 e não grava", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/v1/tasks", {
        method: "POST",
        body: JSON.stringify({ title: "Ligar para a paciente", assigned_to: DE_FORA }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  it("PATCH recusa trocar o responsável para quem saiu da equipe", async () => {
    const res = await PATCH(
      new NextRequest("http://localhost/api/v1/tasks/x", {
        method: "PATCH",
        body: JSON.stringify({ assigned_to: SAIU }),
      }),
      { params: Promise.resolve({ id: "55555555-5555-4555-8555-555555555555" }) },
    );
    expect(res.status).toBe(422);
  });
});
