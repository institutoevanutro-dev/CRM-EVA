"use client";
import { useSyncExternalStore } from "react";

/** Loja que nunca muda: o valor não vem de fora, vem de ONDE a leitura acontece. */
const semAssinatura = () => () => {};
const noCliente = () => true;
const noServidor = () => false;

/**
 * `true` só DEPOIS da hidratação — e `false` no servidor E no primeiro render do
 * cliente, que é justamente o da hidratação (`getServerSnapshot`).
 *
 * Existe por causa da #3736: a contagem das abas do Inbox é alimentada por
 * `useConversationCounts` (react-query). No SSR não há contagem e o HTML sai
 * sem o `<span>`; quando a resposta chegava DURANTE a hidratação, o render do
 * cliente já trazia o nó, o React comparava com um HTML que não o tinha, e a
 * carga virava React #418 (`Minified React error #418`, `isText=false`).
 *
 * Com esta marca, o primeiro render do cliente é idêntico ao do servidor por
 * CONSTRUÇÃO — e o dado aparece logo em seguida, na re-renderização que o
 * `useSyncExternalStore` provoca ao trocar o snapshot. Não é `useEffect`
 * copiando para estado (que renderiza duas vezes e ainda deixa a janela aberta):
 * é a mesma leitura que o React usa para decidir se o HTML bate.
 *
 * Portado do projeto original (DeskcommCRM, PR #3832 de @webtecnica).
 */
export function useDepoisDeMontar(): boolean {
  return useSyncExternalStore(semAssinatura, noCliente, noServidor);
}
