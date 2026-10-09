import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * O topo de toda tela: título, uma frase e as ações à direita.
 *
 * Existe porque cada tela escrevia o seu à mão, e as cinco do dia a dia tinham
 * cinco jeitos (botão em linha própria, controles quebrando em duas fileiras,
 * cartão de integração ACIMA do título). Um só componente faz a equipe achar
 * o botão principal sempre no mesmo lugar.
 */
export function CabecalhoDaPagina({
  titulo,
  descricao,
  acoes,
  className,
}: {
  titulo: ReactNode;
  descricao?: ReactNode;
  acoes?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="min-w-0">
        <h1 className="text-[2rem] leading-tight">{titulo}</h1>
        {descricao ? <p className="mt-1 max-w-2xl text-sm text-text-muted">{descricao}</p> : null}
      </div>
      {acoes ? <div className="flex shrink-0 flex-wrap items-center gap-2">{acoes}</div> : null}
    </header>
  );
}
