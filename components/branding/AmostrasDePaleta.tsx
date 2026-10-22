"use client";

import { useT } from "@/hooks/i18n/useT";
import { PALETAS, paletaDaCor } from "@/lib/branding/paletas";
import { ehHexValido } from "@/lib/branding/rampa";

/**
 * As 6 paletas do guia de marca como atalho da cor da marca. Só preenche o campo: gravar continua sendo o botão
 * da tela. A amostra marcada sai da cor do campo, nunca de estado próprio.
 */
export function AmostrasDePaleta({
  hex,
  onEscolher,
}: {
  hex: string;
  onEscolher: (hex: string) => void;
}) {
  const t = useT();
  const atual = paletaDaCor(hex);
  const livre = atual === null && ehHexValido(hex);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("Paletas prontas")}>
        {PALETAS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={atual === p.id}
            onClick={() => onEscolher(p.principal)}
            className="flex items-center gap-2 rounded-sm border border-border px-3 py-1.5 text-sm hover:bg-surface-elevated focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg focus-visible:outline-hidden aria-pressed:border-accent aria-pressed:font-medium"
          >
            <span
              aria-hidden
              className="h-4 w-4 shrink-0 rounded-full border border-border"
              style={{ backgroundColor: p.principal }}
            />
            {t(p.nome)}
          </button>
        ))}
      </div>
      {livre ? <p className="text-xs text-text-muted">{t("Cor livre")}</p> : null}
    </div>
  );
}
