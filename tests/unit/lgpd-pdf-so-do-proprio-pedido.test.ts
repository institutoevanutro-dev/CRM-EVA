/**
 * Auditoria 17/10 (CRM-1, nota do pdf_path): `lgpd_requests.result` é gravável
 * pela sessão do admin do tenant (policy `lgpd_requests_admin_write`), e a rota
 * de detalhe assinava `result.pdf_path` com a service role. A rota só assina o
 * caminho que o worker grava para ESTE pedido: `{org}/{pedido}/report.pdf`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const PEDIDO = "33333333-3333-4333-8333-333333333333";
const OUTRO_PEDIDO = "44444444-4444-4444-8444-444444444444";

let pdfPath: unknown = null;
const createSignedUrl = vi.fn(async (p: string) => ({ data: { signedUrl: `https://sb.test/${p}` }, error: null }));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { idioma: "pt-BR" }, org: { orgId: ORG } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const linha =
        tabela === "lgpd_requests"
          ? { id: PEDIDO, organization_id: ORG, status: "completed", result: { pdf_path: pdfPath } }
          : null;
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "or", "order"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: linha, error: null });
      q.limit = async () => ({ data: [], error: null });
      return q;
    },
    storage: { from: () => ({ createSignedUrl }) },
  }),
}));

const { GET } = await import("@/app/api/v1/lgpd/requests/[id]/route");

async function urlAssinada(): Promise<string | null> {
  const res = await GET({} as never, { params: Promise.resolve({ id: PEDIDO }) });
  const body = (await res.json()) as { data: { signed_pdf_url: string | null } };
  return body.data.signed_pdf_url;
}

beforeEach(() => createSignedUrl.mockClear());

describe("GET /api/v1/lgpd/requests/[id] — PDF só do próprio pedido", () => {
  it("o caminho do worker para este pedido é assinado", async () => {
    pdfPath = `${ORG}/${PEDIDO}/report.pdf`;
    expect(await urlAssinada()).toBe(`https://sb.test/${ORG}/${PEDIDO}/report.pdf`);
  });

  it.each([
    ["de outra organização", `${OUTRA}/${PEDIDO}/report.pdf`],
    ["de outro pedido", `${ORG}/${OUTRO_PEDIDO}/report.pdf`],
    ["que sai da pasta com ..", `${ORG}/${PEDIDO}/../../${OUTRA}/x/report.pdf`],
  ])("caminho %s: nada assinado", async (_nome, caminho) => {
    pdfPath = caminho;
    expect(await urlAssinada()).toBeNull();
    expect(createSignedUrl).not.toHaveBeenCalled();
  });
});
