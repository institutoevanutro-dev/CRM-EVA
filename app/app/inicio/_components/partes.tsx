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
  tituloComo: Titulo = "h3",
}: {
  titulo: string;
  icone?: LucideIcon;
  children: ReactNode;
  verTodos?: string;
  rotuloVerTodos?: string;
  className?: string;
  /** `h4` quando o cartão mora dentro de um bloco que já tem título `h3`. */
  tituloComo?: "h3" | "h4";
}) {
  const t = useT();
  return (
    <section className={`flex min-w-0 flex-col rounded-2xl border bg-surface p-5 shadow-sm ${className}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <Titulo className="flex min-w-0 items-start gap-2 titulo-cartao text-text">
          {Icone ? <Icone aria-hidden className="mt-[3px] size-4 shrink-0 text-text-muted" /> : null}
          <span className="min-w-0 break-words">{titulo}</span>
        </Titulo>
        {verTodos ? (
          // No celular e no toque o link ganha 44 × 44 px de alvo; a margem
          // negativa devolve a altura, para o título não ser empurrado.
          <Link
            className={`inline-flex shrink-0 items-center justify-end rounded-md text-sm text-accent underline-offset-4 hover:underline max-lg:-my-3 max-lg:min-h-11 max-lg:min-w-11 toque:-my-3 toque:min-h-11 toque:min-w-11 ${FOCO}`}
            href={verTodos}
          >
            {rotuloVerTodos ?? t("Ver todos")}
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** "há 3 h" desde um instante: há quanto tempo alguém espera. */
export function haQuanto(iso: string, t: (s: string) => string): string {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (min < 60) return t("há {{n}} min").replace("{{n}}", String(min));
  const h = Math.round(min / 60);
  if (h < 48) return t("há {{n}} h").replace("{{n}}", String(h));
  return t("há {{n}} dias").replace("{{n}}", String(Math.round(h / 24)));
}

/** Barra fina de proporção (0 a 100). Enfeite: o número ao lado é quem informa. */
export function Barra({ pct, className = "" }: { pct: number; className?: string }) {
  return (
    <span aria-hidden className={`block h-2 overflow-hidden rounded-full bg-border ${className}`}>
      <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </span>
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

