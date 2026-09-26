/**
 * Diz à Meta, por CONTA (WABA), para onde entregar as mensagens desta sessão.
 *
 * O app da Meta tem UM callback de webhook. Com duas contas conectadas em
 * organizações diferentes, a Meta entrega tudo na URL cadastrada no app, que é
 * a de uma sessão só; o webhook dela ignora a WABA alheia (certo), e a segunda
 * conta nunca recebe nada. Medido em produção em 26/09/2026. O
 * `override_callback_uri` por WABA resolve: cada conta aponta para a URL da
 * própria sessão.
 *
 * Nunca lança: a conexão já foi gravada quando isto roda, e a tela precisa do
 * motivo para dizer ao operador que as mensagens não vão chegar.
 */
import { graphVersion } from "@/lib/graph-version";

export type AssinaturaDoWebhook = { ok: true } | { ok: false; motivo: string };

export async function assinarWebhookDaConta(input: {
  wabaId: string;
  token: string;
  callbackUrl: string;
  verifyToken: string | null;
}): Promise<AssinaturaDoWebhook> {
  if (!input.verifyToken) {
    return {
      ok: false,
      motivo:
        "o token de verificação do webhook não está configurado nesta instalação (Admin › API Oficial (Meta))",
    };
  }
  try {
    const res = await fetch(`https://graph.facebook.com/${graphVersion()}/${input.wabaId}/subscribed_apps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.token}` },
      body: new URLSearchParams({
        override_callback_uri: input.callbackUrl,
        verify_token: input.verifyToken,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      error?: { message?: string; error_data?: { details?: string } };
    };
    if (!res.ok || body.error) {
      return {
        ok: false,
        motivo: body.error?.error_data?.details ?? body.error?.message ?? `http_${res.status}`,
      };
    }
    return { ok: true };
  } catch (err) {
    // `DOMException` do timeout nem sempre é `instanceof Error`; a mensagem é o que importa.
    const msg = (err as { message?: unknown } | null)?.message;
    return { ok: false, motivo: `rede indisponível: ${typeof msg === "string" ? msg : "erro"}` };
  }
}
