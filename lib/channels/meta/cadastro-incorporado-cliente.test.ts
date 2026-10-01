// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { abrirCadastroIncorporado } from "./cadastro-incorporado-cliente";
import { EVENTO_CANCELADO, EVENTO_COEXISTENCIA } from "./coexistencia";

const ENTRADA = { appId: "1", configId: "2", versao: "v22.0", esperaDoEventoMs: 50 };

/**
 * `FB` simulado (o mesmo truque do e2e: se `window.FB` existe, o script não é
 * carregado). O `postMessage` é disparado DENTRO do `login`, ou seja, depois de o
 * módulo ligar o listener: é a única ordem em que o filtro de origem é exercitado.
 * `atrasoDoEventoMs` simula a Meta mandando o evento DEPOIS do callback.
 */
function fbFalso(opts: { code?: string; evento?: string; wabaId?: string; origem?: string; atrasoDoEventoMs?: number }) {
  const w = window as unknown as { FB?: unknown };
  const disparar = () =>
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: opts.origem ?? "https://www.facebook.com",
        data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: opts.evento, data: { waba_id: opts.wabaId } }),
      }),
    );
  w.FB = {
    init: () => undefined,
    login: (cb: (r: { authResponse?: { code?: string } }) => void) => {
      if (opts.evento && !opts.atrasoDoEventoMs) disparar();
      cb({ authResponse: opts.code ? { code: opts.code } : undefined });
      if (opts.evento && opts.atrasoDoEventoMs) setTimeout(disparar, opts.atrasoDoEventoMs);
    },
  };
}

afterEach(() => {
  delete (window as unknown as { FB?: unknown }).FB;
});

describe("abrirCadastroIncorporado", () => {
  it("junta o code do login com o evento do postMessage", async () => {
    fbFalso({ code: "AQBx1234567890", evento: EVENTO_COEXISTENCIA, wabaId: "222333444555" });
    expect(await abrirCadastroIncorporado(ENTRADA)).toEqual({
      ok: true,
      resultado: { code: "AQBx1234567890", evento: EVENTO_COEXISTENCIA, wabaId: "222333444555", phoneNumberId: null },
    });
  });
  it("evento que chega DEPOIS do callback do login ainda é lido (espera até o prazo)", async () => {
    fbFalso({ code: "AQBx1234567890", evento: EVENTO_COEXISTENCIA, wabaId: "222333444555", atrasoDoEventoMs: 10 });
    expect(await abrirCadastroIncorporado(ENTRADA)).toMatchObject({ ok: true, resultado: { wabaId: "222333444555" } });
  });
  it("CANCEL da Meta é cancelado", async () => {
    fbFalso({ evento: EVENTO_CANCELADO });
    expect(await abrirCadastroIncorporado(ENTRADA)).toEqual({ ok: false, motivo: "cancelado" });
  });
  it("sem code e sem evento é cancelado (o usuário fechou a janela)", async () => {
    fbFalso({});
    expect(await abrirCadastroIncorporado(ENTRADA)).toEqual({ ok: false, motivo: "cancelado" });
  });
  it("evento de término sem code é sem_code (não é cancelamento: a Meta terminou e o login não devolveu o code)", async () => {
    fbFalso({ evento: EVENTO_COEXISTENCIA, wabaId: "222333444555" });
    expect(await abrirCadastroIncorporado(ENTRADA)).toEqual({ ok: false, motivo: "sem_code" });
  });
  it("mensagem de outra origem é ignorada: com code e sem evento válido no prazo, sem_evento", async () => {
    fbFalso({ code: "AQBx1234567890", evento: EVENTO_COEXISTENCIA, wabaId: "x", origem: "https://evil.example" });
    expect(await abrirCadastroIncorporado(ENTRADA)).toEqual({ ok: false, motivo: "sem_evento" });
  });
  it('origem "null" (iframe opaco) não lança: é ignorada', async () => {
    fbFalso({ code: "AQBx1234567890", evento: EVENTO_COEXISTENCIA, wabaId: "x", origem: "null" });
    await expect(abrirCadastroIncorporado(ENTRADA)).resolves.toEqual({ ok: false, motivo: "sem_evento" });
  });
  it("sem SDK (script não carregou) é sdk_indisponivel", async () => {
    // sem window.FB; o script é anexado e `onerror` dispara no jsdom sem rede
    const p = abrirCadastroIncorporado(ENTRADA);
    const script = document.querySelector('script[src*="connect.facebook.net"]') as HTMLScriptElement | null;
    script?.onerror?.(new Event("error"));
    expect(await p).toEqual({ ok: false, motivo: "sdk_indisponivel" });
  });
});
