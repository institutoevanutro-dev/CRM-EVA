/**
 * A COR DA ETAPA — a faixa no topo da coluna do quadro (`StageColumn`).
 *
 * A forma é a do CHECK de `crm_stages.color` (`^#[0-9a-fA-F]{6}$`); `null` é
 * "sem cor". A PERTINÊNCIA à paleta não é cobrada em lugar nenhum, como nas
 * etiquetas (`lib/tags/cor-da-etiqueta.ts`): a paleta é decoração de tela, e uma
 * instalação que queira outro tom grava pela API sem precisar de deploy.
 *
 * A paleta vem primeiro na tela porque é a que a clínica já usa no quadro: cada
 * tom carrega no nome o papel que costuma ter (entrada, conversa, espera…). O
 * nome é o rótulo acessível — a cor nunca é o único portador de significado.
 */
import { z } from "zod";

export const corDaEtapaSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .nullable();

export const PALETA_DE_ETAPAS: readonly { cor: string; nome: string }[] = [
  { cor: "#378ADD", nome: "Azul (entrada)" },
  { cor: "#7F77DD", nome: "Roxo (em conversa)" },
  { cor: "#EF9F27", nome: "Âmbar (esperando)" },
  { cor: "#D4537E", nome: "Rosa" },
  { cor: "#D85A30", nome: "Laranja" },
  { cor: "#639922", nome: "Verde (ganho)" },
  { cor: "#1D9E75", nome: "Verde-água (acompanhamento)" },
  { cor: "#888780", nome: "Cinza (perdido)" },
];

/**
 * Quanto do tom da etapa entra em cada parte da coluna. O cabeçalho carrega mais
 * (é onde se lê "em que etapa estou"); o corpo, pouco — os cards ficam na
 * superfície deles e precisam continuar legíveis. Os pisos de contraste do texto
 * sobre o cabeçalho tingido, nos dois temas e para cada tom da paleta, são
 * medidos em `cor-da-etapa.test.ts`.
 */
export const TINTA_DA_ETAPA = { cabecalho: 22, coluna: 8, borda: 45 } as const;

/** Mistura `cor` com transparente: sobre o fundo opaco, vira um tom do tema. */
const tinta = (cor: string, pct: number) => `color-mix(in srgb, ${cor} ${pct}%, transparent)`;

/**
 * Os estilos da coluna colorida, ou `null` sem cor — e sem cor o quadro fica
 * EXATAMENTE como era (só as classes do tema). A faixa no alto do cabeçalho é
 * `box-shadow` e não borda: não muda a altura de nada no quadro.
 */
export function estiloDaColuna(cor: string | null | undefined) {
  if (!cor) return null;
  return {
    coluna: {
      backgroundColor: tinta(cor, TINTA_DA_ETAPA.coluna),
      borderColor: `color-mix(in srgb, ${cor} ${TINTA_DA_ETAPA.borda}%, var(--border))`,
    },
    // No cabeçalho e não na coluna: ele é opaco e preso no alto, e cobriria a
    // faixa pintada por baixo dele.
    cabecalho: {
      backgroundColor: tinta(cor, TINTA_DA_ETAPA.cabecalho),
      boxShadow: `inset 0 3px 0 ${cor}`,
    },
  };
}
