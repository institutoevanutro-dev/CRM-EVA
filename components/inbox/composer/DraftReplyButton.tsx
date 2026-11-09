"use client";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Sparkle } from "@/lib/ui/icons";
import { useDraftReply } from "@/hooks/inbox/useDraftReply";

interface Props {
  conversationId: string;
  onDraft: (text: string) => void;
  disabled?: boolean;
}

/** Onda 5.1: botão "Sugerir resposta" — gera rascunho via agente publicado, sem enviar. */
export function DraftReplyButton({ conversationId, onDraft, disabled }: Props) {
  const t = useT();
  const mutation = useDraftReply();

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      // I4: mora na primeira linha do compositor, com texto. 44 px no toque e
      // abaixo do `lg` (o `size="sm"`, porte do #3191); 28 px no computador, a
      // altura da linha. Em compositor estreito sobra o ícone, e o nome fica no
      // `aria-label`.
      className="min-w-11 gap-1 px-1.5 text-muted-foreground hover:text-foreground lg:h-7 lg:min-w-0 [&_svg]:size-3.5"
      aria-label={t("Sugerir resposta")}
      aria-busy={mutation.isPending}
      disabled={disabled || mutation.isPending}
      onClick={() => {
        mutation.mutate(conversationId, {
          onSuccess: (res) => onDraft(res.data.draft),
        });
      }}
    >
      <Sparkle size={14} weight={mutation.isPending ? "duotone" : "regular"} aria-hidden />
      <span className="hidden truncate @[26rem]:inline">{t("Sugerir resposta")}</span>
    </Button>
  );
}
