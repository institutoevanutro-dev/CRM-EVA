import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Foto de quem chega pelo Instagram. O perfil gravado na identidade traz uma
 * URL do CDN da Meta que EXPIRA; o cron a transforma em arquivo no bucket, como
 * faz com a do WhatsApp — senão a lista mostrava só iniciais para todo contato
 * do Direct.
 */
const CONTATO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const URL_DO_PERFIL = "https://cdn.exemplo.invalid/ig.jpg";

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-de-teste", INTERNAL_SECRET: "segredo-de-teste" },
}));
vi.mock("@/lib/channels", () => ({
  DEFAULT_CHANNEL_PROVIDER: "waha",
  providersComFotoDePerfil: () => ["waha"],
  getAdapter: () => ({}),
}));

const filtros: unknown[][] = [];
const enviados: string[] = [];
const gravados: unknown[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () => {
        const dados =
          tabela === "contact_channel_identities"
            ? [{ avatar_url: URL_DO_PERFIL, contacts: { id: CONTATO, organization_id: ORG } }]
            : [];
        const proxy: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "then") {
                return (ok: (v: unknown) => unknown) => Promise.resolve({ data: dados, error: null }).then(ok);
              }
              return (...args: unknown[]) => {
                if (tabela === "contact_channel_identities") filtros.push([prop, ...args]);
                return proxy;
              };
            },
          },
        );
        return proxy;
      },
      update: (patch: unknown) => {
        gravados.push(patch);
        const proxy: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "select") return () => Promise.resolve({ data: [{ id: CONTATO }], error: null });
              return () => proxy;
            },
          },
        );
        return proxy;
      },
      upsert: async () => ({ error: null }),
    }),
    storage: {
      from: () => ({
        upload: async (path: string) => {
          enviados.push(path);
          return { error: null };
        },
      }),
    },
  }),
}));

import { POST } from "@/app/api/v1/cron/contact-avatars/route";

beforeEach(() => {
  filtros.length = 0;
  enviados.length = 0;
  gravados.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
  );
});

describe("cron de fotos: Instagram", () => {
  it("baixa a foto do perfil para o bucket e grava o ponteiro", async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/cron/contact-avatars", {
        method: "POST",
        headers: { authorization: "Bearer segredo-de-teste" },
      }) as never,
    );
    const body = (await res.json()) as { data: { updated: number } };

    expect(vi.mocked(fetch)).toHaveBeenCalledWith(URL_DO_PERFIL);
    expect(enviados).toEqual([`${ORG}/avatars/${CONTATO}.jpg`]);
    expect(gravados).toContainEqual(expect.objectContaining({ avatar_storage_path: `${ORG}/avatars/${CONTATO}.jpg` }));
    expect(body.data.updated).toBe(1);
  });

  it("só contato não anonimizado e ainda sem foto", async () => {
    await POST(
      new Request("http://localhost/api/v1/cron/contact-avatars", {
        method: "POST",
        headers: { authorization: "Bearer segredo-de-teste" },
      }) as never,
    );
    expect(filtros).toContainEqual(["eq", "contacts.is_anonymized", false]);
    expect(filtros).toContainEqual(["is", "contacts.avatar_storage_path", null]);
  });
});
