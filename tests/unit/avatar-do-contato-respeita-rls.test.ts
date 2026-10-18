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
/** Organizações vivas (a consulta de `organizations` é por id). */
const ORGS_VIVAS = new Set(["org1", "org2", "22222222-2222-4222-8222-222222222222"]);
const APAGADA = "99999999-9999-4999-8999-999999999999";

function consultaDeOrg() {
  let id = "";
  const q = {
    select: () => q,
    eq: (_c: string, v: string) => ((id = v), q),
    maybeSingle: async () => ({ data: ORGS_VIVAS.has(id) ? { id } : null, error: null }),
  };
  return q;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    // A service role enxerga tudo — é por isso que não pode decidir o acesso.
    from: (t: string) =>
      t === "organizations"
        ? consultaDeOrg()
        : consulta({ avatar_storage_path: "org1/avatars/c1.jpg", is_anonymized: false }),
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

  // Auditoria 17/10 (CRM-1): `avatar_storage_path` é gravável pela sessão. A
  // service role só assina a foto DESTE contato, desta organização.
  it.each([
    ["de outra organização", "org2/avatars/c1.jpg"],
    ["de outro contato", "org1/avatars/c2.jpg"],
    ["fora de avatars", "org1/conv1/c1.jpg"],
    ["que sai da pasta com ..", "org1/avatars/c1.jpg/../../org2/avatars/c1.jpg"],
    ["de outra organização VIVA (uuid)", "22222222-2222-4222-8222-222222222222/avatars/c9.jpg"],
  ])("caminho %s → 404, sem assinar nada", async (_nome, caminho) => {
    linhaVisivelPelaRls = { avatar_storage_path: caminho, is_anonymized: false };
    const r = await pedir();
    expect(r.status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("caminho legado de organização APAGADA (dados migrados) → 307", async () => {
    linhaVisivelPelaRls = { avatar_storage_path: `${APAGADA}/avatars/c-antigo.jpg`, is_anonymized: false };
    const r = await pedir();
    expect(r.status).toBe(307);
    expect(createSignedUrl).toHaveBeenCalledWith(`${APAGADA}/avatars/c-antigo.jpg`, expect.any(Number));
  });
});
