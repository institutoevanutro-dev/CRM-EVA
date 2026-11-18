"use client";
import { useHotkeys } from "react-hotkeys-hook";

interface Props {
  /** Currently visible conversation ids in the list (for j/k nav). */
  visibleIds: string[];
  selectedId: string | null;
  /** Abre pela navegação do teclado: o foco fica na lista, para o próximo j/k. */
  onSelect: (id: string) => void;
  onFocusReply: () => void;
  onClaim: () => void;
  /** Pede o fechamento: quem chama abre a confirmação na tela (I6). */
  onClose: () => void;
  onToggleHelp: () => void;
  enabled?: boolean;
}

/** A coluna da lista de conversas. Marcada em `InboxLayout`. */
export const ATRIBUTO_DA_LISTA = "data-coluna-da-lista";

/**
 * ATALHO DE UMA LETRA SÓ COM O CURSOR NA LISTA (item 29 da auditoria de 17/11).
 *
 * Eles valiam com o foco em qualquer lugar fora de um campo — e ao abrir uma
 * conversa o foco não ia para o campo. Quem já saía digitando disparava: "a"
 * assumia a conversa (até a de um colega), "e" abria "Fechar conversa". Agora:
 *
 *   - a, e, r e j/k valem com o foco DENTRO da coluna da lista, onde quem
 *     navega pelo teclado está de propósito;
 *   - j/k valem também sem conversa aberta e sem foco em lugar nenhum: não há
 *     campo onde a pessoa pudesse estar escrevendo;
 *   - "?" (ajuda) vale fora de campo em qualquer lugar: só abre a lista de atalhos.
 */
export function focoNaLista(): boolean {
  const ativo = typeof document === "undefined" ? null : document.activeElement;
  return ativo instanceof Element && ativo.closest(`[${ATRIBUTO_DA_LISTA}]`) !== null;
}

export function InboxKeyboardShortcuts({
  visibleIds,
  selectedId,
  onSelect,
  onFocusReply,
  onClaim,
  onClose,
  onToggleHelp,
  enabled = true,
}: Props) {
  function step(delta: number) {
    if (visibleIds.length === 0) return;
    const idx = selectedId ? visibleIds.indexOf(selectedId) : -1;
    let next = idx + delta;
    if (idx < 0) next = delta > 0 ? 0 : visibleIds.length - 1;
    if (next < 0) next = 0;
    if (next >= visibleIds.length) next = visibleIds.length - 1;
    const id = visibleIds[next];
    if (id) onSelect(id);
  }

  const naLista = () => enabled && focoNaLista();
  const podeNavegar = () =>
    naLista() || (enabled && selectedId === null && document.activeElement === document.body);

  useHotkeys("j", () => step(1), { enabled: podeNavegar, preventDefault: podeNavegar }, [
    visibleIds,
    selectedId,
    enabled,
  ]);
  useHotkeys("k", () => step(-1), { enabled: podeNavegar, preventDefault: podeNavegar }, [
    visibleIds,
    selectedId,
    enabled,
  ]);
  useHotkeys("r", () => onFocusReply(), { enabled: naLista, preventDefault: naLista }, [enabled, onFocusReply]);
  useHotkeys("a", () => onClaim(), { enabled: naLista, preventDefault: naLista }, [enabled, onClaim]);
  useHotkeys("e", () => onClose(), { enabled: naLista, preventDefault: naLista }, [enabled, onClose]);
  useHotkeys("shift+/", () => onToggleHelp(), { enabled, preventDefault: true });

  return null;
}
