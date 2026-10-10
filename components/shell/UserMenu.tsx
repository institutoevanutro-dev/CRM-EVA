"use client";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { SeletorDeIdioma } from "@/components/shell/SeletorDeIdioma";

/** Idioma e tema. A pessoa logada e o "Sair" moram no menu lateral desde 10/10/2026. */
export function UserMenu() {
  return (
    <div className="flex items-center gap-2">
      <SeletorDeIdioma />
      <ThemeToggle />
    </div>
  );
}
