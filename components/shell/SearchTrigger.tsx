"use client";
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { MagnifyingGlass } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { cn } from "@/lib/utils";

/**
 * "Buscar tela" do menu lateral (como no PrecificaEva e no Financeiro). `atalho={false}`
 * na gaveta do celular: a lateral do desktop continua montada atrás dela, e dois ⌘K
 * abririam duas buscas.
 */
export function SearchTrigger({ recolhida = false, atalho = true }: { naLateral?: boolean; recolhida?: boolean; atalho?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  // `enableOnFormTags`: o atalho precisa funcionar com o cursor dentro do
  // composer do inbox, que é onde o operador passa o dia.
  useHotkeys("mod+k", () => setOpen(true), { preventDefault: true, enableOnFormTags: true, enabled: atalho });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={recolhida ? t("Buscar tela") : undefined}
        aria-label={recolhida ? t("Buscar tela") : undefined}
        className={cn(
          "flex h-10 w-full items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 text-sm text-sidebar-muted transition-colors hover:bg-sidebar-active hover:text-sidebar-fg",
          recolhida && "justify-center px-0",
        )}
      >
        <MagnifyingGlass size={16} aria-hidden />
        {!recolhida && <span className="flex-1 text-left">{t("Buscar tela")}</span>}
        {!recolhida && <kbd className="rounded-md border border-white/15 px-1.5 py-0.5 text-[10px]">⌘K</kbd>}
      </button>
      {/* Só monta aberta: a busca carrega dados e não precisa existir antes do primeiro uso. */}
      {open && <CommandPalette open={open} onOpenChange={setOpen} />}
    </>
  );
}
