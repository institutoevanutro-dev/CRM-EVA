/**
 * A rota do avatar lia `contacts` com a service role, filtrando só por
 * organização: um Prestador (que pela RLS só vê os pacientes que atende —
 * `fn_provider_can_access_contact`, migration 0269) pegava a foto de qualquer
 * contato da organização sabendo o UUID. A leitura passa pelo client de sessão,
 * e a RLS decide; a service role fica só para assinar a URL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/v1/contacts/[id]/avatar/route";

let linhaVisivelPelaRls: { avatar_storage_path: string; is_anonymized: boolean } | null = null;
const createSignedUrl = vi.fn(async () => ({ data: { signedUrl: "https://storage/x" }, error: null }));

function consulta(linha: unknown) {
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: linha, error: null }) };
  return q;
}

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: "u1" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: "org1", name: "Org", role: "provider" })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from: () => consulta(linhaVisivelPelaRls) })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    // A service role enxerga tudo — é por isso que não pode decidir o acesso.
    from: () => consulta({ avatar_storage_path: "org1/avatars/c1.jpg", is_anonymized: false }),
    storage: { from: () => ({ createSignedUrl }) },
  })),
}));

async function pedir() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return GET({} as any, { params: Promise.resolve({ id: "c1" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  linhaVisivelPelaRls = null;
});

describe("GET /api/v1/contacts/[id]/avatar", () => {
  it("contato fora do alcance do Prestador (RLS esconde) → 404, sem assinar nada", async () => {
    const r = await pedir();
    expect(r.status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("contato visível → redireciona para a URL assinada", async () => {
    linhaVisivelPelaRls = { avatar_storage_path: "org1/avatars/c1.jpg", is_anonymized: false };
    const r = await pedir();
    expect(r.status).toBe(307);
    expect(r.headers.get("location")).toBe("https://storage/x");
  });
});
