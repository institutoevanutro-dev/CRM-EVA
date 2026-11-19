"use client";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Sparkle } from "@/lib/ui/icons";
import { useDraftReply } from "@/hooks/inbox/useDraftReply";
import { cn } from "@/lib/utils";

interface Props {
  conversationId: string;
  className?: string;
  onDraft: (text: string) => void;
  disabled?: boolean;
}

/** Onda 5.1: botão "Sugerir resposta" — gera rascunho via agente publicado, sem enviar. */
export function DraftReplyButton({ conversationId, onDraft, disabled, className }: Props) {
  const t = useT();
  const mutation = useDraftReply();

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      // Sem altura fixa: o `size="icon"` dá 44px no toque e 36px no computador,
      // como o anexar e o emoji ao lado (porte do #3191).
      className={cn("shrink-0", className)}
      aria-label={t("Sugerir resposta")}
      title={t("Sugerir resposta")}
      aria-busy={mutation.isPending}
      disabled={disabled || mutation.isPending}
      onClick={() => {
        mutation.mutate(conversationId, {
          onSuccess: (res) => onDraft(res.data.draft),
        });
      }}
    >
      <Sparkle size={18} weight={mutation.isPending ? "duotone" : "regular"} aria-hidden />
    </Button>
  );
}
