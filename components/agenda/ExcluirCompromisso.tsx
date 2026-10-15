"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/**
 * Excluir o compromisso lançado por engano ou de teste (migration 0364).
 *
 * O aviso é o ponto da tela: para compromisso de verdade o caminho é
 * "Cancelar agendamento", que conta a história ao negócio. Excluir some com ele
 * de toda tela e relatório; a linha só fica na auditoria.
 */
export function ExcluirCompromisso({ id, onExcluido }: { id: string; onExcluido: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [aberto, setAberto] = useState(false);
  const [motivo, setMotivo] = useState("");
  const valido = motivo.trim().length >= 3;
  const excluir = useMutation({
    mutationFn: async () =>
      apiClient.post(`/api/v1/agenda/agendamentos/${id}/excluir`, { reason: motivo.trim() }),
    onSuccess: () => {
      setAberto(false);
      setMotivo("");
      void qc.invalidateQueries({ queryKey: ["agenda"] });
      onExcluido();
    },
    onError: showApiError,
  });

  return (
    <>
      <Button variant="ghost" className="text-error" onClick={() => setAberto(true)} data-testid="excluir-compromisso">
        {t("Excluir (lançado por engano)")}
      </Button>
      <AlertDialog
        open={aberto}
        onOpenChange={(open) => {
          if (!open) {
            setAberto(false);
            setMotivo("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Excluir este agendamento?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Use só para agendamento de teste ou lançado por engano. Ele sai da agenda, das listas e dos relatórios, e o horário fica livre. Se o paciente desmarcou, use \"Cancelar agendamento\".",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="motivo-da-exclusao">{t("Motivo da exclusão")}</Label>
            <Textarea
              id="motivo-da-exclusao"
              value={motivo}
              maxLength={500}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder={t("Ex.: teste do sistema, paciente errado")}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Voltar")}</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={!valido || excluir.isPending}
              onClick={() => excluir.mutate()}
              data-testid="confirmar-exclusao"
            >
              {t("Excluir agendamento")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
