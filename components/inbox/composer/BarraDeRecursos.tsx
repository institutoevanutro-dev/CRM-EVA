"use client";
import { useT } from "@/hooks/i18n/useT";
import type { MessageTemplate } from "@/hooks/inbox/useMessageTemplates";

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
 */
interface Props {
  respostas: readonly MessageTemplate[];
  onEscolher: (resposta: MessageTemplate) => void;
  disabled?: boolean;
}

export function BarraDeRecursos({ respostas, onEscolher, disabled = false }: Props) {
  const t = useT();
  if (respostas.length === 0) return null;
  return (
    <div
      data-testid="barra-de-recursos"
      role="toolbar"
      aria-label={t("Respostas rápidas")}
      className="mb-1.5 flex flex-wrap gap-1"
    >
      {respostas.map((resposta) => (
        <button
          key={resposta.id}
          type="button"
          disabled={disabled}
          data-recurso-id={resposta.id}
          onClick={() => onEscolher(resposta)}
          title={t("Prepara no compositor: você revisa e envia")}
          className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
        >
          {resposta.title}
        </button>
      ))}
    </div>
  );
}
