"use client";
import { useMemo, useSyncExternalStore } from "react";

/**
 * Última aba aberta em cada área do menu (spec 2026-10-07-cores-e-menu): `AbasDaArea`
 * grava, o menu lateral lê para a área reabrir onde a pessoa estava.
 *
 * `useSyncExternalStore` e não `useState` + `useEffect`: o servidor não tem
 * localStorage, e ler no efeito é o padrão que `react-hooks/set-state-in-effect`
 * recusa (ver lib/theme.tsx, mesma classe de defeito).
 */
const CHAVE = "menu-ultima-aba";
const EVENTO = "menu-ultima-aba";

function ler(): string {
  try {
    return window.localStorage.getItem(CHAVE) ?? "{}";
  } catch {
    return "{}"; // sem localStorage (modo privado): a área abre na primeira aba
  }
}

function inscrever(aviso: () => void): () => void {
  window.addEventListener(EVENTO, aviso);
  window.addEventListener("storage", aviso);
  return () => {
    window.removeEventListener(EVENTO, aviso);
    window.removeEventListener("storage", aviso);
  };
}

export function useUltimaAba(): Record<string, string> {
  const bruto = useSyncExternalStore(inscrever, ler, () => "{}");
  return useMemo(() => {
    try {
      return JSON.parse(bruto) as Record<string, string>;
    } catch {
      return {};
    }
  }, [bruto]);
}

export function gravarUltimaAba(area: string, href: string): void {
  try {
    const atual = JSON.parse(ler()) as Record<string, string>;
    if (atual[area] === href) return;
    window.localStorage.setItem(CHAVE, JSON.stringify({ ...atual, [area]: href }));
    window.dispatchEvent(new Event(EVENTO));
  } catch {
    // sem localStorage: nada a guardar
  }
}
