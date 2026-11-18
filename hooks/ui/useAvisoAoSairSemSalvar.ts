"use client";
/**
 * Pergunta antes de sair de uma tela com alterações não salvas.
 *
 * Duas portas: fechar ou recarregar a aba (o navegador mostra o aviso dele, o
 * único que existe nesse momento) e clicar num link interno do app (o menu,
 * "Cadastrar credencial"…), que no App Router troca de tela sem descarregar a
 * página — e por isso o `beforeunload` sozinho não pega.
 *
 * ponytail: o "voltar" do navegador não é interceptado. O App Router trata o
 * `popstate` antes de qualquer ouvinte da tela e não deixa cancelar; cobrir
 * esse caso pediria empurrar entradas falsas no histórico.
 */
import { useEffect } from "react";

export function useAvisoAoSairSemSalvar(ativo: boolean, pergunta: string): void {
  useEffect(() => {
    if (!ativo) return;

    function aoDescarregar(e: BeforeUnloadEvent) {
      e.preventDefault();
      // Navegadores antigos (Safari incluído) só perguntam com `returnValue`.
      e.returnValue = true;
    }

    function aoClicar(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // nova aba: nada se perde
      const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement)) return;
      if ((link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      const destino = new URL(link.href, window.location.href);
      // Para fora do app o `beforeunload` já pergunta; perguntar aqui seria duas vezes.
      if (destino.origin !== window.location.origin) return;
      if (destino.pathname === window.location.pathname && destino.search === window.location.search)
        return;
      if (!window.confirm(pergunta)) {
        // O `Link` do Next desiste quando o clique chega com `defaultPrevented`.
        e.preventDefault();
        e.stopPropagation();
      }
    }

    window.addEventListener("beforeunload", aoDescarregar);
    document.addEventListener("click", aoClicar, true);
    return () => {
      window.removeEventListener("beforeunload", aoDescarregar);
      document.removeEventListener("click", aoClicar, true);
    };
  }, [ativo, pergunta]);
}
