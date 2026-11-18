"use client";
import { useMemo, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { cn } from "@/lib/utils";
import { filtrarDestinos } from "@/lib/inbox/filtrar-destinos";
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
  // ESCOLHER E ENVIAR SÃO DOIS GESTOS (item 33 da auditoria de 17/11): um toque
  // no nome encaminhava na hora, e duas "Maria" eram iguais. Agora o toque
  // marca, a linha mostra o telefone, e quem envia é o botão que diz para quem.
  const [escolhido, setEscolhido] = useState<string | null>(null);
  const [abertoAntes, setAbertoAntes] = useState(open);
  if (abertoAntes !== open) {
    setAbertoAntes(open);
    if (!open) {
      setBusca("");
      setEscolhido(null);
    }
  }

  const destinos = useMemo(() => {
    const todos = conversas
      .filter((c) => c.id !== conversationIdAtual)
      .map((c) => ({
        id: c.id,
        // O rótulo vem da decisão central (`rotuloDoContato`) — nome de gente,
        // depois telefone, depois "Sem nome". É a MESMA régua da lista; uma
        // cadeia montada à mão aqui viraria a sétima cópia.
        rotulo: rotuloDoContato(c.contacts, t),
        telefone: c.contacts?.phone_number ? phoneForDisplay(c.contacts.phone_number) : null,
      }));
    // A busca ignora caixa E acento: `joao` acha "João".
    return filtrarDestinos(todos, busca);
  }, [conversas, conversationIdAtual, busca, t]);

  // O escolhido que a busca escondeu não some: ele continua sendo o destino.
  const conversaEscolhida = escolhido ? conversas.find((c) => c.id === escolhido) : undefined;
  const alvo = conversaEscolhida
    ? { id: conversaEscolhida.id, rotulo: rotuloDoContato(conversaEscolhida.contacts, t) }
    : null;

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
                aria-pressed={escolhido === destino.id}
                onClick={() => setEscolhido(destino.id)}
                className={cn(
                  "h-auto min-h-11 w-full flex-col items-start gap-0 py-1.5 font-normal",
                  escolhido === destino.id && "bg-accent-soft hover:bg-accent-soft",
                )}
              >
                <span className="w-full truncate text-left">{destino.rotulo}</span>
                {destino.telefone && destino.telefone !== destino.rotulo && (
                  <span className="text-xs text-muted-foreground tabular-nums">{destino.telefone}</span>
                )}
              </Button>
            ))
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={enviando} onClick={() => onOpenChange(false)}>
            {t("Cancelar")}
          </Button>
          <Button
            type="button"
            disabled={enviando || !alvo}
            onClick={() => alvo && onEscolher(alvo.id)}
            className="max-w-full"
          >
            <span className="truncate">
              {enviando
                ? t("Encaminhando…")
                : alvo
                  ? t("Encaminhar para {nome}").replace("{nome}", () => alvo.rotulo)
                  : t("Encaminhar")}
            </span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
