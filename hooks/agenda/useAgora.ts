"use client";

import { useEffect, useState } from "react";

/**
 * O RELÓGIO DA AGENDA, que anda (achado 19 da auditoria de 16/11).
 *
 * A tela lia `new Date()` no render, e nada a redesenhava sozinho: com a aba
 * aberta a régua do agora parava, horário que já passou seguia clicável e,
 * depois da meia-noite, "Hoje" levava para ontem. Um tique por minuto basta —
 * a célula da grade é de meia hora — e voltar para a aba acerta na hora, porque
 * o navegador segura timers de aba escondida.
 */
export function useAgora(intervaloMs = 60_000): Date {
  const [agora, setAgora] = useState(() => new Date());
  useEffect(() => {
    const tique = () => setAgora(new Date());
    const timer = setInterval(tique, intervaloMs);
    const aoVoltar = () => {
      if (document.visibilityState === "visible") tique();
    };
    document.addEventListener("visibilitychange", aoVoltar);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", aoVoltar);
    };
  }, [intervaloMs]);
  return agora;
}
