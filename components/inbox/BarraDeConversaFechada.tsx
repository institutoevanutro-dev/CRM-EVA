"use client";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { useReabrirEResponder } from "@/hooks/inbox/useReabrirEResponder";
import { useBarrarArquivoSolto } from "@/hooks/inbox/useBarrarArquivoSolto";

/**
 * Conversa fechada: esta barra ocupa o lugar do campo de texto (I3).
 *
 * Antes o campo ficava lá, desligado, sem dizer por quê nem o que fazer. Aqui
 * a frase diz o estado e o botão faz o que a pessoa veio fazer: reabre já
 * como dona e devolve o foco ao campo. `onReabrir` avisa NO CLIQUE: quem
 * monta o campo é que sabe quando ele existe (ver o `InboxLayout`).
 */
export function BarraDeConversaFechada({
  conversationId,
  onReabrir,
}: {
  conversationId: string;
  onReabrir?: () => void;
}) {
  const t = useT();
  const reabrir = useReabrirEResponder();
  // Sem a caixa de texto montada, ninguém mais segura o arquivo solto na tela.
  useBarrarArquivoSolto();
  return (
    <div
      data-testid="barra-conversa-fechada"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 border-t border-border bg-muted/40 px-4 py-3 text-sm text-text-muted"
    >
      <span>{t("Conversa fechada.")}</span>
      <Button
        size="sm"
        disabled={reabrir.isPending}
        onClick={() => {
          onReabrir?.();
          reabrir.mutate({ conversation_id: conversationId });
        }}
      >
        {reabrir.isPending ? t("Reabrindo...") : t("Reabrir e responder")}
      </Button>
    </div>
  );
}
