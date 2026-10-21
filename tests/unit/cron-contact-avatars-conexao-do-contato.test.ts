import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A FOTO DO CONTATO VEM DA CONEXÃO DA CONVERSA DELE.
 *
 * O cron escolhia a primeira `channel_sessions` WORKING da empresa, sem ordem
 * e sem ligação com o contato. Com dois números de WhatsApp, a foto era pedida
 * ao número que talvez nunca tenha falado com a pessoa. Agora: a conversa mais
 * recente do contato decide a conexão; quem tem conversa não cai para outra; só
 * o contato SEM conversa usa a primeira conexão da empresa que busca foto.
 *
 * Portado do projeto original (DeskcommCRM, PR #3110 de @paulolimajr77).
 */

const CONTATO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const pedidos: Array<{ sessionRef: string; recipient: string }> = [];
const uploads: string[] = [];

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-de-teste", INTERNAL_SECRET: "segredo-de-teste" },
}));

vi.mock("@/lib/channels", () => ({
  DEFAULT_CHANNEL_PROVIDER: "waha",
  CHANNEL_SESSION_REF_COLUMNS: "provider, waha_session_name",
  resolveSessionRef: (s: { waha_session_name: string }) => s.waha_session_name,
  providersComFotoDePerfil: () => ["waha"],
  getAdapter: () => ({
    fetchProfilePictureUrl: async (input: { sessionRef: string; recipient: string }) => {
      pedidos.push({ sessionRef: input.sessionRef, recipient: input.recipient });
      return "https://cdn.exemplo.invalid/foto.jpg";
    },
  }),
}));

const sessao = (nome: string, status = "WORKING", archived_at: string | null = null) => ({
  provider: "waha",
  waha_session_name: nome,
  status,
  archived_at,
});

let conversaDoContato: unknown = null;
/** As conexões da empresa, em ordem de criação: a "recepção" é a mais antiga. */
const SESSOES_DA_EMPRESA = [sessao("recepcao"), sessao("comercial")];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () => {
        const dados =
          tabela === "contacts"
            ? [{ id: CONTATO, organization_id: ORG, wa_identity: "phone:+5527999990000", wa_lid: null, phone_number: "+5527999990000", avatar_storage_path: null }]
            : tabela === "conversations"
              ? conversaDoContato
              : tabela === "channel_sessions"
                ? SESSOES_DA_EMPRESA
                : [];
        const proxy: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "then") return (ok: (v: unknown) => unknown) => Promise.resolve({ data: dados, error: null }).then(ok);
              if (prop === "maybeSingle") return async () => ({ data: dados, error: null });
              return () => proxy;
            },
          },
        );
        return proxy;
      },
      update: () => {
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
          uploads.push(path);
          return { error: null };
        },
      }),
    },
  }),
}));

import { POST } from "@/app/api/v1/cron/contact-avatars/route";

beforeEach(() => {
  pedidos.length = 0;
  uploads.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })));
});

const chamar = () =>
  POST(
    new Request("http://localhost/api/v1/cron/contact-avatars", {
      method: "POST",
      headers: { authorization: "Bearer segredo-de-teste" },
    }) as never,
  );

describe("cron de fotos: de qual conexão", () => {
  it("⭐ contato que fala pelo segundo número: a foto é pedida a esse número, não ao primeiro da empresa", async () => {
    conversaDoContato = { channel_sessions: sessao("comercial") };
    await chamar();
    expect(pedidos).toEqual([{ sessionRef: "comercial", recipient: "5527999990000@c.us" }]);
    // O caminho da foto continua `{org}/avatars/{contactId}.*`.
    expect(uploads).toEqual([`${ORG}/avatars/${CONTATO}.jpg`]);
  });

  it("conversa numa conexão parada ou arquivada: sem foto, e não cai para outra conexão", async () => {
    conversaDoContato = { channel_sessions: sessao("comercial", "STOPPED") };
    await chamar();
    conversaDoContato = { channel_sessions: sessao("comercial", "WORKING", "2026-10-01T00:00:00Z") };
    await chamar();
    expect(pedidos).toEqual([]);
  });

  it("contato sem conversa nenhuma: a primeira conexão da empresa (por criação) que busca foto", async () => {
    conversaDoContato = null;
    await chamar();
    expect(pedidos).toEqual([{ sessionRef: "recepcao", recipient: "5527999990000@c.us" }]);
  });
});
