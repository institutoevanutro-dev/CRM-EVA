import { describe, expect, it } from "vitest";

import {
  LADO_MAXIMO_DO_ICONE,
  LADO_MINIMO_DO_ICONE,
  medidasDoPng,
  recusaDoIcone,
  TAMANHO_MAXIMO_DO_ICONE,
} from "@/lib/branding/icone-arquivo";

/**
 * O ÍCONE DA ABA (migration 0291): tipo e medidas saem dos BYTES.
 * Um PNG mínimo aqui é só assinatura + IHDR — é tudo que a regra lê.
 */
function png(largura: number, altura: number, total = 64): Uint8Array {
  const b = new Uint8Array(total);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8); // tamanho 13 + "IHDR"
  const v = new DataView(b.buffer);
  v.setUint32(16, largura);
  v.setUint32(20, altura);
  return b;
}

describe("medidasDoPng", () => {
  it("lê largura e altura do IHDR", () => {
    expect(medidasDoPng(png(512, 512))).toEqual({ largura: 512, altura: 512 });
    expect(medidasDoPng(png(300, 120))).toEqual({ largura: 300, altura: 120 });
  });
  it("não é PNG: null (JPG, texto, vazio)", () => {
    expect(medidasDoPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(0)]))).toBeNull();
    expect(medidasDoPng(new TextEncoder().encode("não sou imagem nenhuma, só texto"))).toBeNull();
    expect(medidasDoPng(new Uint8Array())).toBeNull();
  });
  it("PNG sem IHDR logo depois da assinatura: null", () => {
    const b = png(64, 64);
    b[12] = 0x58; // "XHDR"
    expect(medidasDoPng(b)).toBeNull();
  });
});

describe("recusaDoIcone", () => {
  it("PNG quadrado dentro da faixa entra", () => {
    expect(recusaDoIcone(png(512, 512))).toBeNull();
    expect(recusaDoIcone(png(LADO_MINIMO_DO_ICONE, LADO_MINIMO_DO_ICONE))).toBeNull();
    expect(recusaDoIcone(png(LADO_MAXIMO_DO_ICONE, LADO_MAXIMO_DO_ICONE))).toBeNull();
  });
  it("retângulo é recusado dizendo as medidas", () => {
    const r = recusaDoIcone(png(400, 300));
    expect(r?.codigo).toBe("icone_nao_quadrado");
    expect(r?.mensagem).toContain("400×300");
  });
  it("pequeno ou grande demais é recusado", () => {
    expect(recusaDoIcone(png(32, 32))?.codigo).toBe("icone_tamanho_fora");
    expect(recusaDoIcone(png(2048, 2048))?.codigo).toBe("icone_tamanho_fora");
  });
  it("JPG é recusado como tipo, SVG com a frase própria", () => {
    expect(recusaDoIcone(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(0)]))?.codigo).toBe(
      "unsupported_media_type",
    );
    expect(recusaDoIcone(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))?.codigo).toBe(
      "icone_svg_recusado",
    );
  });
  it("arquivo acima do teto é recusado antes de qualquer leitura", () => {
    expect(recusaDoIcone(png(512, 512, TAMANHO_MAXIMO_DO_ICONE + 1))?.codigo).toBe("payload_too_large");
  });
});
