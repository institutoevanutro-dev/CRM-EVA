"use client";
import { useMemo, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface Props {
  open: boolean;
  onOpenChange: (aberto: boolean) => void;
  /** As conversas já carregadas na inbox — o universo de destinos oferecidos. */
  conversas: ConversationWithContact[];
  /** A conversa atual: encaminhar para ela mesma não faz sentido, então some. */
  conversationIdAtual: string | null;
  enviando: boolean;
  onEscolher: (conversationId: string) => void;
}

/**
 * A escolha do DESTINO do encaminhamento (DeskcommCRM #2835; portado do projeto
 * original, PR #2841).
 *
 * A lista de destinos é a que a inbox já carregou (`useConversationsRealtime`)
 * — sem busca nova no servidor: quem atende tem à mão as conversas da aba, e o
 * encaminhamento é o gesto de "manda para aquele cliente logo ali". Conversa
 * fora da aba se alcança pela busca da própria inbox, antes de encaminhar.
 *
 * O filtro é local e por nome/telefone: a mensagem já está escolhida e a
 * escolha do destino é a única pergunta que falta.
 */
export function EncaminharDialog({
  open,
  onOpenChange,
  conversas,
  conversationIdAtual,
  enviando,
  onEscolher,
}: Props) {
  const t = useT();
  const [busca, setBusca] = useState("");
  // Fechar zera a busca por QUALQUER caminho (Cancelar, o X, o encaminhamento
  // que deu certo e o pai que fecha): reabrir noutra mensagem sem a lupa antiga.
  // Ajuste durante o render, o padrão do React para estado que segue uma prop.
  const [abertoAntes, setAbertoAntes] = useState(open);
  if (abertoAntes !== open) {
    setAbertoAntes(open);
    if (!open) setBusca("");
  }

  const destinos = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    return conversas
      .filter((c) => c.id !== conversationIdAtual)
      .map((c) => ({
        id: c.id,
        // O rótulo vem da decisão central (`rotuloDoContato`) — nome de gente,
        // depois telefone, depois "Sem nome". É a MESMA régua da lista; uma
        // cadeia montada à mão aqui viraria a sétima cópia.
        rotulo: rotuloDoContato(c.contacts, t),
      }))
      .filter((c) => (termo ? c.rotulo.toLowerCase().includes(termo) : true));
  }, [conversas, conversationIdAtual, busca, t]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Encaminhar mensagem")}</DialogTitle>
          <DialogDescription>{t("Escolha a conversa que vai receber esta mensagem.")}</DialogDescription>
        </DialogHeader>

        <Input
          aria-label={t("Buscar conversa")}
          placeholder={t("Buscar conversa")}
          value={busca}
          onChange={(evento) => setBusca(evento.target.value)}
        />

        <div className="max-h-72 space-y-1 overflow-y-auto py-1">
          {destinos.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">
              {t("Nenhuma conversa encontrada.")}
            </p>
          ) : (
            destinos.map((destino) => (
              <Button
                key={destino.id}
                type="button"
                variant="ghost"
                disabled={enviando}
                onClick={() => onEscolher(destino.id)}
                className="w-full justify-start truncate font-normal"
              >
                {destino.rotulo}
              </Button>
            ))
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={enviando} onClick={() => onOpenChange(false)}>
            {t("Cancelar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
