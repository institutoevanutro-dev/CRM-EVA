/**
 * A COR DO FUNIL (migration 0371) — o acento de cada funil na lista de Funis,
 * no seletor do título do quadro e no cabeçalho do quadro.
 *
 * A forma é a de `crm_stages.color` (o CHECK é o mesmo), e quem valida a entrada
 * é o mesmo `corDaEtapaSchema`. A paleta é a da etapa, com o nome sem o papel:
 * "Azul (entrada)" faz sentido numa coluna do quadro, não num funil inteiro. O
 * nome é o rótulo acessível — a cor nunca é o único jeito de saber qual funil é,
 * o nome dele continua escrito ao lado.
 *
 * Sem cor, o funil fica EXATAMENTE como era: `estiloDoFunil` devolve `null` e a
 * tela não aplica estilo nenhum.
 */
import type { CSSProperties } from "react";

import { PALETA_DE_ETAPAS } from "@/lib/kanban/cor-da-etapa";

export const PALETA_DE_FUNIS: readonly { cor: string; nome: string }[] = PALETA_DE_ETAPAS.map(
  ({ cor, nome }) => ({ cor, nome: nome.replace(/\s*\(.*\)$/, "") }),
);

/** Quanto do tom entra no fundo da linha: o bastante para agrupar, pouco para competir com o texto. */
export const TINTA_DO_FUNIL = 8;

/** A barra à esquerda e o fundo tingido da linha, e o ponto que vai ao lado do nome. */
export function estiloDoFunil(
  cor: string | null | undefined,
): { linha: CSSProperties; ponto: CSSProperties } | null {
  if (!cor) return null;
  return {
    // `box-shadow` e não borda: não muda a largura de nada na linha.
    linha: {
      boxShadow: `inset 3px 0 0 ${cor}`,
      backgroundColor: `color-mix(in srgb, ${cor} ${TINTA_DO_FUNIL}%, transparent)`,
    },
    ponto: { backgroundColor: cor },
  };
}
