"use client";
import {
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

/**
 * UMA FAIXA DE FERRAMENTAS QUE SÓ APARECE QUANDO SE PEDE — sem depender de mouse.
 *
 * Usada pelo cabeçalho da conversa (Transferir, Lembrar, Fechar…) e pela faixa
 * de assistência do composer. As duas estavam sempre à vista e comiam a altura
 * da conversa; esconder atrás de `:hover` resolveria no notebook e sumiria com
 * as ações no celular e para quem usa teclado — a lição que o botão "Responder"
 * da bolha já pagou (ver o comentário em `MessageBubble`).
 *
 * Por isso há QUATRO portas, e nenhuma é obrigatória:
 *
 *   - **mouse** passando pela zona (só `pointerType === "mouse"`: no toque o
 *     `pointerenter` dispara junto com o toque e abriria sem pedir);
 *   - **foco** no alternador ou dentro da faixa (Tab chega nela);
 *   - **o alternador**, botão explícito com `aria-expanded` — é a porta do toque
 *     e do teclado, e é a que FIXA a faixa;
 *   - **uso**: quem apertou algo dentro da faixa (abriu o "Lembrar", o seletor de
 *     aparência, o "Transferir"…) a mantém aberta enquanto o que abriu estiver
 *     aberto. Sem isso, o menu que abre em portal levaria o foco para fora, a
 *     faixa sumiria por baixo dele, e o foco não teria para onde voltar quando
 *     o menu fechasse. O uso termina quando o mouse sai e o foco já não está
 *     num portal aberto a partir dela.
 *
 * Escape fecha (WCAG 1.4.13: conteúdo que aparece por hover/foco precisa poder
 * ser dispensado sem mover o ponteiro). Só o Escape apertado NA zona: menus em
 * portal também borbulham pelo React, e o Escape deles é deles.
 *
 * `forcado` mantém aberta por um motivo do chamador (ex.: nota interna ativa,
 * sugestão para revisar); `chave` zera o "em uso" quando muda (ex.: id da
 * conversa) — fixar pelo alternador sobrevive à troca, usar não.
 */
export function useRevelacao({ forcado = false, chave }: { forcado?: boolean; chave?: string } = {}) {
  const [hover, setHover] = useState(false);
  const [foco, setFoco] = useState(false);
  const [fixado, setFixado] = useState(false);
  const [emUso, setEmUso] = useState(false);
  const [dispensado, setDispensado] = useState(false);
  const [chaveVista, setChaveVista] = useState(chave);
  if (chave !== chaveVista) {
    setChaveVista(chave);
    setEmUso(false);
  }

  const painelId = useId();
  const alternadorRef = useRef<HTMLButtonElement>(null);
  const painelRef = useRef<HTMLDivElement>(null);

  const visivel = forcado || fixado || emUso || ((hover || foco) && !dispensado);
  /** Fixa no fluxo da página (empurra o conteúdo) em vez de flutuar por cima dele. */
  const noFluxo = forcado || fixado;

  const naZona = (alvo: EventTarget | null) =>
    alvo instanceof Node &&
    (!!painelRef.current?.contains(alvo) || !!alternadorRef.current?.contains(alvo));

  const fechar = () => {
    setFixado(false);
    setEmUso(false);
    setDispensado(true);
  };

  return {
    visivel,
    noFluxo,
    zonaProps: {
      onPointerEnter: (e: PointerEvent) => {
        if (e.pointerType === "mouse") setHover(true);
      },
      onPointerLeave: (e: PointerEvent) => {
        if (e.pointerType !== "mouse") return;
        setHover(false);
        setDispensado(false);
        // O "em uso" acaba quando o mouse sai E nada aberto a partir da faixa
        // segura o foco lá fora (menu, diálogo em portal). Com o foco de volta
        // na faixa, quem a mantém é o foco; com ele no corpo, ela some.
        const ativo = document.activeElement;
        if (!ativo || ativo === document.body || naZona(ativo)) setEmUso(false);
      },
      onFocus: (e: FocusEvent) => {
        if (naZona(e.target)) setFoco(true);
      },
      onBlur: (e: FocusEvent) => {
        if (naZona(e.relatedTarget)) return;
        setFoco(false);
        setDispensado(false);
      },
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key !== "Escape" || !visivel || forcado || !naZona(e.target)) return;
        const focoNaFaixa = !!painelRef.current?.contains(document.activeElement);
        fechar();
        if (focoNaFaixa) alternadorRef.current?.focus();
      },
    },
    /** O clique do botão explícito: abre e FIXA, ou fecha. Passado à mão (`onClick=`). */
    alternar: () => {
      if (visivel) fechar();
      else {
        setFixado(true);
        setDispensado(false);
      }
    },
    alternadorProps: {
      ref: alternadorRef,
      "aria-expanded": visivel,
      "aria-controls": painelId,
    },
    painelProps: {
      ref: painelRef,
      id: painelId,
      "data-visivel": visivel ? "true" : "false",
      onPointerDownCapture: () => setEmUso(true),
      onKeyDownCapture: (e: KeyboardEvent) => {
        if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) setEmUso(true);
      },
    },
  };
}

/**
 * As classes de visibilidade da faixa. `invisible` (visibility: hidden) e não só
 * opacidade: botão transparente continua clicável e, no toque, seria apertado
 * sem ser visto. A transição de `visibility` segura o "sumir" por 150ms, o
 * bastante para o foco de um menu que fecha voltar ao botão que o abriu.
 */
export function classeDaFaixa(visivel: boolean): string {
  return visivel
    ? "visible opacity-100 transition-[opacity,visibility] duration-150 motion-reduce:transition-none"
    : "invisible opacity-0 transition-[opacity,visibility] duration-150 motion-reduce:transition-none";
}
