"use client";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";

/** Uma imagem da resposta rápida na prévia: o item da biblioteca e a posição dele no template. */
export interface ImagemDaResposta {
  itemId: string;
  indice: number;
}

interface Props {
  templateId: string | null;
  imagens: ImagemDaResposta[];
  legendaInicial: string;
  sending: boolean;
  onCancel: (legenda: string) => void;
  onRemove: (itemId: string, legenda: string) => void;
  onSend: (legenda: string) => void;
}

/**
 * A prévia da resposta rápida com imagens da Biblioteca de mídia: o operador vê
 * o que vai sair, tira o que não quer e edita a legenda (o texto da resposta,
 * que vai com a PRIMEIRA imagem). Portado e adaptado do projeto original
 * (DeskcommCRM, PR #2704 de @webtecnica).
 */
export function RespostaComImagensDialog({
  templateId,
  imagens,
  legendaInicial,
  sending,
  onCancel,
  onRemove,
  onSend,
}: Props) {
  const t = useT();
  // Quem chama remonta o diálogo (`key`) quando a fila ou a legenda mudam por fora.
  const [legenda, setLegenda] = useState(legendaInicial);
  if (!templateId || imagens.length === 0) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && !sending && onCancel(legenda)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Enviar resposta com imagens")}</DialogTitle>
        </DialogHeader>
        <ul className="flex flex-wrap gap-2" data-testid="imagens-da-resposta">
          {imagens.map((img) => (
            <li key={img.itemId} className="relative">
              <img
                src={`/api/v1/message-templates/${templateId}/midias/${img.indice}`}
                alt={t("Imagem da resposta rápida")}
                className="size-20 rounded-md border border-border object-cover"
              />
              <button
                type="button"
                onClick={() => onRemove(img.itemId, legenda)}
                disabled={sending}
                aria-label={t("Remover imagem")}
                className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background px-1 text-xs text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <Input
          value={legenda}
          onChange={(e) => setLegenda(e.target.value)}
          placeholder={t("Legenda (opcional)")}
          aria-label={t("Legenda")}
        />
        <p className="text-xs text-muted-foreground">
          {t("Imagem sem termo de uso válido na Biblioteca de mídia não sai: o sistema avisa e envia as outras.")}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onCancel(legenda)} disabled={sending}>
            {t("Cancelar")}
          </Button>
          <Button onClick={() => onSend(legenda.trim())} disabled={sending}>
            {t("Enviar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
