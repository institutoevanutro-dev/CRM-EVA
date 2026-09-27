// Mesma lógica do Eva Financeiro (lib/auth/evalink-*.ts). Mudou lá, muda aqui.
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { ConfigEvalink } from "@/lib/evalink/config";

export const PAPEIS = ["viewer", "agent", "manager", "admin"] as const;
export type PapelEvalink = (typeof PAPEIS)[number];

const b64 = (b: Buffer) => b.toString("base64url");
const jwksPorConta = new Map<string, JWTVerifyGetKey>();
const jwksDe = (c: ConfigEvalink) => {
  let j = jwksPorConta.get(c.emissor);
  if (!j) jwksPorConta.set(c.emissor, (j = createRemoteJWKSet(new URL(`${c.emissor}/.well-known/jwks.json`))));
  return j;
};

export function inicioDoLogin(c: ConfigEvalink) {
  const state = b64(randomBytes(16)), nonce = b64(randomBytes(16)), verificador = b64(randomBytes(32));
  const desafio = b64(createHash("sha256").update(verificador).digest());
  const u = new URL(`${c.emissor}/oauth/authorize`);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: c.clientId, redirect_uri: c.voltaUrl,
    code_challenge: desafio, code_challenge_method: "S256", scope: "openid email profile", state, nonce }))
    u.searchParams.set(k, v);
  return { url: u.toString(), cookie: `${state}.${nonce}.${verificador}` };
}

/** Protocolo dos módulos, passos 2 e 3. Qualquer falha devolve null (a tela mostra uma mensagem só). */
export async function conferirVolta(c: ConfigEvalink,
  d: { code: string | null; state: string | null; cookie: string | undefined }, jwks: JWTVerifyGetKey = jwksDe(c)) {
  const partes = d.cookie?.split(".");
  if (!partes || partes.length !== 3 || !d.state || partes[0] !== d.state || !d.code) return null;
  const [, nonce, verificador] = partes as [string, string, string];
  try {
    const r = await fetch(`${c.emissor}/oauth/token`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/x-www-form-urlencoded",
        authorization: "Basic " + Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64") },
      body: new URLSearchParams({ grant_type: "authorization_code", code: d.code, redirect_uri: c.voltaUrl, code_verifier: verificador }),
    });
    if (!r.ok) return null;
    const t = (await r.json()) as { id_token?: unknown; access_token?: unknown };
    if (typeof t.id_token !== "string" || typeof t.access_token !== "string") return null;
    const id = await jwtVerify(t.id_token, jwks, { issuer: c.emissor, audience: c.clientId, algorithms: ["ES256"] });
    const ac = await jwtVerify(t.access_token, jwks, { issuer: c.emissor, algorithms: ["ES256"] });
    const papel = ac.payload.evalink_papel;
    if (id.payload.nonce !== nonce || ac.payload.client_id !== c.clientId || ac.payload.sub !== id.payload.sub ||
      ac.payload.evalink_modulo == null || typeof papel !== "string" || !(PAPEIS as readonly string[]).includes(papel)) return null;
    const email = id.payload.email, sub = id.payload.sub;
    if (typeof email !== "string" || !email || typeof sub !== "string") return null;
    // A Conta hoje manda o próprio e-mail como `name`: isso não é nome, e o banco cai para a parte antes do @.
    const bruto = typeof id.payload.name === "string" ? id.payload.name.trim() : "";
    const nome = bruto.toLowerCase() === email.trim().toLowerCase() ? "" : bruto;
    return { sub, email, nome, papel: papel as PapelEvalink };
  } catch {
    return null;
  }
}
