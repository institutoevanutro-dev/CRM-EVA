import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";

import { FRASES_DE_FALHA, fraseDaFalhaDeCanal } from "./frases-de-falha";

describe("FRASES_DE_FALHA", () => {
  // A bolha da conversa mostra estas frases por `t(FRASES_DE_FALHA[codigo])`, e a
  // cerca de i18n não enxerga tabela importada de outro módulo: sem esta conta,
  // uma frase nova sem espanhol aparecia em português para quem escolheu espanhol.
  it("toda frase tem espanhol no dicionário", () => {
    const semEspanhol = Object.values(FRASES_DE_FALHA).filter((frase) => !DICIONARIO[frase]?.es);
    expect(semEspanhol).toEqual([]);
  });

  it("código herdado do Object não vira frase", () => {
    expect(fraseDaFalhaDeCanal("constructor")).toBeNull();
    expect(fraseDaFalhaDeCanal("send_timeout")).toMatch(/^O WhatsApp não confirmou o envio a tempo/);
  });
});
