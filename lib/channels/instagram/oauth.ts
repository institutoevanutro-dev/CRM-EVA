/**
 * Login do Instagram (Business Login for Instagram): a ida ao consentimento, a
 * troca do `code` pelo token de 60 dias e as duas leituras da conta.
 *
 * O `state` NÃO mora aqui: as rotas usam o mesmo assinador da volta do Google
 * (`lib/agenda/google/estado.ts`, HMAC de `INTERNAL_SECRET`) e o mesmo cookie de
 * vínculo — um segredo da instalação, e não o App Secret da Meta, que o admin
 * troca pela tela a qualquer momento (e invalidaria todo link em voo).
 *
 * Nenhum erro lançado aqui carrega token ou URL com token: a troca curta→longa
 * EXIGE `access_token` na query (documentação oficial da Meta, conferida em
 * 2026-09-25), então essa URL nunca é logada.
 */
import { env } from "@/lib/env";
import { graphVersion } from "@/lib/graph-version";
import { BASE_DO_INSTAGRAM } from "./graph";

const ESCOPOS =
  "instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments";

export const CAMINHO_DO_CALLBACK_DO_INSTAGRAM = "/api/v1/channels/instagram/callback";

/** Absoluto e idêntico nos dois lados do fluxo (a Meta compara byte a byte). */
export function enderecoDeRetornoDoInstagram(urlDaAplicacao: string = env.NEXT_PUBLIC_APP_URL): string {
  return `${(urlDaAplicacao ?? "").trim().replace(/\/+$/, "")}${CAMINHO_DO_CALLBACK_DO_INSTAGRAM}`;
}

export function urlDeLogin(appId: string, redirectUri: string, state: string): string {
  const u = new URL("https://www.instagram.com/oauth/authorize");
  u.searchParams.set("client_id", appId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", ESCOPOS);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  return u.toString();
}

export async function trocarCodePorTokenLongo(
  app: { appId: string; appSecret: string },
  code: string,
  redirectUri: string,
): Promise<{ token: string; expiraEm: Date; userId: string }> {
  const form = new URLSearchParams({
    client_id: app.appId,
    client_secret: app.appSecret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });
  const curto = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form });
  if (!curto.ok) throw new Error(`instagram_code_recusado_${curto.status}`);
  // A documentação mostra a resposta embrulhada em `data[]`; a API real devolve
  // plana. Aceitar as duas custa uma linha.
  type Curta = { access_token?: string; user_id?: string | number };
  const bruto = (await curto.json()) as Curta & { data?: Curta[] };
  const c = bruto.data?.[0] ?? bruto;
  if (!c.access_token || c.user_id == null) throw new Error("instagram_code_resposta_incompleta");

  const url = new URL(`${BASE_DO_INSTAGRAM}/access_token`);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", app.appSecret);
  url.searchParams.set("access_token", c.access_token);
  const longo = await fetch(url.toString());
  if (!longo.ok) throw new Error(`instagram_token_longo_recusado_${longo.status}`);
  const l = (await longo.json()) as { access_token?: string; expires_in?: number };
  if (!l.access_token || !l.expires_in) throw new Error("instagram_token_longo_resposta_incompleta");
  return { token: l.access_token, expiraEm: new Date(Date.now() + l.expires_in * 1000), userId: String(c.user_id) };
}

export async function lerConta(token: string): Promise<{ igAccountId: string; username: string }> {
  const r = await fetch(`${BASE_DO_INSTAGRAM}/${graphVersion()}/me?fields=user_id,username`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`instagram_conta_ilegivel_${r.status}`);
  const j = (await r.json()) as { user_id?: string | number; username?: string };
  if (j.user_id == null || !j.username) throw new Error("instagram_conta_incompleta");
  return { igAccountId: String(j.user_id), username: j.username };
}

export async function assinarWebhookDaConta(token: string): Promise<void> {
  const r = await fetch(`${BASE_DO_INSTAGRAM}/${graphVersion()}/me/subscribed_apps?subscribed_fields=messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`instagram_assinatura_recusada_${r.status}`);
}
