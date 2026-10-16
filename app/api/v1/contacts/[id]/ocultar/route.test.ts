import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

import { DELETE, POST } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ATENDENTE = "33333333-3333-4333-8333-333333333333";
const AMIGO = "44444444-4444-4444-8444-444444444444";
const DA_B = "55555555-5555-4555-8555-555555555555";
const ANONIMIZADO = "66666666-6666-4666-8666-666666666666";

type Linha = Record<string, unknown>;
let contatos: Linha[];

/**
 * Banco falso que APLICA os filtros do update e da releitura: sem isso, tirar
 * o `.eq("organization_id", …)` da escrita deixaria o teste de isolamento verde.
 */
function bancoFalso() {
  return {
    from: (tabela: string) => {
      if (tabela !== "contacts") throw new Error(`tabela inesperada: ${tabela}`);
      const filtros: Array<(l: Linha) => boolean> = [];
      let patch: Linha | null = null;
      const q = {
        update: (p: Linha) => ((patch = p), q),
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
        is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), q),
        not: (c: string, _op: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) !== v), q),
        maybeSingle: async () => {
          const alvo = contatos.find((l) => filtros.every((f) => f(l))) ?? null;
          if (alvo && patch) Object.assign(alvo, patch);
          return { data: alvo ? { ...alvo } : null, error: null };
        },
      };
      return q;
    },
  };
}

const ctx = (id = AMIGO) => ({ params: Promise.resolve({ id }) });
const req = (method: "POST" | "DELETE") =>
  new NextRequest(`http://localhost/api/v1/contacts/x/ocultar`, {
    method,
    body: JSON.stringify({ organization_id: ORG_B }),
  });

function comPapel(role: "agent" | "manager") {
  vi.mocked(requireRole).mockImplementation(async (min) =>
    (min === "manager" && role === "agent"
      ? { ok: false, response: fail("forbidden_role", "papel", 403) }
      : { ok: true, user: { id: ATENDENTE, idioma: "pt-BR" }, org: { orgId: ORG_A, role } }) as Awaited<
      ReturnType<typeof requireRole>
    >,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  contatos = [
    { id: AMIGO, organization_id: ORG_A, is_anonymized: false, inbox_hidden_at: null, inbox_hidden_by: null },
    { id: DA_B, organization_id: ORG_B, is_anonymized: false, inbox_hidden_at: null, inbox_hidden_by: null },
    { id: ANONIMIZADO, organization_id: ORG_A, is_anonymized: true, inbox_hidden_at: null, inbox_hidden_by: null },
  ];
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(createAdminClient).mockReturnValue(bancoFalso() as unknown as ReturnType<typeof createAdminClient>);
  comPapel("agent");
});

describe("ocultar um contato do Inbox (ficha do contato)", () => {
  it("atendente oculta: grava quem e quando, e audita contact.inbox_hidden", async () => {
    const r = await POST(req("POST"), ctx());
    expect(r.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "contacts" }));
    const amigo = contatos.find((c) => c.id === AMIGO)!;
    expect(amigo.inbox_hidden_by).toBe(ATENDENTE);
    expect(typeof amigo.inbox_hidden_at).toBe("string");
    expect((await r.json()).data).toMatchObject({ id: AMIGO, mudou: true });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.inbox_hidden",
        actorUserId: ATENDENTE,
        organizationId: ORG_A,
        resourceType: "contact",
        resourceId: AMIGO,
        metadata: expect.objectContaining({ origem: "tela_do_contato" }),
      }),
    );
  });

  it("ocultar de novo não muda nada e não audita", async () => {
    await POST(req("POST"), ctx());
    vi.mocked(audit).mockClear();
    const r = await POST(req("POST"), ctx());
    expect((await r.json()).data).toMatchObject({ mudou: false });
    expect(audit).not.toHaveBeenCalled();
  });

  it("trazer de volta é de gerente: o atendente leva 403 e nada muda", async () => {
    contatos[0]!.inbox_hidden_at = "2026-10-16T10:00:00.000Z";
    const r = await DELETE(req("DELETE"), ctx());
    expect(r.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
    expect(contatos[0]!.inbox_hidden_at).toBe("2026-10-16T10:00:00.000Z");
    expect(audit).not.toHaveBeenCalled();
  });

  it("o gerente traz de volta e audita contact.inbox_unhidden", async () => {
    comPapel("manager");
    contatos[0]!.inbox_hidden_at = "2026-10-16T10:00:00.000Z";
    contatos[0]!.inbox_hidden_by = ATENDENTE;
    const r = await DELETE(req("DELETE"), ctx());
    expect(r.status).toBe(200);
    expect(contatos[0]).toMatchObject({ inbox_hidden_at: null, inbox_hidden_by: null });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "contact.inbox_unhidden", resourceId: AMIGO }));
  });

  it("contato de outra organização: 404, e a organização do corpo é ignorada", async () => {
    const r = await POST(req("POST"), ctx(DA_B));
    expect(r.status).toBe(404);
    expect(contatos.find((c) => c.id === DA_B)!.inbox_hidden_at).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("contato anonimizado não se edita (LGPD)", async () => {
    const r = await POST(req("POST"), ctx(ANONIMIZADO));
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("lgpd_anonymization_irreversible");
    expect(audit).not.toHaveBeenCalled();
  });

  it("acompanhamento somente leitura e id inválido param antes do banco", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValueOnce(fail("forbidden", "somente leitura", 403));
    expect((await POST(req("POST"), ctx())).status).toBe(403);
    expect((await POST(req("POST"), ctx("nao-e-uuid"))).status).toBe(422);
    expect(contatos[0]!.inbox_hidden_at).toBeNull();
  });
});
