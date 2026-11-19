"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Abrir um destino DENTRO do app, sem recarregar: a casca registra o
 * `router.push` aqui. Recarregar perdia o texto digitado no inbox e refazia a
 * tela inteira. Sem casca montada (teste, fora do app), cai no `assign`.
 */
let navegar: ((href: string) => void) | null = null;

export function abrirNoApp(href: string): void {
  if (navegar) navegar(href);
  else window.location.assign(href);
}

/**
 * Registra a navegação do app e trata o clique na bandeja: o SW manda
 * `notify-open` se `WindowClient.navigate` não existir.
 */
export function useNotifyOpenFromServiceWorker(): void {
  const router = useRouter();
  useEffect(() => {
    navegar = (href) => router.push(href);
    return () => {
      navegar = null;
    };
  }, [router]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    const onMsg = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; href?: unknown } | null;
      if (data?.type !== "notify-open" || typeof data.href !== "string") return;
      if (!data.href.startsWith(window.location.origin)) return;
      abrirNoApp(data.href.slice(window.location.origin.length) || "/");
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, []);
}
