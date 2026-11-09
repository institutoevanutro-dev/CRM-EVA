"use client";
import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FileText } from "@/lib/ui/icons";
import type { MessageTemplate } from "@/hooks/inbox/useMessageTemplates";
import { filtrarRespostas } from "@/components/inbox/composer/TemplateMenu";

/**
 * A barra de respostas rápidas do Inbox (#2833): um botão por TÍTULO cadastrado,
 * em vez de obrigar o operador a decorar o atalho do `/`.
 *
 * O clique NÃO envia nada: entrega a resposta ao MESMO `applyTemplate` do `/`.
 * Texto cai no campo editável; resposta com imagens da Biblioteca de mídia
 * (migration 0383) abre a prévia com o texto como legenda. O componente é burro
 * de propósito: não conhece envio.
 *
 * Portado e adaptado do projeto original (DeskcommCRM, PR #2847 de
 * @webtecnica): lá a resposta também podia ser de ÁUDIO, com arquivo próprio
 * por resposta; aqui a mídia vem da Biblioteca, que só guarda imagem e vídeo.
 *
 * Nasce FECHADA: com dezenas de respostas cadastradas, a barra aberta ocupava o
 * Inbox inteiro (relato da clínica, 22/10). Aberta, tem busca e altura limitada
 * com rolagem; escolher uma resposta fecha de novo. Desde a I4 abre por cima da
 * conversa, a partir do gatilho na primeira linha do compositor.
 *
 * Só entram as respostas marcadas "Mostrar na barra do Inbox" (migration 0398,
 * porte do original #3311): a AUSÊNCIA da marcação conta como ligada, e o `/`
 * continua listando TODAS — esconder daqui não tira a resposta do atalho.
 */
export function respostasDaBarra(respostas: readonly MessageTemplate[]): MessageTemplate[] {
  return respostas.filter((r) => r.mostrar_na_barra !== false);
}

interface Props {
  respostas: readonly MessageTemplate[];
  onEscolher: (resposta: MessageTemplate) => void;
  disabled?: boolean;
}

export function BarraDeRecursos({ respostas: todas, onEscolher, disabled = false }: Props) {
  const t = useT();
  const [aberta, setAberta] = useState(false);
  const [busca, setBusca] = useState("");
  const respostas = respostasDaBarra(todas);
  if (respostas.length === 0) return null;
  const visiveis = filtrarRespostas(respostas, busca);
  // I4: o gatilho mora na primeira linha do compositor, à direita, e a lista abre
  // POR CIMA da conversa (Popover), em vez de empurrar o campo para baixo. A
  // contagem fica no nome acessível e na dica; no texto visível ela disputava
  // largura com "Sugerir resposta" numa linha de 28 px.
  const nome = `${t("Respostas rápidas")} (${respostas.length})`;
  return (
    <Popover
      open={aberta}
      onOpenChange={(v) => {
        setAberta(v);
        if (!v) setBusca("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={nome}
          title={nome}
          className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:h-7 lg:min-h-0 lg:min-w-0"
        >
          <FileText size={14} aria-hidden className="shrink-0 @[26rem]:hidden" />
          <span className="hidden truncate @[26rem]:inline">{t("Respostas rápidas")}</span>
          <span aria-hidden className="shrink-0">{aberta ? "▴" : "▾"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-1.5 p-2">
        <input
          type="search"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder={t("Buscar resposta")}
          aria-label={t("Buscar resposta")}
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
        />
        <div
          id="barra-de-recursos"
          data-testid="barra-de-recursos"
          role="toolbar"
          aria-label={t("Respostas rápidas")}
          className="flex max-h-48 flex-wrap gap-1 overflow-y-auto"
        >
          {visiveis.map((resposta) => (
            <button
              key={resposta.id}
              type="button"
              disabled={disabled}
              data-recurso-id={resposta.id}
              onClick={() => {
                onEscolher(resposta);
                setAberta(false);
                setBusca("");
              }}
              title={t("Prepara no compositor: você revisa e envia")}
              className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
            >
              {resposta.title}
            </button>
          ))}
          {visiveis.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("Nenhuma resposta com esse nome.")}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
