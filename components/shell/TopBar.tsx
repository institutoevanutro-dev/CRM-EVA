"use client";
import { useEffect, useRef, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import { AlertsBell } from "./AlertsBell";
import { MobileSidebar } from "./MobileSidebar";
import { SearchTrigger } from "./SearchTrigger";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserMenu } from "./UserMenu";

/**
 * A BARRA DE CIMA FICA ESCONDIDA (pedido do André, 18/11), como o menu lateral.
 *
 * A tela ganha a altura toda: a barra não ocupa lugar na linha
 * (`--altura-do-topo: 0px` no `AppShell`, que o Inbox e o funil descontam) e
 * aparece POR CIMA do conteúdo, como a lateral — por cima, e não empurrando,
 * para a página não pular a cada passada do mouse (a mesma razão escrita em
 * `Sidebar.tsx`). Por isso ela só abre quando a pessoa vai a ela:
 *
 *  - mouse: a faixa de 8 px na borda de cima (o `gatilho`), que fica dentro da
 *    margem do `<main>` e não cobre controle de página nenhum;
 *  - teclado: Tab que chega num controle dela;
 *  - toque (sem hover): a alça no alto, que abre e fecha.
 *
 * Fecha 200 ms depois de o mouse sair, ou quando o foco sai, ou num toque fora —
 * menos com um menu dela aberto (idioma, organização): o menu mora num portal,
 * fora desta árvore, e a barra sumindo levaria o menu junto.
 *
 * As faixas de aviso (WhatsApp desconectado, acesso de suporte) NÃO moram aqui:
 * estão em `FaixasDeCima`, acima da casca, sempre visíveis.
 */
export function TopBar() {
  const t = useT();
  const [aberta, setAberta] = useState(false);
  const raiz = useRef<HTMLDivElement | null>(null);
  const mouseDentro = useRef(false);
  const fechar = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const abrir = () => {
    clearTimeout(fechar.current);
    setAberta(true);
  };
  // A alça também tem `aria-expanded`; ela descreve a própria barra, não um menu.
  const menuAberto = () =>
    Boolean(raiz.current?.querySelector('[aria-expanded="true"]:not([data-testid="barra-de-cima-alca"])'));
  const fecharLogo = () => {
    clearTimeout(fechar.current);
    const tentar = () => {
      if (mouseDentro.current) return;
      if (menuAberto()) {
        fechar.current = setTimeout(tentar, 300);
        return;
      }
      setAberta(false);
    };
    fechar.current = setTimeout(tentar, 200);
  };

  // Toque fora fecha (no toque não há "mouse saiu"). O que está num portal de
  // menu ou gaveta aberta a partir da barra não conta como fora.
  useEffect(() => {
    if (!aberta) return;
    const aoTocar = (e: PointerEvent) => {
      const alvo = e.target as Element | null;
      if (!alvo || raiz.current?.contains(alvo)) return;
      if (alvo.closest("[data-radix-popper-content-wrapper], [role='dialog'], [role='menu']")) return;
      setAberta(false);
    };
    document.addEventListener("pointerdown", aoTocar);
    return () => document.removeEventListener("pointerdown", aoTocar);
  }, [aberta]);

  useEffect(() => () => clearTimeout(fechar.current), []);

  return (
    // Zero de altura na linha: o que aparece é posicionado sobre o conteúdo.
    // Gruda ABAIXO das faixas de aviso (`--faixas-de-cima`), não por baixo delas.
    // z-30, acima de todo `z-20` das telas; a lateral aberta (z-40) e as faixas
    // (z-50) passam por cima.
    <div
      ref={raiz}
      data-testid="barra-de-cima"
      data-aberta={aberta ? "" : undefined}
      className="sticky top-[var(--faixas-de-cima,0px)] z-30 h-0"
      // Ponteiro, não mouse: no toque o navegador emula um "mouse entrou" antes
      // do clique, e a alça abria e fechava no mesmo toque (medido no WebKit).
      onPointerEnter={(e) => {
        if (e.pointerType === "touch") return;
        mouseDentro.current = true;
        abrir();
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "touch") return;
        mouseDentro.current = false;
        fecharLogo();
      }}
      // Teclado abre pelo Tab; foco devolvido por código não abre (como na lateral).
      onKeyUp={(e) => {
        if (e.key === "Tab") abrir();
        if (e.key === "Escape") setAberta(false);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) fecharLogo();
      }}
    >
      <div
        data-testid="barra-de-cima-gatilho"
        aria-hidden
        className={cn("absolute inset-x-0 top-0 h-2", aberta && "hidden")}
      />
      {/* A altura vem do AppShell (`--altura-da-barra`: 56px no celular, 48px de
          md em diante); 3.5rem é o piso para quem montar a barra fora da casca.
          Fundo opaco: aberta, ela passa POR CIMA do conteúdo, e o fundo
          translúcido de antes deixava o título da tela vazar por trás. */}
      <header
        className={cn(
          "absolute inset-x-0 top-0 flex h-(--altura-da-barra,3.5rem) items-center justify-between gap-2 border-b bg-background px-3 transition-transform duration-200 motion-reduce:transition-none md:gap-4 md:px-6",
          aberta ? "translate-y-0 shadow-md" : "-translate-y-full",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <MobileSidebar />
          <TenantSwitcher />
        </div>
        {/* Avisos | preferências (idioma, tema), separados por um fio: são
            perguntas diferentes — "o que aconteceu?" e "como quero ver?". */}
        <div className="flex shrink-0 items-center gap-1">
          <SearchTrigger noTopo atalho={false} />
          <AlertsBell />
          <span aria-hidden className="mx-1 h-5 w-px bg-border" />
          <UserMenu />
        </div>
      </header>
      {/* Toque: sem hover, a alça é o jeito de abrir. Presa embaixo da barra
          quando aberta, para fechar com o mesmo dedo. */}
      <button
        type="button"
        data-testid="barra-de-cima-alca"
        aria-label={aberta ? t("Esconder a barra de cima") : t("Mostrar a barra de cima")}
        aria-expanded={aberta}
        onClick={() => setAberta((a) => !a)}
        className={cn(
          "absolute left-1/2 hidden h-6 w-16 -translate-x-1/2 items-start justify-center rounded-b-lg transition-[top] duration-200 motion-reduce:transition-none toque:flex",
          aberta ? "top-(--altura-da-barra,3.5rem)" : "top-0",
        )}
      >
        <span aria-hidden className="mt-1.5 h-1 w-10 rounded-full bg-text-muted/60" />
      </button>
    </div>
  );
}
