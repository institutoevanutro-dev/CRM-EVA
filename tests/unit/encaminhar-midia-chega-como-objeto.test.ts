/**
 * A MÍDIA ENCAMINHADA CHEGA COMO OBJETO — pelo envio REAL.
 *
 * O teste do caminho (`encaminhar-mensagem-usa-o-caminho-do-envio.test.ts`)
 * dubla `sendMessageHandler`, e por isso não vê o que sai pelo canal. Aqui o
 * handler é o REAL, com o WAHA atrás de `fetch` (forma de
 * `messages-handler-midia-da-biblioteca.test.ts`), e o que se mede é o que o
 * provedor recebe: a mídia sai por `media_storage_path` — o objeto COPIADO para
 * a pasta da conversa de destino e assinado pelo Storage —, nunca pela
 * `media_url` crua que o canal gravou na entrada.
 *
 * Portado do projeto original (DeskcommCRM, PR #2841). No fork o envio não
 * aceita `media_url`, então a mídia que ainda não desceu para o Storage é
 * recusada com o motivo, sempre.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { encaminharMensagem } from "@/lib/inbox/encaminhar-mensagem";

const ORG = "11111111-1111-4111-8111-111111111111";
const ORIGEM_ID = "22222222-2222-4222-8222-222222222222";
const ORIGEM_CONV = "33333333-3333-4333-8333-333333333333";
const DESTINO_CONV = "44444444-4444-4444-8444-444444444444";
const SESSAO = "55555555-5555-4555-8555-555555555555";
const CONTATO = "66666666-6666-4666-8666-666666666666";
const USUARIO = "77777777-7777-4777-8777-777777777777";
const CONVERSA_UNIFICADA = "88888888-8888-4888-8888-888888888888";
const WAHA_BASE = "http://localhost:3030";

/** A URL que a entrada do canal grava (o endereço interno do serviço). */
const URL_DO_CANAL = "http://localhost:3000/api/files/default/ABC.jpg";
/** O objeto que o `media-persist` guardou para essa mesma mensagem. */
const OBJETO_NA_ORIGEM = `${ORG}/${ORIGEM_CONV}/${ORIGEM_ID}.jpg`;
const OBJETO_NO_DESTINO = `${ORG}/${DESTINO_CONV}/${ORIGEM_ID}.jpg`;

type Row = Record<string, unknown>;

