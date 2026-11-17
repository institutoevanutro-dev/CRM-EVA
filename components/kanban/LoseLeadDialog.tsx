"use client";
import { useMemo, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useLoseLead } from "@/hooks/kanban/useUpdateLead";
import { useMotivosDePerdaDoFunil } from "@/hooks/kanban/useMotivosDePerdaDoFunil";
import { CANONICAL_LOST_REASONS } from "@/lib/schemas/leads";
import type { CanonicalLostReason } from "@/lib/schemas/leads";
import { OUTRO, opcoesDeMotivoDePerda } from "@/lib/leads/motivos-de-perda-do-funil";

const REASON_LABELS: Record<(typeof CANONICAL_LOST_REASONS)[number], string> = {
  requested_by_customer: "Cliente solicitou cancelamento",
  price: "Preço",
  no_response: "Sem resposta do cliente",
  product_unavailable: "Produto indisponível",
  cancelled_by_store: "Cancelado pela loja",
  cancelled_by_customer: "Cancelado pelo cliente",
  payment_failed: "Falha no pagamento",
  other: "Outro motivo",
  opted_out_of_messages: "Pediu para não receber mensagens",
};

interface LoseLeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Modo CARD: a rota individual `/lose`. */
  leadId?: string;
  pipelineId: string;
  /**
   * Modo LOTE (porte do upstream #2868): o motivo escolhido vai para quem
   * chamou, que escreve pela `leads/bulk`. Com ele, `leadId` é ignorado.
   */
  onConfirm?: (lostReason: string) => void | Promise<void>;
  /** A escrita do chamador em voo (modo lote). */
  submitting?: boolean;
  /**
   * Os motivos cadastrados no funil, quando quem abre o diálogo os tem à mão
   * (o Inbox, pela ficha). Ausente = lê do quadro em cache, como no funil.
   */
  motivosDoFunil?: string[];
}

const MAX_LEN = 500;

export function LoseLeadDialog({
  open,
  onOpenChange,
  leadId,
  pipelineId,
  motivosDoFunil,
  onConfirm,
  submitting = false,
}: LoseLeadDialogProps) {
  const t = useT();
  const [reasonCode, setReasonCode] = useState<string>("");
  const [otherText, setOtherText] = useState("");
  const mutation = useLoseLead(pipelineId);

  // O funil deste card manda na lista: o que ele tem cadastrado substitui o
  // padrão do produto — ver lib/leads/motivos-de-perda-do-funil.ts.
  const doQuadro = useMotivosDePerdaDoFunil(pipelineId);
  const cadastrados = motivosDoFunil ?? doQuadro;
  const opcoes = useMemo(() => opcoesDeMotivoDePerda(cadastrados), [cadastrados]);

  // "OUTRO MOTIVO" GRAVA `other`, E O DETALHE VAI À PARTE (auditoria 16/11,
  // achado 29). `other` é canônico: `fn_validate_lost_reason_required` o
  // aceita em qualquer funil. Antes o texto do "Detalhe (opcional)" era
  // mandado COMO motivo, e o trigger só aceita canônico ∪ cadastrado — então
  // qualquer frase de verdade travava o Confirmar (e um campo "opcional" que
  // recusa todo texto não é opcional, é armadilha). Agora o motivo é sempre um
  // código aceito, e a frase vai para a linha da timeline.
  //
  // No modo LOTE o detalhe não aparece: a `leads/bulk` carrega um motivo só,
  // e um texto digitado que ninguém grava seria perdido sem aviso.
  const textoOutro = otherText.trim();
  const mostraDetalhe = reasonCode === OUTRO && !onConfirm;
  const detalhe = mostraDetalhe && textoOutro ? textoOutro : undefined;

  const emVoo = mutation.isPending || submitting;
  const disabled = !reasonCode || emVoo;

  const handleSubmit = async () => {
    if (disabled) return;
    try {
      if (onConfirm) await onConfirm(reasonCode);
      else if (leadId) await mutation.mutateAsync({ leadId, lostReason: reasonCode, detalhe });
      else return;
      setReasonCode("");
      setOtherText("");
      onOpenChange(false);
    } catch {
      // error already toasted
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Marcar como perdido")}</DialogTitle>
          <DialogDescription>
            {t("Informe o motivo. Essa informação ajuda a melhorar o funil.")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <Label>{t("Motivo")}</Label>
          <div className="grid grid-cols-1 gap-1.5">
            {opcoes.map((opcao) => (
              <label
                key={opcao.valor}
                className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-row-hover has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
              >
                <input
                  type="radio"
                  name="lost-reason"
                  value={opcao.valor}
                  checked={reasonCode === opcao.valor}
                  onChange={(e) => setReasonCode(e.target.value)}
                />
                <span>{opcao.doFunil ? opcao.valor : t(REASON_LABELS[opcao.valor as CanonicalLostReason] ?? opcao.valor)}</span>
              </label>
            ))}
          </div>
          {mostraDetalhe && (
            <div className="grid gap-1.5">
              <Label htmlFor="lost-reason-other">
                {t("Detalhe (opcional)")}
              </Label>
              <Textarea
                id="lost-reason-other"
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                placeholder={t("Ex: Cliente desistiu por X motivo")}
                maxLength={MAX_LEN}
                rows={3}
              />
              <div className="text-right text-[11px] text-muted-foreground tabular-nums">
                {otherText.length}/{MAX_LEN}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("O motivo fica como “Outro”; o detalhe aparece no histórico do negócio.")}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={emVoo}
          >
            {t("Cancelar")}
          </Button>
          <Button onClick={handleSubmit} disabled={disabled}>
            {emVoo ? t("Salvando...") : t("Confirmar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
