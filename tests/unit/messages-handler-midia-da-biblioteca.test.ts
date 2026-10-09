/**
 * Fatia 2 da biblioteca de mídias: `sendMessageHandler` envia um item da
 * biblioteca por `media_library_item_id`. O item é lido com o admin client
 * filtrado pela org DA CONVERSA, o termo é conferido na hora, e só o caminho
 * gravado na linha do item (filtrado por `variantesDoItem`) chega ao canal.
 *
 * Forma copiada de `messages-handler-desfechos.test.ts`: fake próprio do
 * Supabase e o WAHA real atrás de `fetch`, para assertar o que de fato sai.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { sendMessageSchema, type SendMessageInput } from "@/lib/schemas";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const ITEM = "66666666-6666-4666-8666-666666666666";
const WAHA_BASE = "http://localhost:3030";

type Row = Record<string, unknown>;

const itemPronto = (over: Row = {}): Row => ({
  id: ITEM,
  organization_id: ORG,
  contains_person: false,
  consent_signed_at: null,
  consent_expires_at: null,
  consent_revoked_at: null,
  variants: [
    { key: "A", storage_path: `${ORG}/${ITEM}/A.jpg`, mime: "image/jpeg", size_bytes: 1234 },
    { key: "B", storage_path: `${ORG}/${ITEM}/B.jpg`, mime: "image/jpeg", size_bytes: 5678 },
  ],
  ...over,
});

// O admin client faz duas coisas aqui: ler o item (filtrado) e assinar a URL.
const admin = vi.hoisted(() => ({
  item: null as Record<string, unknown> | null,
  filtros: [] as Array<[string, unknown]>,
  buckets: [] as string[],
  signedUrl: null as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== "media_library_items") throw new Error(`admin: tabela inesperada ${table}`);
      const filtros: Array<[string, unknown]> = [];
      const cadeia: Record<string, unknown> = {
        select: () => cadeia,
        eq: (col: string, val: unknown) => {
          filtros.push([col, val]);
          admin.filtros.push([col, val]);
          return cadeia;
        },
        maybeSingle: async () => {
          const it = admin.item;
          const casa = it && filtros.every(([c, v]) => it[c] === v);
          return { data: casa ? it : null, error: null };
        },
      };
      return cadeia;
    },
    storage: {
      from: (bucket: string) => {
        admin.buckets.push(bucket);
        return { createSignedUrl: admin.signedUrl };
      },
    },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

function conversationRow(): Row {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    last_inbound_at: null,
    contacts: { phone_number: "+5531999998888", wa_identity: null, is_blocked: false },
    channel_sessions: { provider: "waha", waha_session_name: "default", status: "WORKING", archived_at: null },
  };
}

function makeSupabase() {
  const state: { message: Row | null; inserts: Row[]; preview: unknown } = { message: null, inserts: [], preview: undefined };
  const client = {
    from(table: string) {
      if (table === "channel_sessions") {
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { metadata: {} }, error: null }) };
        return q;
      }
      if (table === "conversations") {
        const cadeia: Record<string, unknown> = {
          eq: () => cadeia,
          maybeSingle: async () => ({ data: conversationRow(), error: null }),
        };
        return {
          select: () => cadeia,
          update: (patch: Row) => {
            state.preview = patch.last_message_preview;
            return { eq: async () => ({ error: null }) };
          },
        };
      }
      if (table === "messages") {
        return {
          insert: (row: Row) => {
            state.inserts.push(row);
            state.message = { id: "msg-1", external_id: null, ack: null, error_code: null, error_message: null, ...row };
            return { select: () => ({ single: async () => ({ data: { ...state.message }, error: null }) }) };
          },
          update: (patch: Row) => {
            state.message = { ...state.message, ...patch };
            const q = {
              eq: () => q,
              select: () => q,
              maybeSingle: async () => ({ data: { ...state.message }, error: null }),
              single: async () => ({ data: { ...state.message }, error: null }),
            };
            return q;
          },
          delete: () => {
            const q: Record<string, unknown> = {
              eq: () => q,
              in: () => q,
              neq: async () => ({ error: null }),
            };
            return q;
          },
        };
      }
      if (table === "contacts") {
        const c: Record<string, unknown> = {
          eq: () => c,
          then: (r: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(r),
        };
        return { update: () => c };
      }
      throw new Error(`fake_supabase: tabela inesperada '${table}'`);
    },
    rpc: async () => ({ error: null }),
  };
  return { supabase: client as unknown as SupabaseClient, state };
}

const ctx: HandlerCtx = { organization_id: ORG, actor: { type: "user", id: USER }, requestId: "req-1" };

function input(over: Partial<SendMessageInput> & Row = {}): SendMessageInput {
  return { conversation_id: CONV, type: "text", media_library_item_id: ITEM, ...over } as SendMessageInput;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv("WAHA_API_BASE_URL", WAHA_BASE);
  vi.stubEnv("WAHA_API_KEY", "hash123");
  fetchMock = vi.fn(async (..._a: unknown[]) => Response.json({ id: { _serialized: "MEDIA1" } }));
  vi.stubGlobal("fetch", fetchMock);
  admin.item = itemPronto();
  admin.filtros = [];
  admin.buckets = [];
  admin.signedUrl = vi.fn(async () => ({ data: { signedUrl: "https://signed.example/lib.jpg" }, error: null }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function recusa(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

describe("sendMessageHandler — mídia da biblioteca", () => {
  it("item de outra organização: 422 media_not_found, sem insert e sem assinatura", async () => {
    admin.item = itemPronto({ organization_id: OUTRA_ORG });
    const { supabase, state } = makeSupabase();
    const err = await recusa(sendMessageHandler(supabase, ctx, input()));
    expect(err.status).toBe(422);
    expect(err.code).toBe("media_not_found");
    expect(err.message).toBe("Mídia não encontrada na biblioteca.");
    expect(admin.filtros).toEqual(expect.arrayContaining([["organization_id", ORG], ["id", ITEM]]));
    expect(state.inserts).toHaveLength(0);
    expect(admin.signedUrl).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("item com pessoa e sem termo: 422 media_not_ready com details.situacao", async () => {
    admin.item = itemPronto({ contains_person: true });
    const { supabase, state } = makeSupabase();
    const err = await recusa(sendMessageHandler(supabase, ctx, input()));
    expect(err.status).toBe(422);
    expect(err.code).toBe("media_not_ready");
    expect(err.details).toEqual({ situacao: "sem_termo" });
    expect(err.message).toBe("Esta mídia não pode ser enviada agora: sem termo de uso de imagem.");
    expect(state.inserts).toHaveLength(0);
  });

  it("caminho de outra organização gravado no item não sai: vira sem arquivo", async () => {
    admin.item = itemPronto({
      variants: [{ key: "A", storage_path: `${OUTRA_ORG}/${ITEM}/A.jpg`, mime: "image/jpeg", size_bytes: 1 }],
    });
    const { supabase } = makeSupabase();
    const err = await recusa(sendMessageHandler(supabase, ctx, input()));
    expect(err.code).toBe("media_not_ready");
    expect(err.details).toEqual({ situacao: "arquivo_ausente" });
    expect(admin.signedUrl).not.toHaveBeenCalled();
  });

  it("item pronto: grava a linha da biblioteca e envia a imagem assinada com a legenda", async () => {
    const { supabase, state } = makeSupabase();
    const msg = await sendMessageHandler(supabase, ctx, input({ body: "Veja o antes e depois", media_variant: "B" }));

    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({
      media_library_item_id: ITEM,
      media_storage_path: null,
      media_url: null,
      media_mime: "image/jpeg",
      media_size_bytes: 5678,
      type: "image",
      body: "Veja o antes e depois",
    });
    expect((state.inserts[0]!.metadata as Row).media_variant).toBe("B");

    expect(admin.buckets).toContain("media-library");
    expect(admin.signedUrl).toHaveBeenCalledWith(`${ORG}/${ITEM}/B.jpg`, 600);

    const envio = fetchMock.mock.calls.find(([url]) => String(url) === `${WAHA_BASE}/api/sendImage`);
    expect(envio, "sendImage não foi chamado").toBeTruthy();
    const body = JSON.parse(String((envio![1] as RequestInit).body)) as Row;
    expect(body.file).toMatchObject({ url: "https://signed.example/lib.jpg", mimetype: "image/jpeg", filename: "B.jpg" });
    expect(body.caption).toBe("Veja o antes e depois");

    expect(msg).toMatchObject({ status: "sent", external_id: "MEDIA1", media_library_item_id: ITEM });
    expect(state.preview).toBe("Veja o antes e depois");
  });

  it("a auditoria message.sent leva o item e a variante", async () => {
    const { supabase } = makeSupabase();
    await sendMessageHandler(supabase, ctx, input({ media_variant: "B" }));
    const chamada = vi.mocked(audit).mock.calls.find(([a]) => a.action === "message.sent");
    expect(chamada?.[0].metadata).toMatchObject({ media_library_item_id: ITEM, media_variant: "B" });
  });

  it("vídeo sai como video; sem body, o preview é [video] e não há legenda", async () => {
    admin.item = itemPronto({
      variants: [{ key: "A", storage_path: `${ORG}/${ITEM}/A.mp4`, mime: "video/mp4", size_bytes: 99 }],
    });
    const { supabase, state } = makeSupabase();
    await sendMessageHandler(supabase, ctx, input());
    expect(state.inserts[0]).toMatchObject({ type: "video" });
    expect((state.inserts[0]!.metadata as Row).media_variant).toBe("A");
    const envio = fetchMock.mock.calls.find(([url]) => String(url) === `${WAHA_BASE}/api/sendVideo`);
    expect(envio).toBeTruthy();
    expect((JSON.parse(String((envio![1] as RequestInit).body)) as Row).caption).toBeUndefined();
    expect(state.preview).toBe("[video]");
  });

  it("sem body, o preview de imagem é [image]", async () => {
    const { supabase, state } = makeSupabase();
    await sendMessageHandler(supabase, ctx, input());
    expect(state.preview).toBe("[image]");
  });

  it("falha ao assinar: failed/storage_sign_failed, nada sai pelo canal", async () => {
    admin.signedUrl = vi.fn(async () => ({ data: null, error: { message: "no_object" } }));
    const { supabase } = makeSupabase();
    const msg = await sendMessageHandler(supabase, ctx, input());
    expect(msg.status).toBe("failed");
    expect(msg.error_code).toBe("storage_sign_failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sendMessageSchema — item da biblioteca", () => {
  it("aceita só o item, sem body", () => {
    expect(sendMessageSchema.safeParse({ conversation_id: CONV, media_library_item_id: ITEM }).success).toBe(true);
  });
  it("recusa item da biblioteca junto com arquivo da conversa", () => {
    const r = sendMessageSchema.safeParse({
      conversation_id: CONV,
      media_library_item_id: ITEM,
      media_storage_path: `${ORG}/${CONV}/a.jpg`,
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message)).toContain(
      "Envie o arquivo da conversa ou o item da biblioteca, não os dois.",
    );
  });
  it("media_variant só aceita A ou B", () => {
    expect(
      sendMessageSchema.safeParse({ conversation_id: CONV, media_library_item_id: ITEM, media_variant: "C" }).success,
    ).toBe(false);
  });
});
