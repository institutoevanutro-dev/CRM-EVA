/**
 * O que entra como ÍCONE DA ABA — decidido pelos BYTES, como o logo
 * (`logo-arquivo.ts`), e com duas regras a mais que só o ícone tem:
 *
 *  - **Só PNG.** Favicon em JPG não tem transparência e chega com fundo
 *    quadrado; quem manda um JPG recebe a recusa dizendo o formato certo.
 *  - **Quadrado, de 64 a 1024 px.** O navegador espreme o arquivo num quadrado;
 *    um retângulo vira um ícone achatado, e menos de 64 px fica borrado em tela
 *    retina (a aba pede 32 px CSS = 64 px reais). As medidas saem do cabeçalho
 *    IHDR, que o PNG É OBRIGADO a trazer logo depois da assinatura (RFC 2083
 *    §11.2.2) — 24 bytes lidos, nenhum decodificador de imagem.
 */

import { farejarTipo, pareceSvg } from "./logo-arquivo";

/** Um ícone tem ~10-60 KB; 256 KB cobre um 1024×1024 com folga. */
export const TAMANHO_MAXIMO_DO_ICONE = 256 * 1024;
export const LADO_MINIMO_DO_ICONE = 64;
export const LADO_MAXIMO_DO_ICONE = 1024;

/** Largura e altura do cabeçalho IHDR; `null` se não for PNG ou faltar o IHDR. */
export function medidasDoPng(bytes: Uint8Array): { largura: number; altura: number } | null {
  if (farejarTipo(bytes) !== "image/png" || bytes.length < 24) return null;
  // bytes 12..15 = "IHDR"
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { largura: v.getUint32(16), altura: v.getUint32(20) };
}

export type RecusaDoIcone = { readonly codigo: string; readonly mensagem: string; readonly status: number };

/** `null` = pode entrar. Senão, a recusa já no texto que a tela mostra. */
export function recusaDoIcone(bytes: Uint8Array): RecusaDoIcone | null {
  if (bytes.length > TAMANHO_MAXIMO_DO_ICONE) {
    return { codigo: "payload_too_large", mensagem: "O ícone precisa ter até 256 KB.", status: 413 };
  }
  if (pareceSvg(bytes)) {
    return {
      codigo: "icone_svg_recusado",
      mensagem: "SVG não é aceito: exporte o ícone em PNG quadrado, de preferência 512×512.",
      status: 415,
    };
  }
  const medidas = medidasDoPng(bytes);
  if (!medidas) {
    return {
      codigo: "unsupported_media_type",
      mensagem: "O ícone precisa ser PNG (JPG não tem fundo transparente).",
      status: 415,
    };
  }
  const { largura, altura } = medidas;
  if (largura !== altura) {
    return {
      codigo: "icone_nao_quadrado",
      mensagem: `O ícone precisa ser quadrado. Este tem ${largura}×${altura} px.`,
      status: 422,
    };
  }
  if (largura < LADO_MINIMO_DO_ICONE || largura > LADO_MAXIMO_DO_ICONE) {
    return {
      codigo: "icone_tamanho_fora",
      mensagem: `O ícone precisa ter entre ${LADO_MINIMO_DO_ICONE} e ${LADO_MAXIMO_DO_ICONE} px de lado. Este tem ${largura} px.`,
      status: 422,
    };
  }
  return null;
}
