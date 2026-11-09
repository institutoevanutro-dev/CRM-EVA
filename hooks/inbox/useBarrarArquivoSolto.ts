"use client";
import { useEffect } from "react";

/** O arraste traz ARQUIVO? `types` lista o que vem, nunca o conteúdo; texto e link seguem com o navegador (porte do original #3713). */
export function trazArquivo(dt: DataTransfer | null | undefined): boolean {
  return Array.from(dt?.types ?? []).includes("Files");
}

/**
 * Arquivo solto FORA da caixa (no fio, no cabeçalho, no fundo escuro da prévia
 * aberta) não troca o atendimento pelo arquivo na aba. Só quando ninguém tratou
 * antes: o React despacha abaixo da `window`, então o `preventDefault` da caixa já
 * aparece aqui e ela segue dona do drop dela. Zona de soltar nova nesta tela:
 * chame `preventDefault` nela, senão esta guarda cancela o padrão dela.
 *
 * Mora num hook porque a conversa FECHADA não tem caixa de texto (I3: a barra
 * "Reabrir e responder" toma o lugar dela) — e sem a caixa montada, um PDF
 * solto no fio abria na aba no lugar do CRM.
 */
export function useBarrarArquivoSolto(): void {
  useEffect(() => {
    const barrar = (e: globalThis.DragEvent) => {
      if (e.defaultPrevented || !trazArquivo(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", barrar);
    window.addEventListener("drop", barrar);
    return () => {
      window.removeEventListener("dragover", barrar);
      window.removeEventListener("drop", barrar);
    };
  }, []);
}
