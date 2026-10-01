import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CONECTAR O CANAL OFICIAL TAMBÉM DIZ À META PARA ONDE ENTREGAR.
 *
 * O app da Meta tem um callback só. A segunda conta, noutra organização, nunca
 * recebia mensagem: a Meta entregava na URL da primeira sessão, que ignora a
 * WABA alheia (medido em produção em 26/09/2026). Agora o POST:
 *   - confere que o número pertence à WABA (senão assinaria a conta errada);
 *   - assina a WABA com a URL da PRÓPRIA sessão;
 *   - guarda o resultado na sessão, para a tela seguir avisando depois do reload.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const CANAL = "44444444-4444-4444-8444-444444444444";
const PATH_TOKEN = "tok-da-sessao-nova";
const TOKEN = "EAAG".padEnd(30, "x");

const assinar = vi.fn();
const conferir = vi.fn();
const avisos: Array<[string, Record<string, unknown>]> = [];
/** Ordem das operações: leituras que trazem `metadata`, a chamada à Meta e as escritas. */
const eventos: string[] = [];
let idioma: "pt-BR" | "es" = "pt-BR";

interface Estado {
  linha: Record<string, unknown> | null;
  inserts: number;
  updates: Array<{ patch: Record<string, unknown>; filtros: Array<[string, unknown]> }>;
}
const db: Estado = { linha: null, inserts: 0, updates: [] };

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "u1", idioma, is_platform_admin: false },
    org: { orgId: ORG, role: "admin" },
  }),
}));
vi.mock("@/lib/channels/meta/validate-credentials", () => ({
  MOTIVO_NUMERO_FORA_DA_CONTA: "número fora da conta",
  conferirNumeroDaConta: (...a: unknown[]) => conferir(...a),
  validateMetaCredentials: async () => ({
    ok: true,
    displayPhoneNumber: "+55 11 99999-8888",
    verifiedName: "Clínica",
    qualityRating: null,
  }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: async () => "\\x_cifra" }));
vi.mock("@/lib/channels/meta/app", () => ({
  appDaMeta: async () => ({ appSecret: "s", verifyToken: "verify-da-instalacao" }),
  appDaMetaDoAmbiente: () => ({ appSecret: null, verifyToken: null }),
}));
vi.mock("@/lib/channels/meta/assinar-webhook", () => ({
  assinarWebhookDaConta: (...a: unknown[]) => assinar(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: {
    warn: (msg: string, ctx: Record<string, unknown>) => avisos.push([msg, ctx]),
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const filtros: Array<[string, unknown]> = [];
      let patch: Record<string, unknown> | null = null;
      let colunas = "";
      const q = {
        select: (c: string) => ((colunas = c), q),
        eq: (k: string, v: unknown) => (filtros.push([k, v]), q),
        is: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => {
          if (colunas.includes("metadata")) eventos.push("le_metadata");
          // Cópia: o que a rota leu não muda se o banco mudar depois.
          return { data: db.linha ? structuredClone(db.linha) : null, error: null };
        },
        insert: async () => {
          db.inserts += 1;
          db.linha = { id: CANAL, webhook_path_token: PATH_TOKEN, metadata: { pre_go_live: true } };
          return { error: null };
        },
        update: (p: Record<string, unknown>) => ((patch = p), q),
        then: (res: (v: unknown) => unknown) => {
          if (patch) {
            eventos.push("grava");
            db.updates.push({ patch, filtros });
            if (db.linha) db.linha = { ...db.linha, ...patch };
          }
          // Sem patch é a LISTA das sessões oficiais da org (`conectarCanalOficial`).
          return Promise.resolve(patch ? { error: null } : { data: db.linha ? [structuredClone(db.linha)] : [], error: null }).then(res);
        },
      };
      return q;
    },
  }),
}));

async function conectar(): Promise<{ status: number; corpo: Record<string, unknown> }> {
  const { POST } = await import("@/app/api/v1/channels/official/route");
  const res = await POST(
    new NextRequest("http://localhost/api/v1/channels/official", {
      method: "POST",
      body: JSON.stringify({ phone_number_id: "1103328999528818", waba_id: "2434045433735175", token: TOKEN }),
    }),
  );
  return { status: res.status, corpo: (await res.json()) as Record<string, unknown> };
}

async function webhookDaTela(): Promise<Record<string, unknown>> {
  const { GET } = await import("@/app/api/v1/channels/official/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/channels/official"));
  return ((await res.json()) as { data: { webhook: Record<string, unknown> } }).data.webhook;
}

const metadataGravada = () =>
  (db.updates.find((u) => u.patch.metadata)?.patch.metadata ?? null) as Record<string, unknown> | null;

