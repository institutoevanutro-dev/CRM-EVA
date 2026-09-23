import { describe, expect, it } from "vitest";

import { idiomaDaTranscricao } from "./idioma-da-transcricao";

describe("idiomaDaTranscricao", () => {
  it("pt-BR vira o código de duas letras que o Whisper espera", () => {
    expect(idiomaDaTranscricao("pt-BR")).toBe("pt");
  });
  it("espanhol continua espanhol", () => {
    expect(idiomaDaTranscricao("es")).toBe("es");
  });
  it("organização sem idioma cai no padrão do produto", () => {
    expect(idiomaDaTranscricao(null)).toBe("pt");
    expect(idiomaDaTranscricao("")).toBe("pt");
    expect(idiomaDaTranscricao("klingon")).toBe("pt");
  });
});
