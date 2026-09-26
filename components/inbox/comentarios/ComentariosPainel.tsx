"use client";
import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { useAuth } from "@/hooks/auth/AuthProvider";
import {
  useComentarios,
  usePublicarComentario,
  useCriarRegraDeComentario,
  useDescartarComentario,
  useCanaisDoInstagram,
} from "@/hooks/comentarios/useComentarios";
import { ListaDeComentarios } from "./ListaDeComentarios";
import { FormularioDeRegra } from "./FormularioDeRegra";
import { Button } from "@/components/ui/button";

/**
 * A tela da Task 8: a fila de `instagram_comments` que espera um toque humano,
 * mais o formulário que cria uma regra em `instagram_comment_rules`. Quem
 * decide se o clique em Publicar/Criar regra VALE é a rota (papel `agent`/
 * `manager`, RLS por trás) — aqui é só o gatilho; ver `app/api/v1/comentarios/`.
 */
export function ComentariosPainel() {
  const t = useT();
  const { activeOrg } = useAuth();
  const { data: comentarios, isLoading } = useComentarios(activeOrg?.orgId ?? null);
  const publicar = usePublicarComentario();
  const descartar = useDescartarComentario();
  const criarRegra = useCriarRegraDeComentario();
  const { data: canais } = useCanaisDoInstagram();
  const [mostrarFormulario, setMostrarFormulario] = useState(false);
  // CRÍTICO 2: qual mídia abriu o formulário — `undefined` quando é "Nova
  // regra" solto (sem partir de um comentário da lista); string vazia é um
  // valor válido de mediaId, então null/undefined marcam "não veio de lá".
  const [mediaIdDoFormulario, setMediaIdDoFormulario] = useState<string | undefined>(undefined);

  function abrirFormulario(mediaId?: string) {
    setMediaIdDoFormulario(mediaId);
    setMostrarFormulario(true);
  }

  function fecharFormulario() {
    setMostrarFormulario(false);
    setMediaIdDoFormulario(undefined);
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold text-text">{t("Comentários")}</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => (mostrarFormulario ? fecharFormulario() : abrirFormulario())}
        >
          {mostrarFormulario ? t("Fechar") : t("Nova regra")}
        </Button>
      </div>
      {mostrarFormulario && (
        <div className="border-b border-border">
          <FormularioDeRegra
            key={mediaIdDoFormulario ?? "novo"}
            enviando={criarRegra.isPending}
            mediaIdInicial={mediaIdDoFormulario}
            canais={canais}
            onCriar={(regra) => criarRegra.mutate(regra, { onSuccess: fecharFormulario })}
          />
        </div>
      )}
      {isLoading ? (
        <p className="px-3 py-6 text-center text-sm text-text-muted">{t("Carregando…")}</p>
      ) : (
        <ListaDeComentarios
          comentarios={comentarios ?? []}
          onPublicar={(id, texto) => publicar.mutate({ id, texto })}
          publicando={publicar.isPending ? (publicar.variables?.id ?? null) : null}
          onDescartar={(id) => descartar.mutate(id)}
          descartando={descartar.isPending ? (descartar.variables ?? null) : null}
          onNovaRegraParaMidia={abrirFormulario}
        />
      )}
    </div>
  );
}
