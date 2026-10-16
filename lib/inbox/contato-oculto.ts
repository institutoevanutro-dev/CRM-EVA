/**
 * O CONTATO OCULTO DO INBOX (migration 0372) — o predicado, num lugar só.
 *
 * O médico ligou o próprio Instagram pessoal ao CRM, e as mensagens dos amigos
 * caíam no Inbox da clínica. A equipe oculta esse contato: as conversas dele
 * saem do Inbox, das contagens, da Fila, do radar e do Início, e a IA, o
 * follow-up, a automação e o nascimento do card deixam de agir sobre ele. As
 * mensagens continuam sendo gravadas.
 *
 * A marca é do CONTATO (`contacts.inbox_hidden_at`); a conversa carrega a cópia
 * (`conversations.contato_oculto`, mantida por gatilho) para o filtro caber na
 * MESMA consulta da lista e dos contadores — filtrar depois de paginar quebraria
 * o cursor e faria o badge contar o que a aba não mostra.
 *
 * Toda consulta de Inbox chama `semContatoOculto`; a aba "Ocultos" (gerente e
 * administrador) chama `soContatoOculto`. Uma régua só: a segunda régua sempre
 * diverge.
 */

/** A coluna da conversa que o Inbox filtra. */
export const COLUNA_DO_OCULTO = "contato_oculto";

// Sem restrição no genérico, de propósito: `C extends { eq(...): C }` sobre os
// construtores do supabase-js estoura o TypeScript (TS2589, instanciação
// profunda demais). O helper só encadeia um `.eq` e devolve o mesmo construtor.
type ComEq<C> = { eq: (coluna: string, valor: boolean) => C };

/** As conversas que o Inbox mostra: as de contato visível. */
export function semContatoOculto<C>(consulta: C): C {
  return (consulta as unknown as ComEq<C>).eq(COLUNA_DO_OCULTO, false);
}

/** A aba "Ocultos": só as conversas de contato oculto. */
export function soContatoOculto<C>(consulta: C): C {
  return (consulta as unknown as ComEq<C>).eq(COLUNA_DO_OCULTO, true);
}

/**
 * O contato está oculto do Inbox? Lê a forma crua dos dois transportes: o
 * supabase-js devolve o instante como texto, o `pg` como `Date`.
 */
export function contatoEstaOculto(contato: { inbox_hidden_at?: unknown } | null | undefined): boolean {
  const marca = contato?.inbox_hidden_at;
  return marca instanceof Date || (typeof marca === "string" && marca.length > 0);
}
