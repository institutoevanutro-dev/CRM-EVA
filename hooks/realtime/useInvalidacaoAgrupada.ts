"use client";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

/**
 * Invalida as chaves UMA vez por rajada de eventos do Realtime.
 *
 * Uma mensagem que chega mexe em várias linhas (a mensagem, a conversa, o
 * carimbo de atividade do lead), e cada linha é um evento. Invalidar em cada
 * um relia a lista inteira várias vezes por mensagem — numa tela com a IA
 * conversando, a lista vivia recarregando. Aqui o primeiro evento agenda, os
 * seguintes dentro de `esperaMs` só esticam a espera, e `tetoMs` garante que
 * uma rajada contínua não adie a atualização para sempre.
 */
export function useInvalidacaoAgrupada(esperaMs = 400, tetoMs = 2_000) {
  const qc = useQueryClient();
  const pendentes = useRef(new Map<string, QueryKey>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const primeiro = useRef(0);

  const disparar = useCallback(() => {
    timer.current = null;
    primeiro.current = 0;
    const chaves = [...pendentes.current.values()];
    pendentes.current.clear();
    for (const queryKey of chaves) void qc.invalidateQueries({ queryKey });
  }, [qc]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return useCallback(
    (...chaves: QueryKey[]) => {
      for (const k of chaves) pendentes.current.set(JSON.stringify(k), k);
      const agora = Date.now();
      if (!primeiro.current) primeiro.current = agora;
      if (timer.current) clearTimeout(timer.current);
      const resta = Math.max(0, primeiro.current + tetoMs - agora);
      timer.current = setTimeout(disparar, Math.min(esperaMs, resta));
    },
    [disparar, esperaMs, tetoMs],
  );
}
