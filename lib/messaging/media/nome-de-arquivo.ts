/**
 * Nome original de um anexo recebido, pronto para ser gravado e exibido.
 *
 * O nome vem de fora (do aparelho de quem mandou), então passa por aqui antes de
 * virar `metadata.media_filename` e antes de virar rótulo no Inbox: caracteres
 * de controle e de formatação de direção de texto saem, as pontas são aparadas e
 * o tamanho tem teto. Guarda por VALOR: não-string, vazio ou só-invisível → null.
 *
 * Portado do projeto original (DeskcommCRM, PR #2619).
 */
const INVISIVEIS = /[\u0000-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g;

/** Teto em caracteres (code points), o limite usual de nome de arquivo. */
export const NOME_DE_ARQUIVO_MAX = 255;

export function nomeDeArquivoLimpo(bruto: unknown): string | null {
  if (typeof bruto !== "string") return null;
  const nome = Array.from(bruto.replace(INVISIVEIS, "").trim())
    .slice(0, NOME_DE_ARQUIVO_MAX)
    .join("")
    .trim();
  return nome ? nome : null;
}

/**
 * O nome que um anexo ENVIADO leva para o WhatsApp.
 *
 * O caminho no bucket é `out-<uuid>.<ext>`: nasce aleatório de propósito, para
 * dois arquivos de mesmo nome não se sobrescreverem. Usar o basename dele como
 * `filename` do documento fazia o paciente receber `out-3f9a2b.pdf` no lugar do
 * nome que a pessoa escolheu.
 *
 * O nome original vence sempre que existir; o basename fica só como último
 * recurso de quem chama a API sem nome (upload por token, que só manda o
 * `media_storage_path`).
 *
 * Portado do projeto original (DeskcommCRM, PR #4484 de @webtecnica).
 */
export function nomeDoAnexoParaEnviar(
  original: unknown,
  storagePath: string,
): string | undefined {
  return nomeDeArquivoLimpo(original) ?? (storagePath.split("/").pop() || undefined);
}
