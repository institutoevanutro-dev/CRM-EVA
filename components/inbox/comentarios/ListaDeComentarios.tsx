"use client";
import { useState } from "react";
import { format } from "date-fns";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PaperPlaneTilt, PencilSimple, Plus, Trash, Warning } from "@/lib/ui/icons";

/**
 * Vocabulário FECHADO de `instagram_comments.situacao` — CHECK no banco
 * (migration 0279 + `respondido_manualmente` da 0281). Par vigiado por
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts` — um valor novo
 * aqui sem o CHECK acompanhar (ou vice-versa) reprova lá, não em silêncio.
 */
export type SituacaoDoComentario =
  | "novo"
  | "respondido_pela_regra"
  | "respondido_pela_ia"
  | "esperando_voce"
  | "ignorado"
  | "respondido_manualmente";

/** O que a tela precisa de uma linha de `instagram_comments` — nada de nome de provider aqui. */
export interface ComentarioDaFila {
  id: string;
  texto: string | null;
  media_id: string;
  autor_handle: string | null;
  comentado_em: string;
  situacao: SituacaoDoComentario;
  sugestao_de_resposta: string | null;
  motivo_do_toque: string | null;
}

interface Props {
  comentarios: ComentarioDaFila[];
  /** Ausente = a tela ainda não sabe publicar (ex.: papel insuficiente) — os botões continuam visíveis; a doutrina do repo é a RLS/rota barrarem de verdade, isto é só o gatilho. */
  onPublicar?: (id: string, texto: string) => void;
  /** Id do comentário cuja publicação está em voo — desabilita só o botão dele. */
  publicando?: string | null;
  /** IMPORTANTE 5: descarta um `esperando_voce` (situacao='ignorado') — sem isto a fila só cresce. */
  onDescartar?: (id: string) => void;
  /** Id do comentário sendo descartado agora — desabilita só o botão dele. */
  descartando?: string | null;
  /**
   * CRÍTICO 2: abre o formulário de regra JÁ com este `media_id` — sem isto
   * não há de onde tirar o id do post dentro do CRM, e "Mídia (id do post)"
   * como texto livre é uma feature que ninguém consegue usar de verdade.
   */
  onNovaRegraParaMidia?: (mediaId: string) => void;
}

/** `esperando_voce` primeiro — é o que precisa de um toque humano agora. Estável no resto. */
function ordenar(comentarios: ComentarioDaFila[]): ComentarioDaFila[] {
  return comentarios
    .map((c, indice) => ({ c, indice }))
    .sort((a, b) => {
      const rank = (s: SituacaoDoComentario) => (s === "esperando_voce" ? 0 : 1);
      const diff = rank(a.c.situacao) - rank(b.c.situacao);
      return diff !== 0 ? diff : a.indice - b.indice;
    })
    .map(({ c }) => c);
}

function ItemEsperando({
  comentario,
  onPublicar,
  publicando,
  onDescartar,
  descartando,
}: {
  comentario: ComentarioDaFila;
  onPublicar?: (id: string, texto: string) => void;
  publicando?: boolean;
  onDescartar?: (id: string) => void;
  descartando?: boolean;
}) {
  const t = useT();
  const [editando, setEditando] = useState(false);
  const [rascunho, setRascunho] = useState(
    comentario.sugestao_de_resposta ?? "",
  );

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border bg-surface-elevated p-2">
      {editando ? (
        <Textarea
          value={rascunho}
          onChange={(e) => setRascunho(e.target.value)}
          rows={3}
          className="text-sm"
          aria-label={t("Editar a resposta")}
        />
      ) : (
        <p className="text-sm text-text">
          {rascunho || <span className="italic text-text-muted">{t("Sem sugestão pronta — escreva a resposta.")}</span>}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setEditando((v) => !v)}
        >
          <PencilSimple size={14} />
          {t("Editar")}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!rascunho.trim() || Boolean(publicando)}
          onClick={() => onPublicar?.(comentario.id, rascunho.trim())}
        >
          <PaperPlaneTilt size={14} />
          {publicando ? t("Publicando…") : t("Publicar")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={Boolean(descartando)}
          onClick={() => onDescartar?.(comentario.id)}
        >
          <Trash size={14} />
          {descartando ? t("Descartando…") : t("Descartar")}
        </Button>
      </div>
    </div>
  );
}

export function ListaDeComentarios({
  comentarios,
  onPublicar,
  publicando,
  onDescartar,
  descartando,
  onNovaRegraParaMidia,
}: Props) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const ordenados = ordenar(comentarios);

  if (ordenados.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-sm text-text-muted">
        {t("Nenhum comentário nesta fila.")}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2 p-3">
      {ordenados.map((c) => (
        <li key={c.id} className="rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-2 text-xs text-text-muted">
            <span className="font-medium text-text">{c.autor_handle ?? t("Perfil não identificado")}</span>
            <time dateTime={c.comentado_em}>
              {format(new Date(c.comentado_em), "dd/MM HH:mm", { locale: localeDaData })}
            </time>
          </div>
          <p className="mt-1 text-sm text-text">{c.texto}</p>
          {/* CRÍTICO 2: sem mostrar o vídeo, não há de onde tirar o `media_id`
              que o formulário de regra pede como texto livre. */}
          <div className="mt-1 flex items-center justify-between gap-2 text-xs text-text-muted">
            <span>{t("Vídeo:")} {c.media_id}</span>
            {onNovaRegraParaMidia && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-auto px-1.5 py-0.5 text-xs"
                onClick={() => onNovaRegraParaMidia(c.media_id)}
              >
                <Plus size={12} />
                {t("Nova regra para este vídeo")}
              </Button>
            )}
          </div>
          {c.situacao === "esperando_voce" && c.motivo_do_toque && (
            <p className="mt-1 flex items-center gap-1 text-xs text-warning-fg">
              <Warning size={12} weight="fill" />
              {t("Motivo:")} {c.motivo_do_toque}
            </p>
          )}
          {c.situacao === "esperando_voce" && (
            <ItemEsperando
              comentario={c}
              onPublicar={onPublicar}
              publicando={publicando === c.id}
              onDescartar={onDescartar}
              descartando={descartando === c.id}
            />
          )}
        </li>
      ))}
    </ul>
  );
}
