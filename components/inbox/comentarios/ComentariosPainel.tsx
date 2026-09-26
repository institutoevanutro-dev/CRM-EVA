"use client";
import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useComentarios, usePublicarComentario, useCriarRegraDeComentario } from "@/hooks/comentarios/useComentarios";
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
  const criarRegra = useCriarRegraDeComentario();
  const [mostrarFormulario, setMostrarFormulario] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold text-text">{t("Comentários")}</h2>
        <Button variant="outline" size="sm" onClick={() => setMostrarFormulario((v) => !v)}>
          {mostrarFormulario ? t("Fechar") : t("Nova regra")}
        </Button>
      </div>
      {mostrarFormulario && (
        <div className="border-b border-border">
          <FormularioDeRegra
            enviando={criarRegra.isPending}
            onCriar={(regra) =>
              criarRegra.mutate(regra, { onSuccess: () => setMostrarFormulario(false) })
            }
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
        />
      )}
    </div>
  );
}
