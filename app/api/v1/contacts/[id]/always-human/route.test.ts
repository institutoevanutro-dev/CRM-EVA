import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import { DELETE, POST } from "./route";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const ATENDENTE = "33333333-3333-4333-8333-333333333333";

interface Linha {
  id: string;
  organization_id: string;
  ai_opt_out: boolean;
  force_human: boolean;
  is_anonymized: boolean;
}
let linhas: Linha[];
const patches: Record<string, unknown>[] = [];

/** Dublê que aplica os filtros de verdade: o update só casa a linha que bate em TODOS. */
function fake() {
  return {
    from: () => {
      let patch: Record<string, unknown> | null = null;
      const filtros: Record<string, unknown> = {};
      const q = {
        update: (p: Record<string, unknown>) => ((patch = p), patches.push(p), q),
        select: () => q,
        eq: (k: string, v: unknown) => ((filtros[k] = v), q),
        maybeSingle: async () => {
          const linha = linhas.find((l) =>
            Object.entries(filtros).every(([k, v]) => (l as unknown as Record<string, unknown>)[k] === v),
          );
          if (linha && patch) Object.assign(linha, patch);
          return { data: linha ? { ...linha } : null, error: null };
        },
      };
      return q;
    },
  };
}

const ctx = { params: Promise.resolve({ id: CONTATO }) };
const req = (method: string) => new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}/always-human`, { method });

beforeEach(() => {
  vi.clearAllMocks();
  patches.length = 0;
  linhas = [{ id: CONTATO, organization_id: ORG, ai_opt_out: false, force_human: false, is_anonymized: false }];
  vi.mocked(createClient).mockResolvedValue(fake() as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ATENDENTE, idioma: "pt-BR" },
    org: { orgId: ORG },
  } as never);
});

describe("POST|DELETE /api/v1/contacts/[id]/always-human", () => {
  it("agent+ marca: liga a marca E force_human no mesmo update, e audita", async () => {
    const res = await POST(req("POST"), ctx);
    expect(res.status).toBe(200);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("agent");
    expect(patches[0]).toEqual({ ai_opt_out: true, force_human: true });
    expect(linhas[0]).toMatchObject({ ai_opt_out: true, force_human: true });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "contact.always_human_set", organizationId: ORG, resourceId: CONTATO }),
    );
  });

  it("marcar de novo não muda nada e não audita", async () => {
    linhas[0]!.ai_opt_out = true;
    linhas[0]!.force_human = true;
    const res = await POST(req("POST"), ctx);
    expect(res.status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("desmarcar tira só a marca: force_human fica (a IA não volta sozinha)", async () => {
    linhas[0]!.ai_opt_out = true;
    linhas[0]!.force_human = true;
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(200);
    expect(patches[0]).toEqual({ ai_opt_out: false });
    expect(linhas[0]).toMatchObject({ ai_opt_out: false, force_human: true });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "contact.always_human_cleared" }));
  });

  it("contato de outra organização: 404, nada muda", async () => {
    linhas[0]!.organization_id = "99999999-9999-4999-8999-999999999999";
    const res = await POST(req("POST"), ctx);
    expect(res.status).toBe(404);
    expect(linhas[0]!.ai_opt_out).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it("contato anonimizado: 403 LGPD", async () => {
    linhas[0]!.is_anonymized = true;
    const res = await POST(req("POST"), ctx);
    expect(res.status).toBe(403);
    expect(linhas[0]!.ai_opt_out).toBe(false);
  });
});
