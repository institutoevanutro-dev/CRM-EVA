// @vitest-environment node
/**
 * POST /api/v1/conversations/[id]/media — o nome ORIGINAL do anexo.
 *
 * O caminho no bucket nasce `out-<uuid>.<ext>` (dois arquivos com o mesmo nome
 * não podem se sobrescrever), e o envio usava o BASENAME dele como `filename`
 * do documento: o paciente recebia `out-3f9a2b.pdf` no lugar do nome que a
 * pessoa escolheu. A rota é o único ponto que ainda vê o `File`, então é aqui
 * que o nome tem de ser devolvido.
 *
 * Ambiente `node`: no jsdom o `File` do teste e o da rota seriam de mundos
 * diferentes (`instanceof` falha). Mocks no molde de
 * `tests/unit/nota-de-voz-do-iphone-no-upload.test.ts`.
 *
 * Portado do projeto original (DeskcommCRM, PR #4484 de @webtecnica).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "33333333-3333-4333-8333-333333333333";
const NOME_ORIGINAL = "Plano alimentar - Revisão de março - Ação.pdf";

const caminhos = vi.hoisted(() => ({ enviado: null as string | null }));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "agent" },
  })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: { id: "33333333-3333-4333-8333-333333333333" }, error: null }),
    };
    return { from: () => chain };
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    rpc: async () => ({ data: true, error: null }),
    storage: {
      from: () => ({
        upload: async (caminho: string) => {
          caminhos.enviado = caminho;
          return { error: null };
        },
      }),
    },
  })),
}));

import { POST } from "@/app/api/v1/conversations/[id]/media/route";

const ctx = { params: Promise.resolve({ id: CONV_ID }) };

function enviar(nome: string): Promise<Response> {
  const form = new FormData();
  form.append(
    "file",
    new File([new TextEncoder().encode("%PDF-1.4\n%EOF\n")], nome, { type: "application/pdf" }),
  );
  return POST(
    new NextRequest(`http://localhost/api/v1/conversations/${CONV_ID}/media`, { method: "POST", body: form }),
    ctx,
  );
}

beforeEach(() => {
  caminhos.enviado = null;
});

describe("POST /api/v1/conversations/[id]/media — nome do anexo", () => {
  it("devolve o nome ORIGINAL do arquivo, com acentos, espaços e hífens", async () => {
    const res = await enviar(NOME_ORIGINAL);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { media_filename?: string } };
    expect(json.data.media_filename).toBe(NOME_ORIGINAL);
  });

  it("o caminho no bucket continua aleatório: o nome original não vira endereço", async () => {
    await enviar(NOME_ORIGINAL);

    expect(caminhos.enviado).toMatch(new RegExp(`^${ORG_ID}/${CONV_ID}/out-[0-9a-f-]{36}\\.pdf$`));
    expect(caminhos.enviado).not.toContain("Plano");
  });
});
