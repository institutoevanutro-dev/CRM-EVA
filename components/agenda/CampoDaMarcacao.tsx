import type { ComponentProps } from "react";

import { CaretDown } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * Os campos CRUS do modal da Agenda (marcar e bloquear) na receita única de campo
 * do `Input` (D1.8): borda de campo, anel de foco, 16 px no toque (o Safari do
 * iPhone não amplia) e `aria-invalid` pintando a borda de erro.
 *
 * Cada aba tinha a própria cópia, com borda mais clara que a do resto do produto,
 * sem anel de foco e um `border-danger` que não gera CSS nenhum — o e-mail
 * inválido do convidado nunca ficou vermelho. Os campos continuam nativos
 * (`select`, `input type="time"`) de propósito: no celular é o seletor do
 * sistema que abre, e as specs leem as opções.
 */
export const CAMPO =
  "h-10 toque:h-11 w-full rounded-md border border-border-input bg-surface px-3 text-base md:text-sm text-text placeholder:text-text-subtle outline-hidden transition-[border-color,box-shadow] duration-fast ease-out focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-500/30 disabled:cursor-not-allowed disabled:opacity-55 aria-[invalid=true]:border-error aria-[invalid=true]:focus-visible:ring-error-bg";

export const ROTULO = "mb-1.5 block text-xs font-medium text-text-muted";

/** Título de grupo do modal ("Quem e o quê", "Paciente", "Quando"): menor e mais calado que o rótulo. */
export const TITULO_DO_GRUPO = "text-[11px] font-semibold uppercase tracking-wide text-text-subtle";

/** `select` nativo com a seta do sistema de design no lugar da do navegador. */
export function Seletor({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <span className="relative block">
      <select className={cn(CAMPO, "appearance-none pr-9", className)} {...props}>
        {children}
      </select>
      <CaretDown
        size={14}
        weight="bold"
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-subtle"
      />
    </span>
  );
}
