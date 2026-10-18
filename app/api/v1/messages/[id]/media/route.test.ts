/**
 * Mídia enviada da biblioteca: a rota assina o arquivo do ITEM, da org ativa,
 * na variante gravada na mensagem. O dublê aplica os `eq` de verdade.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { GET } from "./route";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA = "33333333-3333-4333-8333-333333333333";
const ITEM = "44444444-4444-4444-8444-444444444444";
const MSG = "55555555-5555-4555-8555-555555555555";
const CONV = "66666666-6666-4666-8666-666666666666";
const OUTRA_CONV = "77777777-7777-4777-8777-777777777777";

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

function montar(opts: {
  msgOrg?: string;
  itemOrg?: string;
  variante?: string;
  itemId?: string | null;
  metadata?: Record<string, unknown>;
  caminhoGravado?: string;
  falhaAoAssinar?: string;
}) {
  const assinados: string[] = [];
  const buckets: string[] = [];
  const itemId = opts.itemId === undefined ? ITEM : opts.itemId;
  const msg = {
    id: MSG,
    organization_id: opts.msgOrg ?? ORG,
    conversation_id: CONV,
    media_url: null,
    media_mime: "image/png",
    media_storage_path: opts.caminhoGravado ?? null,
    channel_session_id: null,
    media_library_item_id: itemId,
    metadata: opts.metadata ?? (opts.variante ? { media_variant: opts.variante } : {}),
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
            opts.falhaAoAssinar
              ? { data: null, error: { message: opts.falhaAoAssinar } }
              : { data: { signedUrl: `https://sb.test/${b}/${p}?t=1` }, error: null }
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

  it("variante gravada que não existe mais: 404, não cai na variante A", async () => {
    const { assinados } = montar({ variante: "Z" });
    const res = await chamar();
    expect(res.status).toBe(404);
    expect(assinados).toEqual([]);
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

describe("GET /messages/[id]/media com mídia podada pela retenção (migration 0341)", () => {
  it("marcada expired: 410 media_expired com os dias, e nada assinado", async () => {
    const { assinados } = montar({
      itemId: null,
      metadata: { media_status: "expired", media_retention_days: 90 },
    });
    const res = await chamar();
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("media_expired");
    expect(body.error.message).toContain("90 dias");
    expect(assinados).toEqual([]);
  });

  it("sem o marcador continua 404", async () => {
    montar({ itemId: null });
    expect((await chamar()).status).toBe(404);
  });
});

// Porte do upstream melgarafael/DeskcommCRM#2740 (recorte do #1921, de @mrmateussiilva).
describe("GET /messages/[id]/media quando o armazenamento não assina o link", () => {
  it("o erro sai no log estruturado, com a mensagem de quem é, e não em console.error", async () => {
    const solto = vi.spyOn(console, "error").mockImplementation(() => {});
    const estruturado = vi.spyOn(logger, "error").mockImplementation(() => {});
    montar({ itemId: null, caminhoGravado: `${ORG}/${CONV}/${MSG}.ogg`, falhaAoAssinar: "bucket fora do ar" });

    expect((await chamar()).status).toBe(404);
    expect(estruturado).toHaveBeenCalledWith("messages.media.sign_failed", {
      message_id: MSG,
      erro: "bucket fora do ar",
    });
    expect(solto).not.toHaveBeenCalled();
  });
});

// Auditoria 17/10 (CRM-1): `media_storage_path` é gravável pela sessão; a rota
// só assina arquivo desta organização e desta mensagem.
describe("GET /messages/[id]/media com caminho gravado na mensagem", () => {
  it("arquivo da conversa da mensagem: 302", async () => {
    const { assinados } = montar({ itemId: null, caminhoGravado: `${ORG}/${CONV}/out-abc.jpg` });
    expect((await chamar()).status).toBe(302);
    expect(assinados).toEqual([`${ORG}/${CONV}/out-abc.jpg`]);
  });

  it("arquivo desta mensagem que ficou com a conversa antiga (unificação): 302", async () => {
    const { assinados } = montar({ itemId: null, caminhoGravado: `${ORG}/${OUTRA_CONV}/${MSG}.jpg` });
    expect((await chamar()).status).toBe(302);
    expect(assinados).toEqual([`${ORG}/${OUTRA_CONV}/${MSG}.jpg`]);
  });

  it.each([
    ["de outra organização", `${OUTRA}/${CONV}/${MSG}.jpg`],
    ["de outra conversa", `${ORG}/${OUTRA_CONV}/out-abc.jpg`],
    ["de outra mensagem em outra conversa", `${ORG}/${OUTRA_CONV}/${ITEM}.jpg`],
    ["que sai da conversa com ..", `${ORG}/${CONV}/../../${OUTRA}/${CONV}/x.jpg`],
    ["sem conversa", `${ORG}/a.ogg`],
  ])("arquivo %s: 404 e nada assinado", async (_nome, caminho) => {
    const { assinados } = montar({ itemId: null, caminhoGravado: caminho });
    expect((await chamar()).status).toBe(404);
    expect(assinados).toEqual([]);
  });
});
