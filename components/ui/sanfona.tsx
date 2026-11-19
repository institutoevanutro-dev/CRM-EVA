import type { ReactNode } from "react";

import { CaretDown } from "@/lib/ui/icons";

/**
 * Bloco de configuração recolhido (regra do André: cartões em sanfona).
 * `<details>` nativo: abre sem JS, funciona no Safari e o conteúdo continua
 * montado, então um formulário aberto e fechado não perde o que foi digitado.
 */
export function Sanfona({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <details className="group max-w-3xl rounded-md border border-border">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        {titulo}
        <CaretDown size={16} aria-hidden className="shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-2 px-2 pb-2">{children}</div>
    </details>
  );
}
