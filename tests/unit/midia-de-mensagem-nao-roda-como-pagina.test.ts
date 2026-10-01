/**
 * C3 (auditoria 2026-09-29) — a rota de mídia devolvia, na origem do CRM, o
 * Content-Type que o REMETENTE declarou. Um documento `text/html` mandado por
 * um contato virava página logada como o atendente (XSS armazenado).
 *
 * Só tipos de mídia inofensivos saem inline; o resto é download opaco. E toda
 * resposta leva sandbox + nosniff.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/v1/messages/[id]/media/route";
import { cabecalhosDeMidia } from "@/lib/messaging/media/servir";

let mimeDoRemetente = "text/html";

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: "u1", idioma: "pt-BR" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: "org1", name: "Org", role: "agent" })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: {
            id: "m1",
            media_url: "http://localhost:3000/api/files/default/x.html",
            media_mime: mimeDoRemetente,
            media_storage_path: null,
            channel_session_id: "s1",
          },
          error: null,
        }),
      };
      return q;
    },
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: { provider: "waha", waha_session_name: "default" }, error: null }),
      };
      return q;
    },
  })),
}));
vi.mock("@/lib/channels", () => ({
  CHANNEL_SESSION_REF_COLUMNS: "provider",
  DEFAULT_CHANNEL_PROVIDER: "waha",
  resolveSessionRef: () => "default",
  getAdapter: () => ({
    fetchInboundMedia: async () => ({
      buffer: Buffer.from("<script>alert(1)</script>"),
      mime: mimeDoRemetente,
    }),
  }),
}));

async function baixar() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return GET({} as any, { params: Promise.resolve({ id: "m1" }) });
}

beforeEach(() => {
  mimeDoRemetente = "text/html";
});

describe("GET /api/v1/messages/[id]/media — fallback do proxy", () => {
  it.each(["text/html", "image/svg+xml", "application/xhtml+xml", "text/html; charset=utf-8", "TEXT/HTML"])(
    "%s vira download opaco, sandbox e nosniff",
    async (mime) => {
      mimeDoRemetente = mime;
      const r = await baixar();
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("application/octet-stream");
      expect(r.headers.get("content-disposition")).toMatch(/^attachment/);
      expect(r.headers.get("content-security-policy")).toMatch(/sandbox/);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    },
  );

  it("imagem comum continua inline (o <img> da conversa depende disso)", async () => {
    mimeDoRemetente = "image/jpeg";
    const r = await baixar();
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(r.headers.get("content-disposition")).toBe("inline");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("cabecalhosDeMidia", () => {
  it("áudio com parâmetro de codec continua inline", () => {
    expect(cabecalhosDeMidia("audio/ogg; codecs=opus")["Content-Type"]).toBe("audio/ogg");
  });
  it("mime ausente é download", () => {
    expect(cabecalhosDeMidia(null)["Content-Disposition"]).toBe("attachment");
  });
});
