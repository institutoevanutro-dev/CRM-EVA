"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { useT } from "@/hooks/i18n/useT";

/** Peças comuns do Início: cartão, cabeçalho de seção e esqueleto de carregamento. */
export const FOCO = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function Cartao({
  titulo,
  icone: Icone,
  children,
  verTodos,
  rotuloVerTodos,
  className = "",
}: {
  titulo: string;
  icone?: LucideIcon;
  children: ReactNode;
  verTodos?: string;
  rotuloVerTodos?: string;
  className?: string;
}) {
  const t = useT();
  return (
    <section className={`flex min-w-0 flex-col rounded-2xl border bg-surface p-5 shadow-sm ${className}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="flex min-w-0 items-center gap-2 font-titulo text-lg font-semibold text-text">
          {Icone ? <Icone aria-hidden className="size-4 shrink-0 text-text-muted" /> : null}
          <span className="truncate">{titulo}</span>
        </h3>
        {verTodos ? (
          <Link className={`shrink-0 rounded-md text-sm text-accent underline-offset-4 hover:underline ${FOCO}`} href={verTodos}>
            {rotuloVerTodos ?? t("Ver todos")}
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function Esqueleto({ quantos, altura = "h-44", colunas = "md:grid-cols-2" }: { quantos: number; altura?: string; colunas?: string }) {
  const t = useT();
  return (
    <div role="status" aria-label={t("Carregando")} className={`grid gap-4 ${colunas}`}>
      {Array.from({ length: quantos }, (_, i) => (
        <div key={i} className={`${altura} animate-pulse rounded-2xl border bg-surface motion-reduce:animate-none`} />
      ))}
    </div>
  );
}

export function CabecalhoDaSecao({ id, titulo, descricao }: { id: string; titulo: string; descricao: string }) {
  return (
    <div className="mb-4">
      <h2 id={id} className="font-titulo text-2xl font-semibold text-text">
        {titulo}
      </h2>
      <p className="mt-0.5 text-sm text-text-muted">{descricao}</p>
    </div>
  );
}