beforeEach(() => {
  assinar.mockReset();
  conferir.mockReset().mockResolvedValue({ ok: true });
  avisos.length = 0;
  eventos.length = 0;
  idioma = "pt-BR";
  db.linha = null;
  db.inserts = 0;
  db.updates = [];
});

describe("POST /api/v1/channels/official — assina o webhook da conta", () => {
  it("chama a Meta com a URL da própria sessão e guarda o sucesso na sessão", async () => {
    assinar.mockResolvedValue({ ok: true });

    const r = await conectar();
    const data = r.corpo.data as Record<string, unknown>;

    expect(r.status).toBe(200);
    expect(data.webhook).toEqual({ assinado: true });
    expect(assinar).toHaveBeenCalledWith({
      wabaId: "2434045433735175",
      token: TOKEN,
      // A base vem de NEXT_PUBLIC_APP_URL quando configurada (o .env.local pode tê-la).
      callbackUrl: expect.stringMatching(new RegExp(`^https?://[^/]+/api/v1/webhooks/meta/${PATH_TOKEN}$`)),
      verifyToken: "verify-da-instalacao",
    });
    const meta = metadataGravada();
    expect(meta?.pre_go_live).toBe(true); // mescla, não sobrescreve
    expect(meta?.webhook_da_conta).toMatchObject({ assinado: true });
    const escrita = db.updates.find((u) => u.patch.metadata)!;
    expect(escrita.filtros).toContainEqual(["organization_id", ORG]);
    expect(escrita.filtros).toContainEqual(["id", CANAL]);
    expect(avisos).toHaveLength(0);
  });

  it("Meta recusou: a conexão fica, a falha é guardada, logada sem token, e o GET segue avisando", async () => {
    assinar.mockResolvedValue({ ok: false, motivo: "Callback verification failed" });

    const r = await conectar();
    const data = r.corpo.data as Record<string, unknown>;

    expect(r.status).toBe(200);
    expect(data.connected).toBe(true);
    expect(data.webhook).toEqual({ assinado: false, motivo: "Callback verification failed" });

    expect(metadataGravada()?.webhook_da_conta).toMatchObject({
      assinado: false,
      motivo: "Callback verification failed",
      em: expect.any(String),
    });

    expect(avisos).toHaveLength(1);
    expect(avisos[0]![1]).toMatchObject({
      organization_id: ORG,
      waba_id: "2434045433735175",
      motivo: "Callback verification failed",
    });
    expect(JSON.stringify(avisos)).not.toContain(TOKEN);

    const webhook = await webhookDaTela();
    expect(webhook.assinatura).toMatchObject({ assinado: false, motivo: "Callback verification failed" });
  });

  it("a metadata é lida DEPOIS da Meta: chave mudada durante a chamada sobrevive", async () => {
    // O admin liga o gate da IA enquanto a Meta demora a responder.
    assinar.mockImplementation(async () => {
      eventos.push("meta");
      db.linha = { ...db.linha!, metadata: { ...(db.linha!.metadata as object), ai_gate: "allowlist" } };
      return { ok: true };
    });

    await conectar();

    const iMeta = eventos.indexOf("meta");
    expect(eventos.slice(iMeta)).toEqual(["meta", "le_metadata", "grava"]);
    expect(metadataGravada()).toMatchObject({ ai_gate: "allowlist", pre_go_live: true, webhook_da_conta: { assinado: true } });
  });

  it("motivos do sistema saem traduzidos: prefixo de rede e sessão sem endereço", async () => {
    idioma = "es";
    assinar.mockResolvedValue({ ok: false, motivo: "rede indisponível: timed out" });
    const r = await conectar();
    expect((r.corpo.data as { webhook: { motivo: string } }).webhook.motivo).toBe("red no disponible: timed out");

    // Sessão sem webhook_path_token: nem chega a chamar a Meta, e o motivo não é um código cru.
    assinar.mockClear();
    db.linha = { id: "x", webhook_path_token: null, metadata: {} };
    const semEndereco = await conectar();
    const motivo = (semEndereco.corpo.data as { webhook: { motivo: string } }).webhook.motivo;
    expect(assinar).not.toHaveBeenCalled();
    expect(motivo).not.toMatch(/_/);
    expect(motivo).toContain("sesión");
  });

  it("número fora da WABA: 422 antes de gravar, e a Meta não é assinada", async () => {
    conferir.mockResolvedValue({ ok: false, motivo: "número fora da conta" });

    const r = await conectar();

    expect(r.status).toBe(422);
    expect(JSON.stringify(r.corpo)).toContain("número fora da conta");
    expect(db.inserts).toBe(0);
    expect(db.updates).toHaveLength(0);
    expect(assinar).not.toHaveBeenCalled();
  });
});
