"use client";
/**
 * RECOMEÇAR O RADAR A PARTIR DE AGORA (migration 0370).
 *
 * Para a clínica que acabou de adotar o CRM: o radar enche com o que esfriou
 * antes de o sistema ser usado, e o que pede atenção hoje some no meio. O
 * administrador recomeça, e o radar passa a contar dali. Nada é apagado; quem
 * tiver atividade nova volta sozinho.
 *
 * Todos veem QUANDO o radar foi recomeçado (é o que explica por que itens antigos
 * sumiram); só o administrador recomeça e desfaz. A rota recusa os outros papéis
 * de qualquer forma: esconder aqui é não prometer o que o servidor recusa.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useAtRiskLeads } from "@/hooks/leads/useAtRiskLeads";
import { apiClient } from "@/lib/api/client";
import { ArrowBendUpLeft, ClockCounterClockwise } from "@/lib/ui/icons";

const ROTA = "/api/v1/leads/at-risk/recomeco";

type Pergunta = "recomecar" | "desfazer" | null;

/** "16/10 às 08:30", no fuso de quem olha. */
function quando(iso: string, tag: string, t: (texto: string) => string): string {
  const d = new Date(iso);
  const dia = d.toLocaleDateString(tag, { day: "2-digit", month: "2-digit" });
  const hora = d.toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" });
  return `${dia} ${t("às")} ${hora}`;
}

export function RecomecoDoRadar({ podeRecomecar }: { podeRecomecar: boolean }) {
  const t = useT();
  const tag = useTagDeIdioma();
  const qc = useQueryClient();
  const { data } = useAtRiskLeads();
  const [pergunta, setPergunta] = useState<Pergunta>(null);
  const recomecadoEm = data?.recomecado_em ?? null;

  const definir = useMutation({
    mutationFn: (recomecar: boolean) =>
      recomecar
        ? apiClient.post<{ data: { recomecado_em: string | null } }>(ROTA, {})
        : apiClient.delete<{ data: { recomecado_em: string | null } }>(ROTA),
    onSuccess: (_r, recomecar) => {
      setPergunta(null);
      void qc.invalidateQueries({ queryKey: ["leads-at-risk"] });
      toast.success(recomecar ? t("Radar recomeçado a partir de agora") : t("O radar voltou a mostrar tudo"));
    },
    onError: showApiError,
  });

  if (!recomecadoEm && !podeRecomecar) return null;

  return (
    <div className="flex flex-wrap items-center justify-end gap-2" data-testid="radar-recomeco">
      {recomecadoEm ? (
        <p className="text-xs text-text-muted" role="status" data-testid="radar-recomecado-em">
          {t("Radar recomeçado em")} {quando(recomecadoEm, tag, t)}
        </p>
      ) : null}
      {podeRecomecar && recomecadoEm ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setPergunta("desfazer")}
          disabled={definir.isPending}
          data-testid="radar-desfazer-recomeco"
        >
          <ArrowBendUpLeft size={16} className="mr-1.5" aria-hidden />
          {t("Desfazer")}
        </Button>
      ) : null}
      {podeRecomecar ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPergunta("recomecar")}
          disabled={definir.isPending}
          data-testid="radar-recomecar"
        >
          <ClockCounterClockwise size={16} className="mr-1.5" aria-hidden />
          {t("Recomeçar o radar a partir de agora")}
        </Button>
      ) : null}

      <AlertDialog open={pergunta !== null} onOpenChange={(aberto) => !aberto && setPergunta(null)}>
        <AlertDialogContent className="sm:max-w-md" data-testid="radar-recomeco-dialogo">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pergunta === "desfazer" ? t("Voltar a mostrar tudo no radar?") : t("Recomeçar o radar a partir de agora?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pergunta === "desfazer"
                ? t(
                    "Os negócios e as demandas de antes do recomeço voltam a aparecer no radar. Nada foi apagado enquanto estavam fora.",
                  )
                : t(
                    "O que não teve atividade até agora sai do radar. Nada é apagado: negócios, conversas e demandas continuam como estão, e o item volta sozinho se tiver atividade nova depois deste momento. Dá para desfazer.",
                  )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={definir.isPending}>{t("Cancelar")}</AlertDialogCancel>
            {/* `preventDefault`: o diálogo só fecha quando o servidor respondeu,
                senão uma recusa chegaria sobre uma tela que já disse "pronto". */}
            <AlertDialogAction
              disabled={definir.isPending}
              data-testid="radar-recomeco-confirmar"
              onClick={(e) => {
                e.preventDefault();
                definir.mutate(pergunta !== "desfazer");
              }}
            >
              {pergunta === "desfazer" ? t("Mostrar tudo de novo") : t("Recomeçar agora")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
