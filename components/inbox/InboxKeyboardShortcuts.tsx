"use client";
import { useHotkeys } from "react-hotkeys-hook";

interface Props {
  onFocusReply: () => void;
  onToggleHelp: () => void;
  enabled?: boolean;
}

/** A coluna da lista de conversas. Marcada em `InboxLayout`. */
export const ATRIBUTO_DA_LISTA = "data-coluna-da-lista";

/**
 * SEM ATALHO QUE AGE SOZINHO (item 29 da auditoria de 17/11; decisão do André
 * em 18/11: a recepção não usa a, e, j, k).
 *
 * "a" assumia a conversa (até a de um colega) e "e" abria "Fechar conversa":
 * quem saía digitando disparava os dois. Sobraram só os inofensivos:
 *
 *   - "r" com o cursor na lista leva ao campo de mensagem;
 *   - "?" fora de campo abre a lista de atalhos.
 */
export function focoNaLista(): boolean {
  const ativo = typeof document === "undefined" ? null : document.activeElement;
  return ativo instanceof Element && ativo.closest(`[${ATRIBUTO_DA_LISTA}]`) !== null;
}

export function InboxKeyboardShortcuts({ onFocusReply, onToggleHelp, enabled = true }: Props) {
  const naLista = () => enabled && focoNaLista();
  useHotkeys("r", () => onFocusReply(), { enabled: naLista, preventDefault: naLista }, [enabled, onFocusReply]);
  useHotkeys("shift+/", () => onToggleHelp(), { enabled, preventDefault: true });
  return null;
}
