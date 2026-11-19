"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import { CheckCircle } from "@/lib/ui/icons";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useApiErrorHandler } from "@/components/feedback/ApiErrorToast";
import { useApproveLgpdRequest } from "@/hooks/useApproveLgpdRequest";
import type { LgpdRequestType } from "@/hooks/useLgpdRequests";

interface ApproveButtonProps {
  requestId: string;
  requestType: LgpdRequestType;
  status: string;
  /** De quem é o pedido, para o diálogo dizer o nome. */
  titular: string;
}

/** A mesma palavra da ficha (`AnonymizeDialog`): apagar dados pede digitá-la. */
const CONFIRM_TEXT = "ANONIMIZAR";

const VARIANT_LABELS: Record<LgpdRequestType, { button: string; title: string; description: string }> = {
  data_request: {
    button: "Aprovar a cópia dos dados",
    title: "Aprovar a cópia dos dados de",
    description:
      "Ao confirmar, o relatório com os dados desta pessoa começa a ser montado. A aprovação não pode ser desfeita.",
  },
  redact: {
    button: "Apagar dados do paciente",
    title: "Apagar os dados de",
    description:
      "Ao confirmar, nome, telefone, e-mail e CPF desta pessoa são apagados e as conversas são redigidas. Não dá para desfazer. As datas do histórico ficam.",
  },
  store_redact: {
    button: "Apagar dados da loja",
    title: "Apagar os dados de",
    description:
      "Ao confirmar, os dados pessoais de todos os clientes da loja são apagados. Não dá para desfazer.",
  },
};

export function ApproveButton({ requestId, requestType, status, titular }: ApproveButtonProps) {
  const t = useT();
  const mostrarErro = useApiErrorHandler();
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [open, setOpen] = useState(false);
  const { mutate, isPending } = useApproveLgpdRequest();

  // Only show if status is 'received'
  if (status !== "received") return null;

  const labels = VARIANT_LABELS[requestType];
  // Apagar dados é irreversível: a mesma guarda da ficha (justificativa + digitar
  // ANONIMIZAR). A cópia dos dados não apaga nada e fica só com a justificativa.
  const apaga = requestType !== "data_request";
  const isValid = reason.trim().length >= 10 && (!apaga || confirm === CONFIRM_TEXT);

  function handleConfirm() {
    if (!isValid) return;
    mutate(
      { id: requestId, approved_reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success(t("Aprovado. O pedido está em andamento; esta tela se atualiza sozinha."));
          setOpen(false);
          setReason("");
          setConfirm("");
        },
        // O motivo que a rota deu (pedido já aprovado, sessão de suporte…), não
        // um "Falha ao aprovar" igual para tudo.
        onError: mostrarErro,
      },
    );
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setReason("");
          setConfirm("");
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <Button size="sm" variant={apaga ? "destructive" : "default"} className="gap-2">
          <CheckCircle size={16} aria-hidden />
          {t(labels.button)}
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className={apaga ? "text-error-fg" : undefined}>
            {t(labels.title)} {titular}
          </AlertDialogTitle>
          <AlertDialogDescription>{t(labels.description)}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2 py-2">
          <Label htmlFor="approved_reason">
            {t("Justificativa")}{" "}
            <span className="text-muted-foreground text-xs">({t("mínimo 10 caracteres")})</span>
          </Label>
          <Textarea
            id="approved_reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("Descreva o motivo da aprovação manual desta solicitação…")}
            rows={3}
            maxLength={500}
            className="resize-none"
            aria-describedby="approved_reason_hint"
          />
          <p id="approved_reason_hint" className="text-xs text-muted-foreground">
            {reason.trim().length}/500 {t("caracteres")}
          </p>
        </div>

        {apaga && (
          <div className="space-y-2">
            <div className="rounded-md border border-error-fg/30 bg-error-bg p-3 text-sm text-error-fg">
              {t("Para confirmar, digite")} <strong>{CONFIRM_TEXT}</strong> {t("abaixo.")}
            </div>
            <Label htmlFor="approved_confirm">{t("Confirmação")}</Label>
            <Input
              id="approved_confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={CONFIRM_TEXT}
              autoComplete="off"
            />
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
            disabled={!isValid || isPending}
            className={apaga ? buttonVariants({ variant: "destructive" }) : undefined}
          >
            {isPending ? t("Aprovando…") : t(apaga ? "Apagar permanentemente" : "Confirmar aprovação")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
