"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import {
  FRENTE_DO_MENU,
  FRENTE_SECUNDARIA_DO_MENU,
  fundoDoMenu,
  menuDaCorDaMarca,
  menuFoiEscurecido,
} from "@/lib/branding/menu";
import { ehHexValido, normalizarHex } from "@/lib/branding/rampa";

/** O menu de fábrica do `app/globals.css`, por tema. */
const MENU_PADRAO = {
  claro: { fundo: "#1d352c" },
  escuro: { fundo: "#0b1612" },
} as const;

const COR_NEUTRA_DO_SELETOR = "#808080";

/** A prévia do `@utility fundo-lateral`, que é liso desde a D1.4. */
function Previa({ rotulo, fundo }: { rotulo: string; fundo: string }) {
  return (
    <div
      data-previa-do-menu={rotulo}
      data-fundo={fundo}
      className="flex h-24 w-32 flex-col justify-between rounded-md p-2 text-xs"
      style={{ backgroundColor: fundo }}
    >
      <span style={{ color: FRENTE_DO_MENU }} className="font-medium">
        {rotulo}
      </span>
      <span style={{ color: FRENTE_SECUNDARIA_DO_MENU }}>Aa</span>
    </div>
  );
}

/**
 * O campo "Cor do menu lateral". Só preenche o valor: gravar continua sendo o
 * botão Salvar da tela. Em branco, o menu fica com o padrão do sistema.
 */
export function CampoDaCorDoMenu({
  valor,
  onMudar,
  corDaMarca,
}: {
  valor: string;
  onMudar: (hex: string) => void;
  /** A cor da marca em vigor (desta organização ou herdada), ou `null`. */
  corDaMarca: string | null;
}) {
  const t = useT();
  const limpo = valor.trim();
  const valido = limpo.length > 0 && ehHexValido(limpo);
  const invalido = limpo.length > 0 && !valido;

  const claro = valido
    ? { fundo: fundoDoMenu(limpo, "claro") }
    : MENU_PADRAO.claro;
  const escuro = valido
    ? { fundo: fundoDoMenu(limpo, "escuro") }
    : MENU_PADRAO.escuro;

  return (
    <div className="space-y-2">
      <Label htmlFor="org_menu_hex">{t("Cor do menu lateral")}</Label>
      <div className="flex flex-wrap items-center gap-3">
        <label
          className="relative h-10 w-10 shrink-0 cursor-pointer overflow-hidden rounded-sm border border-border"
          style={{ backgroundColor: valido ? normalizarHex(limpo) : COR_NEUTRA_DO_SELETOR }}
        >
          <span className="sr-only">{t("Escolher a cor do menu visualmente")}</span>
          <input
            type="color"
            value={valido ? normalizarHex(limpo) : COR_NEUTRA_DO_SELETOR}
            onChange={(e) => onMudar(e.target.value)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </label>
        <Input
          id="org_menu_hex"
          value={valor}
          onChange={(e) => onMudar(e.target.value)}
          placeholder="#1d352c"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalido}
          aria-describedby="ajuda-da-cor-do-menu"
          className="w-36 font-mono"
        />
        <Button
          type="button"
          variant="outline"
          disabled={corDaMarca === null || !ehHexValido(corDaMarca)}
          onClick={() => corDaMarca && onMudar(menuDaCorDaMarca(corDaMarca))}
        >
          {t("Usar a cor da marca")}
        </Button>
        {invalido ? (
          <span className="text-sm text-error-fg">{t("Use um código de cor como #7a5cd6.")}</span>
        ) : null}
      </div>
      <p id="ajuda-da-cor-do-menu" className="text-xs text-text-muted">
        {t("Deixe em branco para manter o menu padrão.")}
      </p>
      {valido && menuFoiEscurecido(limpo) ? (
        <p className="text-xs text-warning-fg">
          {t("Escurecemos um pouco para o texto do menu continuar legível.")}
        </p>
      ) : null}
      <div className="flex gap-3">
        <Previa rotulo={t("Modo claro")} fundo={claro.fundo} />
        <Previa rotulo={t("Modo escuro")} fundo={escuro.fundo} />
      </div>
    </div>
  );
}
