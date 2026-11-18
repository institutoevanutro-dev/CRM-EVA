"use client";
import { useCallback, useMemo, useState } from "react";

/**
 * O estado da seleção múltipla na lista de conversas (porte do upstream #2909).
 *
 * `alternarTodos` SOMA as visíveis às já marcadas: quem marcou três linhas à
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

  /**
   * O "selecionar todas" é um interruptor (item 32 da auditoria de 17/11): com
   * todas as visíveis já marcadas, o segundo clique as desmarca — e só elas.
   */
  const alternarTodos = useCallback((ids: string[]) => {
    setSelecionados((prev) => {
      if (ids.length > 0 && ids.every((id) => prev.has(id))) {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      }
      return new Set([...prev, ...ids]);
    });
  }, []);

  const limpar = useCallback(() => setSelecionados(new Set()), []);

  return useMemo(
    () => ({ selecionados, quantidade: selecionados.size, alternar, alternarTodos, limpar }),
    [selecionados, alternar, alternarTodos, limpar],
  );
}
