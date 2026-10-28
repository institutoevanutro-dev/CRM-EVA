"use client";
/**
 * ABRIR A CONVERSA DE QUEM ACABOU DE SER CADASTRADO.
 *
 * Portado do projeto original (DeskcommCRM, PR #3547, a partir do #3528 de
 * @webtecnica). Montado só quando há alvo (`{alvo && <AbrirConversaAposSalvar
 * alvo={alvo} />}`): o formulário de cadastro não ganha router nem rede para
 * quem só quer cadastrar.
 *
 * O caminho é o do painel "Iniciar conversa" do Inbox: `POST
 * open-with-contact`, depois o MESMO claim (`assumirConversaAoAbrir`), a lista
 * do Inbox invalidada e a navegação para a conversa. Nenhuma permissão é
 * decidida aqui: as duas rotas exigem papel `agent` no servidor, e a recusa
 * aparece na tela sem navegar.
 *
 * Adaptação: o original pergunta o canal quando há mais de um número
 * (`useConversaNovaComEscolhaDeCanal`); este fork não tem esse seletor, e o
 * `open-with-contact` escolhe o número como o painel do Inbox já faz.
 */
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { assumirConversaAoAbrir } from "@/lib/inbox/assumir-conversa-ao-abrir";

export interface AlvoDeConversaAposSalvar {
  contact_id: string;
}

export function AbrirConversaAposSalvar({ alvo }: { alvo: AlvoDeConversaAposSalvar }) {
  const t = useT();
  const { user } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  /**
   * Um pedido por ALVO: re-render com o mesmo objeto não reabre, mas um alvo
   * novo (outro cadastro com o componente ainda montado) abre.
   */
  const ultimoAlvo = useRef<AlvoDeConversaAposSalvar | null>(null);

  useEffect(() => {
    if (ultimoAlvo.current === alvo) return;
    ultimoAlvo.current = alvo;
    void (async () => {
      try {
        const res = await apiClient.post<{ data: { conversation_id: string } }>(
          "/api/v1/conversations/open-with-contact",
          alvo,
        );
        const conversationId = res.data.conversation_id;
        await assumirConversaAoAbrir(conversationId, { userId: user.id, t });
        // A lista do Inbox é o destino: sem invalidar, a conversa recém-nascida
        // não está nela quando a navegação chega.
        await qc.invalidateQueries({ queryKey: ["conversations"] });
        router.push(`/app/inbox?id=${conversationId}`);
      } catch (err) {
        showApiError(err);
      }
    })();
  }, [alvo, user.id, t, qc, router]);

  return null;
}
