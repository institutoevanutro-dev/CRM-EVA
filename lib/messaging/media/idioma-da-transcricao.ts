/**
 * O IDIOMA QUE VAI COM O ÁUDIO.
 *
 * Sem ele o Whisper adivinha, e em áudio curto adivinha mal: medido em produção
 * (Instituto Eva, 2026-09-22), "testando 123 testando" voltou como
 * "3102 reis 3101". A API quer ISO-639-1 (duas letras); o produto guarda
 * `pt-BR`/`es` em `organizations.locale`.
 */
import { normalizarIdioma } from "@/lib/i18n/idiomas";

export function idiomaDaTranscricao(locale: string | null | undefined): string {
  return normalizarIdioma(locale).split("-")[0]!;
}
