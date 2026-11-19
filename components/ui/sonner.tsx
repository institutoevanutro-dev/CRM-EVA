"use client";

import type { CSSProperties, ComponentProps } from "react";
import { Toaster as Sonner } from "sonner";

import { useTheme } from "@/lib/theme";

type ToasterProps = ComponentProps<typeof Sonner>;

/** Fundo opaco do aviso colorido: o `*-bg` dos tokens é translúcido. */
const tinta = (cor: string) => `color-mix(in srgb, var(--color-${cor}) 14%, var(--color-surface))`;

/**
 * As variáveis que o Sonner lê, apontadas para os tokens: o aviso segue o tema
 * (claro/escuro) e a cor da marca, sem o verde/vermelho fixo do `richColors`.
 * Vai como `style` no `<ol data-sonner-toaster>`: estilo inline vence a folha
 * do Sonner, que não está em camada e por isso venceria classes do Tailwind.
 */
const CORES = {
  "--normal-bg": "var(--color-surface)",
  "--normal-border": "var(--color-border)",
  "--normal-text": "var(--color-text)",
  "--success-bg": tinta("success"),
  "--success-border": "var(--color-success)",
  "--success-text": "var(--color-text)",
  "--info-bg": tinta("info"),
  "--info-border": "var(--color-info)",
  "--info-text": "var(--color-text)",
  "--warning-bg": tinta("warning"),
  "--warning-border": "var(--color-warning)",
  "--warning-text": "var(--color-text)",
  "--error-bg": tinta("error"),
  "--error-border": "var(--color-error)",
  "--error-text": "var(--color-text)",
} as CSSProperties;

/** Precisa estar dentro do `<ThemeProvider>` (app/layout.tsx). */
export function Toaster(props: ToasterProps) {
  const { resolvedTheme } = useTheme();
  return <Sonner theme={resolvedTheme} richColors style={CORES} {...props} />;
}
