/**
 * A prévia da lista do Inbox para mensagem SEM corpo (porte do upstream #2850):
 * o rótulo do tipo em português, nunca `[image]`/`[audio]`, e no idioma de quem
 * lê na hora de mostrar.
 */
import { describe, expect, it } from "vitest";

import { DICIONARIO, traduzir } from "@/lib/i18n/dicionario";
import { previaDaMensagem, previaNaTela, ROTULO_DO_TIPO } from "@/lib/messaging/previa-da-mensagem";

describe("previaDaMensagem — tipos sem corpo", () => {
  it("⭐ mídia sem corpo sai com o rótulo em português, nunca o tipo do canal em inglês", () => {
    expect(previaDaMensagem(null, "image")).toBe("Imagem");
    expect(previaDaMensagem(null, "audio")).toBe("Áudio");
    for (const tipo of ["image", "audio", "video", "document", "sticker", "location", "contact", "reaction"]) {
      expect(previaDaMensagem(null, tipo), tipo).not.toContain("[");
    }
  });

  it("todo rótulo tem espanhol no dicionário", () => {
    for (const rotulo of Object.values(ROTULO_DO_TIPO)) {
      expect(DICIONARIO[rotulo]?.es, `"${rotulo}" sem espanhol`).toBeTruthy();
    }
  });

  it("texto sem corpo é vazio (a lista põe 'Sem mensagens'); tipo desconhecido fica entre colchetes", () => {
    expect(previaDaMensagem(null, "text")).toBe("");
    expect(previaDaMensagem(null, "canal_novo")).toBe("[canal_novo]");
  });

  it("corpo ganha do tipo: a legenda da mídia continua sendo a prévia", () =>
    expect(previaDaMensagem("olha essa foto", "image")).toBe("olha essa foto"));
});

describe("previaNaTela — o rótulo no idioma de quem lê", () => {
  const es = (texto: string) => traduzir(texto, "es");

  it("⭐ traduz o rótulo de tipo", () => {
    expect(previaNaTela("Imagem", es)).toBe("Imagen");
    expect(previaNaTela("Áudio", es)).toBe("Audio");
  });

  it("o que a pessoa escreveu não passa pelo dicionário, mesmo que seja uma palavra dele", () => {
    expect(previaNaTela("Imagem bonita", es)).toBe("Imagem bonita");
    expect(previaNaTela("Sem mensagens", es)).toBe("Sem mensagens");
  });
});
