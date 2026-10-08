/**
 * Mídia enviada da biblioteca: a rota assina o arquivo do ITEM, da org ativa,
 * na variante gravada na mensagem. O dublê aplica os `eq` de verdade.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { GET } from "./route";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA = "33333333-3333-4333-8333-333333333333";
const ITEM = "44444444-4444-4444-8444-444444444444";
const MSG = "55555555-5555-4555-8555-555555555555";

type Linha = Record<string, unknown>;

function tabela(linhas: Linha[]) {
  const filtros: Array<[string, unknown]> = [];
  const q = {
    select: () => q,
    eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
    maybeSingle: async () => ({
      data: linhas.find((l) => filtros.every(([c, v]) => l[c] === v)) ?? null,
      error: null,
    }),
  };
  return q;
}

function montar(opts: { msgOrg?: string; itemOrg?: string; variante?: string; itemId?: string | null }) {
  const assinados: string[] = [];
  const buckets: string[] = [];
  const itemId = opts.itemId === undefined ? ITEM : opts.itemId;
  const msg = {
    id: MSG,
    organization_id: opts.msgOrg ?? ORG,
    media_url: null,
    media_mime: "image/png",
    media_storage_path: null,
    channel_session_id: null,
    media_library_item_id: itemId,
    metadata: opts.variante ? { media_variant: opts.variante } : {},
  };
  const item = {
    id: ITEM,
    organization_id: opts.itemOrg ?? ORG,
    variants: ["A", "B"].map((k) => ({
      key: k,
      storage_path: `${opts.itemOrg ?? ORG}/${ITEM}/${k}.png`,
      mime: "image/png",
      size_bytes: 10,
    })),
  };
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: "u" } }, error: null }) },
    from: () => tabela([msg]),
  } as never);
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => tabela([item]),
    storage: {
      from: (b: string) => (
        buckets.push(b),
        {
          createSignedUrl: async (p: string) => (
            assinados.push(p),
            { data: { signedUrl: `https://sb.test/${b}/${p}?t=1` }, error: null }
          ),
        }
      ),
    },
  } as never);
  return { assinados, buckets };
}

const chamar = () =>
  GET(new NextRequest(`http://x/api/v1/messages/${MSG}/media`), {
    params: Promise.resolve({ id: MSG }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadAuthUser).mockResolvedValue({ idioma: "pt-BR" } as never);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG } as never);
});

describe("GET /messages/[id]/media com item da biblioteca", () => {
  it("item da org: 302 para o bucket media-library", async () => {
    const { buckets } = montar({});
    const res = await chamar();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("https://sb.test/media-library/");
    expect(buckets).toEqual(["media-library"]);
  });

  it("assina a variante gravada em metadata", async () => {
    const { assinados } = montar({ variante: "B" });
    await chamar();
    expect(assinados).toEqual([`${ORG}/${ITEM}/B.png`]);
  });

  it("item de outra org: 404 e nada assinado", async () => {
    const { assinados } = montar({ itemOrg: OUTRA });
    const res = await chamar();
    expect(res.status).toBe(404);
    expect(assinados).toEqual([]);
  });

  it("item apagado (FK nulo): 404, não 500", async () => {
    montar({ itemId: null });
    expect((await chamar()).status).toBe(404);
  });
});
