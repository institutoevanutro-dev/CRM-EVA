import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

import { POST } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ATENDENTE = "33333333-3333-4333-8333-333333333333";
const AMIGO = "44444444-4444-4444-8444-444444444444";
const CONVERSA = "77777777-7777-4777-8777-777777777777";
const GRUPO = "88888888-8888-4888-8888-888888888888";
const DA_B = "99999999-9999-4999-8999-999999999999";

type Linha = Record<string, unknown>;
let tabelas: Record<string, Linha[]>;

function bancoFalso() {
  return {
    from: (tabela: string) => {
      const filtros: Array<(l: Linha) => boolean> = [];
      let patch: Linha | null = null;
      const q = {
        update: (p: Linha) => ((patch = p), q),
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
        is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), q),
        not: (c: string, _op: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) !== v), q),
        maybeSingle: async () => {
          const alvo = (tabelas[tabela] ?? []).find((l) => filtros.every((f) => f(l))) ?? null;
          if (alvo && patch) Object.assign(alvo, patch);
          return { data: alvo ? { ...alvo } : null, error: null };
        },
      };
      return q;
    },
  };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new NextRequest("http://localhost/api/v1/conversations/x/ocultar", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  tabelas = {
    conversations: [
      { id: CONVERSA, organization_id: ORG_A, contact_id: AMIGO },
      { id: GRUPO, organization_id: ORG_A, contact_id: null },
      { id: DA_B, organization_id: ORG_B, contact_id: "c-b" },
    ],
    contacts: [
      { id: AMIGO, organization_id: ORG_A, is_anonymized: false, inbox_hidden_at: null, inbox_hidden_by: null },
      { id: "c-b", organization_id: ORG_B, is_anonymized: false, inbox_hidden_at: null, inbox_hidden_by: null },
    ],
  };
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(createAdminClient).mockReturnValue(bancoFalso() as unknown as ReturnType<typeof createAdminClient>);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ATENDENTE, idioma: "pt-BR" },
    org: { orgId: ORG_A, role: "agent" },
  } as Awaited<ReturnType<typeof requireRole>>);
});

describe("ocultar do Inbox pela conversa (cabeçalho e lote)", () => {
  it("oculta o CONTATO da conversa e audita com a conversa de onde veio", async () => {
    const r = await POST(req(), ctx(CONVERSA));
    expect(r.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "conversations" }));
    expect(tabelas.contacts![0]!.inbox_hidden_by).toBe(ATENDENTE);
    expect((await r.json()).data).toMatchObject({ conversation_id: CONVERSA, contact_id: AMIGO, mudou: true });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.inbox_hidden",
        resourceId: AMIGO,
        organizationId: ORG_A,
        metadata: expect.objectContaining({ origem: "inbox", conversation_id: CONVERSA }),
      }),
    );
  });

  it("conversa de outra organização: 404 sem tocar o contato dela", async () => {
    expect((await POST(req(), ctx(DA_B))).status).toBe(404);
    expect(tabelas.contacts![1]!.inbox_hidden_at).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("conversa de grupo não tem contato: 422", async () => {
    const r = await POST(req(), ctx(GRUPO));
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("conversa_sem_contato");
  });

  it("viewer: a recusa do requireRole, sem banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden_role", "papel", 403) });
    expect((await POST(req(), ctx(CONVERSA))).status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
