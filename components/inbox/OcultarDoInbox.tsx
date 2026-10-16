"use client";
/**
 * OCULTAR DO INBOX (migration 0372) — o botão, a pergunta e a volta.
 *
 * O médico ligou o próprio Instagram pessoal, e as mensagens dos amigos caíam no
 * Inbox da clínica. Quem atende (agent+) tira o contato do Inbox; quem gerencia
 * (manager+) vê os ocultos na aba "Ocultos" e traz de volta.
 *
 * A pergunta diz TUDO o que muda, porque a marca vale para muito mais que a
 * lista: contagens, Fila, radar, Início, IA, follow-up, automação e o card do
 * funil. E diz o que NÃO muda: as mensagens continuam guardadas.
 *
 * Duas formas, um comportamento: ícone no cabeçalho da conversa (a barra já é
 * apertada e recusa menu "mais", ver o comentário de `ConversationHeader`) e
 * botão com texto na ficha do contato.
 */
import { useState } from "react";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useOcultarDoInbox, type PedidoDeOcultacao } from "@/hooks/contacts/useOcultarDoInbox";
import { useT } from "@/hooks/i18n/useT";
import { roleAtLeast } from "@/lib/auth/types";
import { Eye, EyeSlash } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  contactId: string;
  /** Pelo Inbox, a ocultação chega pela conversa (é o que a rota do lote também usa). */
  conversationId?: string;
  nome: string;
  oculto: boolean;
  variante: "icone" | "botao";
}

/**
 * O selo "Oculto do Inbox", para quem abre a conversa ou a ficha de um oculto.
 * Não quebra linha: no cabeçalho da conversa, apertado, ele virava uma pílula de
 * três linhas no Safari (medido em 1280px); quem encolhe ali é o nome, que trunca.
 */
export function SeloDeOculto({ className }: { className?: string }) {
  const t = useT();
  return (
    <Badge
      variant="outline"
      className={cn("shrink-0 gap-1 whitespace-nowrap", className)}
      data-testid="selo-oculto-do-inbox"
    >
      <EyeSlash size={12} aria-hidden />
      {t("Oculto do Inbox")}
    </Badge>
  );
}

export function OcultarDoInbox({ contactId, conversationId, nome, oculto, variante }: Props) {
  const t = useT();
  const { activeOrg, user } = useAuth();
  const definir = useOcultarDoInbox();
  const [perguntando, setPerguntando] = useState(false);

  if (user.support?.access_mode === "support_readonly") return null;
  const podeOcultar = roleAtLeast(activeOrg?.role, "agent");
  const podeMostrar = roleAtLeast(activeOrg?.role, "manager");

  if (oculto) {
    if (!podeMostrar) return null;
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={definir.isPending}
        onClick={() => definir.mutate({ ocultar: false, contactId })}
        data-testid="mostrar-no-inbox"
        className="shrink-0 gap-1.5"
      >
        <Eye size={16} aria-hidden />
        {t("Mostrar no Inbox")}
      </Button>
    );
  }
  if (!podeOcultar) return null;

  const pedido: PedidoDeOcultacao = conversationId
    ? { ocultar: true, conversationId }
    : { ocultar: true, contactId };

  return (
    <>
      {variante === "icone" ? (
        <Button
          size="sm"
          variant="ghost"
          className="w-11 px-0 lg:w-8"
          disabled={definir.isPending}
          onClick={() => setPerguntando(true)}
          aria-label={t("Ocultar do Inbox")}
          title={t("Ocultar do Inbox")}
          data-testid="ocultar-do-inbox"
        >
          <EyeSlash size={16} aria-hidden />
        </Button>
      ) : (
        <Button
          variant="outline"
          disabled={definir.isPending}
          onClick={() => setPerguntando(true)}
          className="shrink-0 gap-1.5"
          data-testid="ocultar-do-inbox"
        >
          <EyeSlash size={16} weight="bold" aria-hidden />
          <span>{t("Ocultar do Inbox")}</span>
        </Button>
      )}
      <AlertDialog open={perguntando} onOpenChange={setPerguntando}>
        <AlertDialogContent className="sm:max-w-md" data-testid="ocultar-do-inbox-dialogo">
          <AlertDialogHeader>
            {/* `wrap-anywhere`: o nome pode ser um @ do Instagram sem espaço
                nenhum, e sem isto ele empurraria o diálogo para fora da tela. */}
            <AlertDialogTitle className="wrap-anywhere">
              {t("Ocultar do Inbox")}: {nome}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-text-muted">
                <p>
                  {t(
                    "As conversas deste contato saem do Inbox, das contagens, da Fila, do radar e do Início. A IA não responde, follow-ups e automações não mandam mensagem e ele não ganha card novo no funil.",
                  )}
                </p>
                <p>
                  {t(
                    "Nada é apagado: as mensagens continuam guardadas. Um gerente pode trazê-lo de volta em Inbox › Mais › Ocultos.",
                  )}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={definir.isPending}>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={definir.isPending}
              data-testid="ocultar-do-inbox-confirmar"
              onClick={(e) => {
                // O diálogo fecha quando o servidor respondeu, não antes.
                e.preventDefault();
                definir.mutate(pedido, { onSuccess: () => setPerguntando(false) });
              }}
            >
              {t("Ocultar do Inbox")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
