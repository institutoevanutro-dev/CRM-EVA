/**
 * O CRM diz à Meta, por CONTA (WABA), para onde entregar as mensagens.
 *
 * Sem isto a Meta usa o callback único do app, e a segunda conta conectada em
 * outra organização nunca recebe nada: a entrega cai na URL da primeira sessão,
 * que (corretamente) ignora a WABA alheia. Medido em produção em 26/09/2026.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MOTIVO_SEM_TOKEN_DE_VERIFICACAO, assinarWebhookDaConta } from "@/lib/channels/meta/assinar-webhook";
import { traduzir } from "@/lib/i18n/dicionario";
import { graphVersion } from "@/lib/graph-version";

const ENTRADA = {
  wabaId: "2434045433735175",
  token: "EAAG-token-de-teste-longo",
  callbackUrl: "https://crm.exemplo.com/api/v1/webhooks/meta/tok-do-canal",
  verifyToken: "verify-de-teste",
};

afterEach(() => vi.unstubAllGlobals());

describe("assinarWebhookDaConta", () => {
  it("POST em /<waba>/subscribed_apps com o callback da sessão; token só no header", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await assinarWebhookDaConta(ENTRADA)).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://graph.facebook.com/${graphVersion()}/${ENTRADA.wabaId}/subscribed_apps`);
    expect(url).not.toContain(ENTRADA.token);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${ENTRADA.token}`);
    const corpo = new URLSearchParams(String(init.body));
    expect(corpo.get("override_callback_uri")).toBe(ENTRADA.callbackUrl);
    expect(corpo.get("verify_token")).toBe(ENTRADA.verifyToken);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("erro da Meta vira ok:false com a mensagem dela", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "Callback verification failed" } }), { status: 400 }),
      ),
    );
    expect(await assinarWebhookDaConta(ENTRADA)).toEqual({ ok: false, motivo: "Callback verification failed" });
  });

  it("erro sem corpo vira o status http", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    expect(await assinarWebhookDaConta(ENTRADA)).toEqual({ ok: false, motivo: "http_502" });
  });

  it("rede caída ou tempo esgotado não lança", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }));
    const r = await assinarWebhookDaConta(ENTRADA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain("timed out");
  });

  it("sem token de verificação na instalação: não chama a Meta", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await assinarWebhookDaConta({ ...ENTRADA, verifyToken: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe(MOTIVO_SEM_TOKEN_DE_VERIFICACAO);
    expect(fetchMock).not.toHaveBeenCalled();
    // Quem lê pode ser admin de um tenant: nada de mandar abrir a tela da instalação.
    expect(MOTIVO_SEM_TOKEN_DE_VERIFICACAO).not.toContain("Admin ›");
    expect(traduzir(MOTIVO_SEM_TOKEN_DE_VERIFICACAO, "es")).not.toBe(MOTIVO_SEM_TOKEN_DE_VERIFICACAO);
  });
});