// A cópia e a assinatura saem pelo admin client.
const storage = vi.hoisted(() => ({
  copias: [] as Array<{ origem: string; destino: string }>,
  copy: null as unknown as ReturnType<typeof vi.fn>,
  signedUrl: null as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: { from: () => ({ copy: storage.copy, createSignedUrl: storage.signedUrl }) },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const ctx: HandlerCtx = { organization_id: ORG, actor: { type: "user", id: USUARIO }, requestId: "req-1", idioma: "pt-BR" };

/** A conversa de DESTINO como o envio a lê (com o contato e o canal embutidos). */
function conversaDoDestino(): Row {
  return {
    id: DESTINO_CONV,
    organization_id: ORG,
    contact_id: CONTATO,
    channel_session_id: SESSAO,
    is_group: false,
    group_chat_id: null,
    last_inbound_at: null,
    contacts: { phone_number: "+5531999998888", wa_identity: null, is_blocked: false },
    channel_sessions: { provider: "waha", waha_session_name: "default", status: "WORKING", archived_at: null },
  };
}

/** A mensagem RECEBIDA: o endereço do canal e o objeto que a persistência guardou. */
function origemRecebida(extra: Row = {}): Row {
  return {
    id: ORIGEM_ID,
    organization_id: ORG,
    conversation_id: ORIGEM_CONV,
    type: "image",
    body: "Olha o comprovante",
    media_url: URL_DO_CANAL,
    media_storage_path: OBJETO_NA_ORIGEM,
    media_mime: "image/jpeg",
    revoked_at: null,
    ...extra,
  };
}

/** Fake do Supabase da sessão: lê a origem, a conversa de destino, e guarda o que o envio grava. */
function makeSupabase(origem: Row) {
  const state = { inserts: [] as Row[], message: null as Row | null };
  const client = {
    from(table: string) {
      if (table === "conversations") {
        const cadeia: Record<string, unknown> = {
          eq: () => cadeia,
          maybeSingle: async () => ({ data: conversaDoDestino(), error: null }),
        };
        return { select: () => cadeia, update: () => ({ eq: async () => ({ error: null }) }) };
      }
      if (table === "messages") {
        return {
          select: () => {
            const filtros: Array<[string, unknown]> = [];
            const q: Record<string, unknown> = {
              eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
              maybeSingle: async () => ({ data: filtros.every(([c, v]) => origem[c] === v) ? origem : null, error: null }),
            };
            return q;
          },
          insert: (row: Row) => {
            state.inserts.push(row);
            state.message = { id: "msg-nova", external_id: null, ack: null, error_code: null, error_message: null, ...row };
            return { select: () => ({ single: async () => ({ data: { ...state.message }, error: null }) }) };
          },
          update: (patch: Row) => {
            state.message = { ...state.message, ...patch };
            const q: Record<string, unknown> = {
              eq: () => q,
              select: () => q,
              maybeSingle: async () => ({ data: { ...state.message }, error: null }),
              single: async () => ({ data: { ...state.message }, error: null }),
            };
            return q;
          },
          delete: () => {
            const q: Record<string, unknown> = { eq: () => q, in: () => q, like: () => q, neq: async () => ({ error: null }) };
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

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv("WAHA_API_BASE_URL", WAHA_BASE);
  vi.stubEnv("WAHA_API_KEY", "hash123");
  fetchMock = vi.fn(async (..._a: unknown[]) => Response.json({ id: { _serialized: "MEDIA1" } }));
  vi.stubGlobal("fetch", fetchMock);
  storage.copias = [];
  storage.copy = vi.fn(async (origem: string, destino: string) => {
    storage.copias.push({ origem, destino });
    return { error: null };
  });
  storage.signedUrl = vi.fn(async () => ({ data: { signedUrl: "https://storage.example/sign/m1.jpg" }, error: null }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const encaminhar = (supabase: SupabaseClient) =>
  encaminharMensagem(supabase, ctx, { messageId: ORIGEM_ID, conversationIdDestino: DESTINO_CONV });

describe("encaminhar mídia recebida — objeto copiado, nunca a media_url crua", () => {
  it("copia o objeto para a pasta do DESTINO e o envia por media_storage_path", async () => {
    const { supabase, state } = makeSupabase(origemRecebida());

    const mensagem = await encaminhar(supabase);

    expect(storage.copias).toEqual([{ origem: OBJETO_NA_ORIGEM, destino: OBJETO_NO_DESTINO }]);
    expect(storage.signedUrl).toHaveBeenCalledWith(OBJETO_NO_DESTINO, 600);
    expect(state.inserts[0]).toMatchObject({
      conversation_id: DESTINO_CONV,
      type: "image",
      media_storage_path: OBJETO_NO_DESTINO,
      media_url: null,
      body: "Olha o comprovante",
    });
    expect((state.inserts[0]!.metadata as Row).forwarded_from_message_id).toBe(ORIGEM_ID);
    const envio = fetchMock.mock.calls.find(([url]) => String(url) === `${WAHA_BASE}/api/sendImage`);
    expect(envio, "sendImage não foi chamado").toBeTruthy();
    expect(mensagem.status).toBe("sent");
  });

  it("mensagem que a unificação mudou de conversa: o arquivo dela, nomeado pelo id, também vai", async () => {
    const naPastaAntiga = `${ORG}/${CONVERSA_UNIFICADA}/${ORIGEM_ID}.jpg`;
    const { supabase } = makeSupabase(origemRecebida({ media_storage_path: naPastaAntiga }));

    await encaminhar(supabase);

    expect(storage.copias).toEqual([{ origem: naPastaAntiga, destino: OBJETO_NO_DESTINO }]);
  });

  it("mídia ainda não persistida (só a URL do canal): recusa com motivo TRADUZIDO, nada sai", async () => {
    const { supabase, state } = makeSupabase(origemRecebida({ media_storage_path: null }));

    await expect(encaminhar(supabase)).rejects.toMatchObject({
      status: 422,
      code: "nao_encaminhavel",
      message: "A mídia desta mensagem ainda não chegou ao CRM. Tente encaminhar de novo em alguns segundos.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.inserts).toEqual([]);
    expect(storage.copias).toEqual([]);
  });

  it("objeto de outra conversa (caminho com ..) não é copiado: recusa alta", async () => {
    const { supabase, state } = makeSupabase(
      // Caminho da conversa de OUTRA pessoa: copiar isso vazaria o arquivo dela.
      origemRecebida({ media_storage_path: `${ORG}/${DESTINO_CONV}/../${ORIGEM_CONV}/x.jpg` }),
    );

    await expect(encaminhar(supabase)).rejects.toMatchObject({
      status: 422,
      code: "nao_encaminhavel",
      message: "Esta mídia não pode ser encaminhada.",
    });
    expect(storage.copias).toEqual([]);
    expect(state.inserts).toEqual([]);
  });

  it("proposta em PDF (objeto fora da pasta da conversa): recusa sem 'tente de novo'", async () => {
    const { supabase } = makeSupabase(
      origemRecebida({ media_storage_path: `${ORG}/99999999-9999-4999-8999-999999999999.pdf`, type: "document" }),
    );

    await expect(encaminhar(supabase)).rejects.toMatchObject({
      code: "nao_encaminhavel",
      message: "Esta mídia não pode ser encaminhada.",
    });
    expect(storage.copias).toEqual([]);
  });

  it("imagem que a retenção apagou: não sai só a legenda dizendo 'encaminhada'", async () => {
    const { supabase, state } = makeSupabase(origemRecebida({ media_storage_path: null, media_url: null }));

    await expect(encaminhar(supabase)).rejects.toMatchObject({
      code: "nao_encaminhavel",
      message: "Esta mídia não pode ser encaminhada.",
    });
    expect(state.inserts).toEqual([]);
  });

  it("a cópia que falha no Storage recusa com 'tente de novo', sem enviar", async () => {
    storage.copy = vi.fn(async () => ({ error: { message: "Storage fora do ar" } }));
    const { supabase, state } = makeSupabase(origemRecebida());

    await expect(encaminhar(supabase)).rejects.toMatchObject({
      code: "nao_encaminhavel",
      message: "Não consegui preparar a mídia desta mensagem para o encaminhamento. Tente de novo em instantes.",
    });
    expect(state.inserts).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
