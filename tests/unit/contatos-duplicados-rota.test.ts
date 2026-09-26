import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/v1/contacts/duplicates — a leitura das identidades de Instagram.
 *
 * Com até 2000 contatos varridos, um `.in("contact_id", [...2000 UUIDs])` vira
 * uma URL de ~75 KB no GET do PostgREST: estoura, o erro era ignorado e os
 * pares Instagram × WhatsApp sumiam da tela em silêncio. A leitura agora é só
 * por org + canal, a interseção é em memória, e erro vira 500 visível.
 */
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "U1", idioma: "pt" }),
  resolveActiveOrg: async () => ({ orgId: "ORG" }),
}));

type Chamada = { tabela: string; metodo: string; args: unknown[] };
let chamadas: Chamada[] = [];
let erroIdentidades: { message: string } | null = null;

const contatos = [
  { id: "insta", name: null, display_name: "José Souza", email: null, email_normalized: null, phone_number: null,
    is_merged_into: null, is_anonymized: false, source_metadata: null, created_at: "2026-01-01T00:00:00Z", last_activity_at: null },
  { id: "zap", name: "Jose Souza", display_name: null, email: null, email_normalized: null, phone_number: "+5531998966398",
    is_merged_into: null, is_anonymized: false, source_metadata: null, created_at: "2026-01-02T00:00:00Z", last_activity_at: null },
];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      const c: Record<string, unknown> = {};
      for (const metodo of ["select", "eq", "is", "in", "order", "limit", "range"]) {
        c[metodo] = (...args: unknown[]) => {
          chamadas.push({ tabela, metodo, args });
          return c;
        };
      }
      c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        const r =
          tabela === "contacts"
            ? { data: contatos, error: null }
            : erroIdentidades
              ? { data: null, error: erroIdentidades }
              : { data: [{ contact_id: "insta" }, { contact_id: "de-fora-da-varredura" }], error: null };
        return Promise.resolve(r).then(res, rej);
      };
      return c;
    },
  }),
}));

const { GET } = await import("@/app/api/v1/contacts/duplicates/route");

beforeEach(() => {
  chamadas = [];
  erroIdentidades = null;
});

describe("GET /api/v1/contacts/duplicates — identidades do Instagram", () => {
  it("lê as identidades só por org + canal (sem lista de ids na URL) e acha o par", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const doInstagram = chamadas.filter((c) => c.tabela === "contact_channel_identities");
    expect(doInstagram.some((c) => c.metodo === "in")).toBe(false);
    expect(doInstagram).toContainEqual({ tabela: "contact_channel_identities", metodo: "eq", args: ["organization_id", "ORG"] });
    expect(doInstagram).toContainEqual({ tabela: "contact_channel_identities", metodo: "eq", args: ["channel", "instagram"] });
    const corpo = (await res.json()) as { data: { motivos: string[]; principal_sugerido: string }[] };
    expect(corpo.data).toHaveLength(1);
    expect(corpo.data[0]!.motivos).toContain("mesmo_nome_instagram_whatsapp");
    expect(corpo.data[0]!.principal_sugerido).toBe("zap");
  });

  it("não pede a coluna morta `source` de contatos", async () => {
    await GET();
    const select = chamadas.find((c) => c.tabela === "contacts" && c.metodo === "select");
    expect(String(select?.args[0])).not.toMatch(/\bsource\b(?!_)/);
  });

  it("erro ao ler as identidades não é engolido: 500", async () => {
    erroIdentidades = { message: "URI too long" };
    const res = await GET();
    expect(res.status).toBe(500);
  });
});
