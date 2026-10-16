"use client";
/**
 * Gatilho + paleta para a etiqueta NASCER colorida (porte do upstream DeskcommCRM #2720, issue #2718).
 *
 * É o MESMO vocabulário do painel de Settings — os oito tons medidos de
 * `PALETA_DE_ETIQUETAS`, cada um com nome em `NOME_DO_TOM` (escolher por
 * "Âmbar" chega ao mesmo lugar que escolher pelo círculo, e o leitor de tela
 * anuncia o tom; seletor livre recriaria em cada instalação o problema que a
 * paleta veio consertar — #1271/#2373). A prévia usa o `ChipDeEtiqueta` com a
 * cor FORÇADA, para não ser adivinhação escolher sem ver o resultado.
 *
 * O gatilho só existe para quem a rota não vai recusar: `POST
 * /api/v1/tags/vocabulario` exige `requireRole("manager")` + MFA, e a régua da
 * própria tela de Settings é "a tela não oferece o que a escrita recusa".
 * Agentes criam a tag sem cor, exatamente como antes — sem erro e sem ruído.
 *
 * A COR DA ETAPA do funil usa este MESMO seletor (`paleta` + `rotulo`), com a
 * paleta de `lib/kanban/cor-da-etapa.ts`: um estilo de seletor só no produto. A
 * régua de papel serve igual — a rota de etapas também exige manager.
 */
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";
import { NOME_DO_TOM, PALETA_DE_ETIQUETAS } from "@/lib/tags/cor-da-etiqueta";
import { useT } from "@/hooks/i18n/useT";
import { Palette } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  /** Tom escolhido (`#rrggbb`) ou `null` = "Sem cor". */
  cor: string | null;
  onChange: (cor: string | null) => void;
  /** Nome digitado, só para a prévia do chip dentro do popover. */
  tag?: string;
  disabled?: boolean;
  /** Tons oferecidos, com nome. Padrão: a paleta das etiquetas. */
  paleta?: readonly { cor: string; nome: string }[];
  /** Título do popover e rótulo do gatilho. Padrão: "Cor da etiqueta". */
  rotulo?: string;
  /**
   * Abertura controlada por fora — o item "Cor do funil" do menu "⋯" da lista
   * de Funis abre ESTE popover, ancorado no gatilho da linha. Ausente, o
   * seletor cuida da própria abertura, como sempre.
   */
  aberto?: boolean;
  onAbertoChange?: (aberto: boolean) => void;
}

const PALETA_PADRAO = PALETA_DE_ETIQUETAS.map((cor) => ({ cor, nome: NOME_DO_TOM[cor] ?? cor }));

export function SeletorDeCorDaEtiqueta({
  cor,
  onChange,
  tag,
  disabled,
  paleta = PALETA_PADRAO,
  rotulo = "Cor da etiqueta",
  aberto: abertoDeFora,
  onAbertoChange,
}: Props) {
  const t = useT();
  const { activeOrg } = useAuth();
  const [abertoAqui, setAbertoAqui] = useState(false);
  const aberto = abertoDeFora ?? abertoAqui;
  const setAberto = (v: boolean) => {
    setAbertoAqui(v);
    onAbertoChange?.(v);
  };

  const podeDefinir =
    !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  if (!podeDefinir) return null;

  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          // `size="sm"` traz `lg:h-8`, que um `h-7` sem prefixo não vence no desktop.
          className="h-7 w-7 shrink-0 p-0 lg:h-7"
          disabled={disabled}
          title={t(rotulo)}
          aria-label={t(rotulo)}
          aria-expanded={aberto}
        >
          {cor ? (
            <span
              className="size-3 rounded-full"
              style={{ backgroundColor: cor }}
              aria-hidden
            />
          ) : (
            <Palette size={12} weight="regular" aria-hidden />
          )}
        </Button>
      </PopoverTrigger>
      {/* No celular a fileira QUEBRA em vez de vazar da tela: oito tons e o
          "Sem cor" não cabem em 375px numa linha só. */}
      <PopoverContent align="end" className="w-auto max-w-[calc(100vw-2rem)] p-3">
        <p className="mb-2 text-xs font-semibold text-text">
          {t(rotulo)}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {paleta.map(({ cor: tom, nome }) => (
            <button
              key={tom}
              type="button"
              onClick={() => {
                onChange(tom);
                setAberto(false);
              }}
              aria-pressed={mesmaCor(cor, tom)}
              // O nome do tom é o rótulo acessível; a cor é reforço — a mesma
              // redundância não-cromática do painel de Settings.
              aria-label={t(nome)}
              title={tom}
              className={cn(
                "size-7 rounded-full border-2 transition-transform",
                mesmaCor(cor, tom)
                  ? "border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                  : "border-transparent hover:scale-110",
              )}
              style={{ backgroundColor: tom }}
            />
          ))}
          <Button
            type="button"
            size="sm"
            variant={cor === null ? "default" : "outline"}
            aria-pressed={cor === null}
            onClick={() => {
              onChange(null);
              setAberto(false);
            }}
          >
            {t("Sem cor")}
          </Button>
        </div>
        {tag ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t("Prévia:")}</span>
            <ChipDeEtiqueta tag={tag} cor={cor ?? undefined} />
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** Hex não diferencia caixa: `#378add` gravado pela API é o tom `#378ADD`. */
function mesmaCor(a: string | null, b: string): boolean {
  return a !== null && a.toLowerCase() === b.toLowerCase();
}
