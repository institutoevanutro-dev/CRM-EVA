"use client";
import { useCallback, useMemo, useState } from "react";

/**
 * O estado da seleção múltipla na lista de conversas (porte do upstream #2909).
 *
 * `selecionarTodos` SOMA as visíveis às já marcadas: quem marcou três linhas à
 * mão e depois clicou em "selecionar todas" não perde as três.
 */
export function useSelecaoEmLote() {
  const [selecionados, setSelecionados] = useState<Set<string>>(() => new Set());

  const alternar = useCallback((id: string) => {
    setSelecionados((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selecionarTodos = useCallback((ids: string[]) => {
    setSelecionados((prev) => new Set([...prev, ...ids]));
  }, []);

  const limpar = useCallback(() => setSelecionados(new Set()), []);

  return useMemo(
    () => ({ selecionados, quantidade: selecionados.size, alternar, selecionarTodos, limpar }),
    [selecionados, alternar, selecionarTodos, limpar],
  );
}
