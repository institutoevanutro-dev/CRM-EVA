// Mesma lógica do Eva Financeiro (lib/auth/evalink-*.ts). Mudou lá, muda aqui.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export type OpcoesToken = { sub?: string; email?: string; nome?: string; papel?: unknown; nonce?: string;
  clientId?: string; alg?: "ES256" | "HS256"; emissor?: string; status?: number };

/** Imita a Conta EvaLink: JWKS, troca de código e /authorize que aprova na hora. Tudo fictício. */
export async function sobeContaFalsa(porta = 0) {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const clientId = "cliente-ficticio", clientSecret = "segredo-ficticio";
  let opc: OpcoesToken = {};
  const ultimos = { nonce: "", verificadorOk: true };
  let url = "";

  const assina = async (claims: Record<string, unknown>, aud: string) => {
    if (opc.alg === "HS256")
      return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuer(opc.emissor ?? `${url}/auth/v1`)
        .setAudience(aud).setIssuedAt().setExpirationTime("5m").sign(new TextEncoder().encode("x".repeat(32)));
    return new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(opc.emissor ?? `${url}/auth/v1`)
      .setAudience(aud).setIssuedAt().setExpirationTime("5m").sign(privateKey);
  };

  const servidor = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", url);
    if (u.pathname === "/auth/v1/.well-known/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] })); return;
    }
    if (u.pathname === "/auth/v1/oauth/authorize") {
      ultimos.nonce = u.searchParams.get("nonce") ?? "";
      const volta = new URL(u.searchParams.get("redirect_uri")!);
      volta.searchParams.set("code", "codigo-ficticio"); volta.searchParams.set("state", u.searchParams.get("state")!);
      res.writeHead(302, { location: volta.toString() }).end(); return;
    }
    if (u.pathname === "/auth/v1/oauth/token" && req.method === "POST") {
      let corpo = ""; for await (const c of req) corpo += c;
      const f = new URLSearchParams(corpo);
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      if (req.headers.authorization !== `Basic ${basic}` || f.get("grant_type") !== "authorization_code" || !f.get("code_verifier")) {
        res.writeHead(401).end(); return;
      }
      if (opc.status) { res.writeHead(opc.status).end(); return; }
      const sub = opc.sub ?? "11111111-1111-4111-8111-111111111111";
      const id_token = await assina({ sub, email: opc.email ?? "pessoa@eva.test", name: opc.nome ?? "Pessoa Fictícia",
        nonce: opc.nonce ?? ultimos.nonce }, opc.clientId ?? clientId);
      const access_token = await assina({ sub, client_id: opc.clientId ?? clientId,
        evalink_papel: "papel" in opc ? opc.papel : "agent", evalink_modulo: "crm" }, "authenticated");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id_token, access_token, token_type: "bearer" }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => servidor.listen(porta, "127.0.0.1", ok));
  url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  return {
    url, clientId, clientSecret, ultimos,
    tokens: (o: OpcoesToken) => { opc = o; },
    fecha: () => new Promise<void>((ok) => servidor.close(() => ok())),
  };
}
