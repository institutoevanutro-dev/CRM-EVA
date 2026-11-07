"use client";
import { AlertsBell } from "./AlertsBell";
import { MobileSidebar } from "./MobileSidebar";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserMenu } from "./UserMenu";

export function TopBar() {
  return (
    // z-30, acima de todo `z-20` das telas: com a mesma camada, o que vem DEPOIS
    // no DOM pinta por cima — a linha dos dias da Agenda passava sobre esta barra
    // ao rolar a página (print de 08/10/2026). Gruda ABAIXO das faixas de aviso
    // (`--faixas-de-cima`, porte do original #3190), não por baixo delas.
    // A altura vem do AppShell (`--altura-do-topo`: 56px no celular, 48px de md
    // em diante); 3.5rem é o piso para quem montar a barra fora da casca.
    <header className="sticky top-[var(--faixas-de-cima,0px)] z-30 flex h-(--altura-do-topo,3.5rem) items-center justify-between gap-2 border-b bg-background/95 px-3 backdrop-blur md:gap-4 md:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <MobileSidebar />
        <TenantSwitcher />
      </div>
      {/* Avisos | preferências (idioma, tema), separados por um fio: são
          perguntas diferentes — "o que aconteceu?" e "como quero ver?". */}
      <div className="flex shrink-0 items-center gap-1">
        <AlertsBell />
        <span aria-hidden className="mx-1 h-5 w-px bg-border" />
        <UserMenu />
      </div>
    </header>
  );
}
