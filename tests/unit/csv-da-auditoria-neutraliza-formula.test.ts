/**
 * O CSV da auditoria não executa fórmula no Excel (porte do upstream #3001).
 *
 * O texto da trilha vem de fora — nome de contato, valor de campo, metadata —,
 * e uma célula "=HYPERLINK(...)" ou um trecho "x;=1+1" (o Excel em português
 * divide por `;`) virava fórmula ao abrir o arquivo. Agora sai com a aspa que a
 * planilha lê como texto; número dentro do JSON segue intacto.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

function banco(linhas: Array<Record<string, unknown>>) {
  const consulta: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit", "ilike", "gte", "lte"]) consulta[m] = () => consulta;
  consulta.then = (resolver: (r: unknown) => unknown) => Promise.resolve({ data: linhas, error: null }).then(resolver);
  return { from: () => consulta };
}

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: "org-1", role: "manager" },
  } as never);
});

describe("GET /api/v1/audit/export", () => {
  it("⭐ texto que a planilha leria como fórmula sai como texto; o JSON segue legível", async () => {
    vi.mocked(createClient).mockResolvedValue(
      banco([
        {
          id: "a1",
          created_at: "2026-10-17T12:00:00Z",
          actor_user_id: "u1",
          action: "=HYPERLINK(\"https://exemplo.invalido\")",
          resource_type: "contact",
          resource_id: "c1",
          request_id: "r1",
          actor_ip: null,
          metadata: { nome: "x;=1+1", v: [1, -2, 3] },
        },
      ]) as never,
    );
    const { GET } = await import("@/app/api/v1/audit/export/route");
    const csv = await (await GET(new NextRequest("https://crm.exemplo/api/v1/audit/export"))).text();
    const linha = csv.split("\n")[1]!;

    expect(linha).toContain(`"'=HYPERLINK(""https://exemplo.invalido"")"`);
    expect(linha).toContain(`""x;'=1+1""`);
    expect(linha).toContain("[1,-2,3]");
  });
});
