/**
 * O BOTÃO PRINCIPAL do cabeçalho da conversa (I3 do pacote de design 2).
 *
 * Um só, ao lado do nome, sempre à vista — nunca atrás do mouse nem do ⋯. Ele
 * responde "o que esta conversa pede de mim agora?", e a ordem abaixo é a
 * resposta:
 *
 *   1. **encerrada** → "Reabrir". Vem antes de "sem dono" de propósito: conversa
 *      fechada costuma estar sem dono, e oferecer "Assumir" ali reabriria por um
 *      caminho que o rótulo não anuncia.
 *   2. **minha** → nenhum. Quem já atende não precisa de convite; "Liberar" e
 *      "Devolver ao automático" continuam no ⋯. Vem antes da pausa porque
 *      assumir GRAVA a pausa (0173): sem esta ordem, toda conversa minha
 *      mostraria "Devolver ao automático" como a coisa a fazer.
 *   3. **sem dono** → "Assumir" (rótulo e atalho `a` são contrato).
 *   4. **pausa em vigor** (de um colega, ou do contato) → "Devolver ao automático".
 *
 * Fora disso, nenhum: a conversa é de um colega e o automático está de pé.
 */
export type AcaoPrincipal = "reabrir" | "assumir" | "devolver" | null;

export function acaoPrincipalDaConversa(f: {
  encerrada: boolean;
  minha: boolean;
  semDono: boolean;
  podeDevolver: boolean;
}): AcaoPrincipal {
  if (f.encerrada) return "reabrir";
  if (f.minha) return null;
  if (f.semDono) return "assumir";
  if (f.podeDevolver) return "devolver";
  return null;
}
