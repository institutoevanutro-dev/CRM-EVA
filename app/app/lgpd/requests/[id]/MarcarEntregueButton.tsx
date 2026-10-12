"use client";

import { useState } from "react";
import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";
import { useMarcarPedidoEntregue } from "@/hooks/useLgpdPedidoManual";
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
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api/types";
import { LGPD_FORMAS_DE_ENTREGA, type LgpdFormaDeEntrega, type LgpdRequestType } from "@/lib/lgpd/types";
import { CheckCircle } from "@/lib/ui/icons";

/** Rótulo de cada forma de entrega em mãos. Também usado na página do pedido. */
export const FORMA_DE_ENTREGA_LABELS: Record<LgpdFormaDeEntrega, string> = {
  presencial: "Em mãos, pessoalmente",
  email: "Por e-mail, enviado pela equipe",
  whatsapp: "Pelo WhatsApp",
};

interface Props {
  requestId: string;
  requestType: LgpdRequestType;
  status: string;
}

/**
 * Fecha o pedido de dados em "Revisão pendente" depois que a equipe entregou o
 * relatório à mão. Sem este botão o pedido nunca saía desse estado e o alarme de
 * prazo tocava para sempre.
 */
export function MarcarEntregueButton({ requestId, requestType, status }: Props) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [forma, setForma] = useState<LgpdFormaDeEntrega>("presencial");
  const [nota, setNota] = useState("");
  const { mutate, isPending } = useMarcarPedidoEntregue(requestId);

  if (requestType !== "data_request" || status !== "pending_review") return null;

  function confirmar() {
    mutate(
      { method: forma, note: nota.trim() || null },
      {
        onSuccess: () => {
          toast.success(t("Pedido marcado como entregue."));
          setAberto(false);
        },
        onError: (err) =>
          toast.error(
            err instanceof ApiError && err.message
              ? err.message
              : t("Não foi possível marcar como entregue. Tente de novo."),
          ),
      },
    );
  }

  return (
    <AlertDialog open={aberto} onOpenChange={setAberto}>
      <AlertDialogTrigger asChild>
        <Button size="sm" className="gap-2">
          <CheckCircle size={16} aria-hidden />
          {t("Marcar como entregue")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Marcar o relatório como entregue")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("Confirme só depois que a pessoa recebeu o relatório. O pedido passa a Concluído, o prazo para de contar, e fica registrado quem entregou, quando e como.")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="lgpd-forma-de-entrega">{t("Como foi entregue")}</Label>
            <select
              id="lgpd-forma-de-entrega"
              className="flex h-10 w-full rounded-sm border border-border bg-bg px-3 py-2 text-sm text-text"
              value={forma}
              onChange={(e) => setForma(e.target.value as LgpdFormaDeEntrega)}
            >
              {LGPD_FORMAS_DE_ENTREGA.map((f) => (
                <option key={f} value={f}>
                  {t(FORMA_DE_ENTREGA_LABELS[f])}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="lgpd-nota-da-entrega">
              {t("Observação")}{" "}
              <span className="text-xs text-muted-foreground">({t("opcional")})</span>
            </Label>
            <Textarea
              id="lgpd-nota-da-entrega"
              rows={2}
              maxLength={500}
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              className="resize-none"
            />
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              confirmar();
            }}
            disabled={isPending}
          >
            {isPending ? t("Gravando…") : t("Confirmar entrega")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
