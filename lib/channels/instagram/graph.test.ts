/**
 * `INSTAGRAM_GRAPH_BASE_URL` existe para o e2e apontar a Graph do Instagram
 * para um receptor LOCAL. Em produção um `.env` de teste copiado para a VPS
 * mandaria `Authorization: Bearer <token da conta do cliente>` para o host que
 * a variável apontar — então em produção ela só vale para loopback (o receptor
 * do e2e, que roda sob `next start`, isto é, `NODE_ENV=production`); qualquer
 * outro host é ignorado e a base volta a ser a da Meta.
 *
 * O env entra por parâmetro (como `metaPodeReceber` em `lib/channels/meta/
 * webhook.ts`): `NodeJS.ProcessEnv` exige `NODE_ENV` e obrigaria stub global.
 */
import { describe, expect, it } from "vitest";

import { BASE_DO_INSTAGRAM, baseDoInstagram } from "./graph";

const EXTERNO = "https://atacante.example";

describe("baseDoInstagram", () => {
  it("vazia: base da Meta, em qualquer ambiente", () => {
    expect(baseDoInstagram({ NODE_ENV: "production", INSTAGRAM_GRAPH_BASE_URL: "" })).toBe(BASE_DO_INSTAGRAM);
    expect(baseDoInstagram({ NODE_ENV: "development" })).toBe(BASE_DO_INSTAGRAM);
  });

  it("em produção, host que não é loopback é IGNORADO: o token nunca sai para ele", () => {
    expect(baseDoInstagram({ NODE_ENV: "production", INSTAGRAM_GRAPH_BASE_URL: EXTERNO })).toBe(BASE_DO_INSTAGRAM);
    expect(baseDoInstagram({ NODE_ENV: "production", INSTAGRAM_GRAPH_BASE_URL: "http://10.0.0.7:47811" })).toBe(
      BASE_DO_INSTAGRAM,
    );
    expect(baseDoInstagram({ NODE_ENV: "production", INSTAGRAM_GRAPH_BASE_URL: "isso não é url" })).toBe(
      BASE_DO_INSTAGRAM,
    );
  });

  it("em produção, loopback segue valendo (é o receptor do e2e sob `next start`)", () => {
    expect(baseDoInstagram({ NODE_ENV: "production", INSTAGRAM_GRAPH_BASE_URL: "http://127.0.0.1:47811/" })).toBe(
      "http://127.0.0.1:47811",
    );
    expect(baseDoInstagram({ NODE_ENV: "production", INSTAGRAM_GRAPH_BASE_URL: "http://localhost:47811" })).toBe(
      "http://localhost:47811",
    );
  });

  it("fora de produção, qualquer host vale (dev e test apontam para onde quiserem)", () => {
    expect(baseDoInstagram({ NODE_ENV: "development", INSTAGRAM_GRAPH_BASE_URL: EXTERNO })).toBe(EXTERNO);
    expect(baseDoInstagram({ NODE_ENV: "test", INSTAGRAM_GRAPH_BASE_URL: EXTERNO })).toBe(EXTERNO);
  });
});
