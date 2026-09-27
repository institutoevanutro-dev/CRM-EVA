/**
 * O número informado pertence à conta (WABA) informada? Com o MESMO token.
 *
 * Sem esta conferência, um WABA errado passava na validação (que só olha o
 * número), a sessão era gravada, e o CRM assinava o webhook da conta ERRADA na
 * Meta: o número certo seguia sem receber nada.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MOTIVO_NUMERO_FORA_DA_CONTA, conferirNumeroDaConta } from "@/lib/channels/meta/validate-credentials";
import { graphVersion } from "@/lib/graph-version";
import { traduzir } from "@/lib/i18n/dicionario";

const ENTRADA = { wabaId: "2434045433735175", phoneNumberId: "1103328999528818", token: "EAAG-token-de-teste" };

afterEach(() => vi.unstubAllGlobals());

function respostaCom(ids: string[]) {
  return vi.fn(async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 }));
}

describe("conferirNumeroDaConta", () => {
  it("lista os números da WABA com o token no header e aceita quando o número está lá", async () => {
    const fetchMock = respostaCom(["999", ENTRADA.phoneNumberId]);
    vi.stubGlobal("fetch", fetchMock);

    expect(await conferirNumeroDaConta(ENTRADA)).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.startsWith(`https://graph.facebook.com/${graphVersion()}/${ENTRADA.wabaId}/phone_numbers?`)).toBe(true);
    expect(url).not.toContain(ENTRADA.token);
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${ENTRADA.token}`);
  });

  it("número de outra conta: recusa com motivo claro", async () => {
    vi.stubGlobal("fetch", respostaCom(["999"]));
    expect(await conferirNumeroDaConta(ENTRADA)).toEqual({ ok: false, motivo: MOTIVO_NUMERO_FORA_DA_CONTA });
  });

  it("o motivo fixo tem tradução (a rota o passa por t())", () => {
    expect(traduzir(MOTIVO_NUMERO_FORA_DA_CONTA, "es")).not.toBe(MOTIVO_NUMERO_FORA_DA_CONTA);
  });

  it("erro da Meta (WABA inexistente, sem permissão) vira ok:false com a mensagem dela", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "Unsupported get request" } }), { status: 400 })),
    );
    expect(await conferirNumeroDaConta(ENTRADA)).toEqual({ ok: false, motivo: "Unsupported get request" });
  });

  it("rede caída não lança", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const r = await conferirNumeroDaConta(ENTRADA);
    expect(r.ok).toBe(false);
  });
});
