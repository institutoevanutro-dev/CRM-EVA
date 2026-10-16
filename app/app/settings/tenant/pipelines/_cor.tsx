"use client";

import { useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { SeletorDeCorDaEtiqueta } from "@/components/tags/SeletorDeCorDaEtiqueta";
import { useT } from "@/hooks/i18n/useT";
import { useEditarFunil } from "@/hooks/pipelines/usePipelines";
import { PALETA_DE_FUNIS, estiloDoFunil } from "@/lib/pipelines/cor-do-funil";

import type { PipelineRow } from "./_client";

/**
 * Nome, endereço e COR do funil (migration 0371). A cor se escolhe com o MESMO
 * seletor da etapa e da etiqueta, e grava pela rota de funis (manager+, a régua
 * desta página). Otimista: o ponto muda na hora e volta se a rota recusar.
 */
export function CabecalhoDoFunil({ pipeline }: { pipeline: PipelineRow }) {
  const t = useT();
  const editar = useEditarFunil();
  const [cor, setCor] = useState<string | null>(pipeline.color ?? null);
  const estilo = estiloDoFunil(cor);

  function mudarCor(nova: string | null) {
    const anterior = cor;
    setCor(nova);
    editar.mutate(
      { id: pipeline.id, patch: { color: nova } },
      {
        onSuccess: () => toast.success(t("Cor do funil atualizada.")),
        onError: (e) => {
          setCor(anterior);
          showApiError(e);
        },
      },
    );
  }

  return (
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-base font-semibold" data-cor-do-funil={cor ?? undefined}>
          {estilo ? <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={estilo.ponto} /> : null}
          <span className="truncate">{pipeline.name}</span>
        </h2>
        <p className="text-xs text-muted-foreground">/{pipeline.slug}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs text-muted-foreground">{t("Cor do funil")}</span>
        <SeletorDeCorDaEtiqueta
          cor={cor}
          onChange={mudarCor}
          paleta={PALETA_DE_FUNIS}
          rotulo="Cor do funil"
          disabled={editar.isPending}
        />
      </div>
    </header>
  );
}
