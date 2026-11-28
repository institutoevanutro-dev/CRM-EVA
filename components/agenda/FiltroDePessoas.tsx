"use client";

import * as React from "react";

import { useT } from "@/hooks/i18n/useT";

import { cn } from "@/lib/utils";

import { corDaTrilha } from "./paleta";
import { nomeCurto } from "./rotulo-do-bloco";
import type { Pessoa } from "./tipos";

/**
 * A fileira de profissionais da Agenda (decisão 3 do André, 27/11/2026).
 *
 * "Todos" primeiro, depois um botão por pessoa — o ponto na cor dela e "Ana P.".
 * Clicar escolhe UMA: a grade mostra só a agenda dela; clicar de novo, ou em
 * "Todos", volta a mostrar todos. Era multisseleção com avatares (pedido de
 * 15/10); o André trocou por uma pessoa de cada vez, que é o uso da recepção.
 *
 * Quem entra na fileira é decidido por quem chama (`pessoasComAtendimento`):
 * só quem tem atendimento no período. O filtro é só VISTA sobre o que o
 * servidor já devolveu a quem olha — selecionar não busca nada novo.
 */
const BOTAO =
  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors duration-fast ease-out max-lg:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500";

export function FiltroDePessoas({
  pessoas,
  selecionadas,
  onMudar,
  focoDeReserva,
  className,
}: {
  pessoas: Pessoa[];
  /** Vazio = todos. Só a primeira conta: a escolha é de uma pessoa. */
  selecionadas: readonly string[];
  onMudar: (ids: string[]) => void;
  /** Para onde vai o foco quando a fileira some INTEIRA (a desfeita era a única). */
  focoDeReserva?: React.RefObject<HTMLElement | null>;
  className?: string;
}) {
  const t = useT();
  const todosRef = React.useRef<HTMLButtonElement>(null);
  // Quem foi DESFEITA pelo próprio botão, com o foco nele. Sem atendimento no
  // período, ela sai da fileira (na hora, ou quando o período que carrega
  // chegar), o botão focado desmonta e o foco do teclado cai no <body>. Aí ele
  // vai para "Todos", que é o que ficou marcado — ou para a reserva, se a
  // fileira sumiu junto.
  const desfeita = React.useRef<{ id: string; botao: HTMLElement } | null>(null);
  React.useLayoutEffect(() => {
    const d = desfeita.current;
    if (!d) return;
    if (pessoas.some((p) => p.id === d.id)) {
      // Ainda na fileira: a guarda só vale enquanto o foco segue no botão dela.
      if (document.activeElement !== d.botao) desfeita.current = null;
      return;
    }
    desfeita.current = null;
    // Só resgata foco PERDIDO: se ele já está noutro lugar, fica lá.
    if (document.activeElement === document.body || document.activeElement === null) {
      (todosRef.current ?? focoDeReserva?.current)?.focus();
    }
  });
  const escolhida = selecionadas[0] ?? null;
  // Ninguém com atendimento e ninguém escolhido: não há o que filtrar.
  if (pessoas.length === 0 && escolhida === null) return null;
  const todos = escolhida === null;
  const classe = (ativo: boolean) =>
    cn(
      BOTAO,
      ativo
        ? "border-transparent bg-accent font-semibold text-accent-foreground"
        : "border-border text-text-muted hover:border-border-strong hover:text-text",
    );

  return (
    <div
      data-testid="filtro-de-pessoas"
      data-selecionadas={todos ? "todos" : escolhida}
      role="group"
      aria-label={t("Profissionais na agenda")}
      className={cn("flex flex-wrap items-center gap-1.5", className)}
    >
      <button
        ref={todosRef}
        type="button"
        data-testid="botao-todos"
        aria-pressed={todos}
        onClick={() => {
          desfeita.current = null;
          onMudar([]);
        }}
        className={classe(todos)}
      >
        {t("Todos")}
      </button>
      {pessoas.map((p) => {
        const marcada = p.id === escolhida;
        return (
          <button
            key={p.id}
            type="button"
            data-testid={`botao-pessoa-${p.id}`}
            data-trilha={p.trilha}
            aria-pressed={marcada}
            // O nome acessível é o que está à vista ("Ana P.", WCAG 2.5.3); o
            // nome inteiro vai no `title`, que vira a descrição.
            title={p.nome}
            onClick={(e) => {
              desfeita.current = marcada ? { id: p.id, botao: e.currentTarget } : null;
              onMudar(marcada ? [] : [p.id]);
            }}
            className={classe(marcada)}
          >
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full ring-1 ring-surface"
              style={{ backgroundColor: corDaTrilha(p.trilha) }}
            />
            <span className="max-w-[9rem] truncate">{nomeCurto(p.nome)}</span>
          </button>
        );
      })}
    </div>
  );
}
