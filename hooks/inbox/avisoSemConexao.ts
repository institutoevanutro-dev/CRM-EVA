"use client";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { ApiError } from "@/lib/api/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaAtual } from "@/lib/i18n/IdiomaProvider";

export const ID_DO_AVISO_SEM_CONEXAO = "inbox-sem-conexao";

let ouvindoAVolta = false;

/** A conexão voltou (uma leitura deu certo, ou o navegador avisou): o aviso sai. */
export function conexaoVoltou(): void {
  toast.dismiss(ID_DO_AVISO_SEM_CONEXAO);
}

/**
 * UMA FALHA DE LEITURA DO INBOX, UM AVISO SÓ (item 39 da auditoria de 17/11).
 *
 * Sem internet, cada atualização automática (a lista, o fio, a rede de
 * segurança a cada 45 s) mostrava o seu "Erro inesperado" — vários por vez,
 * sem dizer o que era. Falha sem resposta do servidor (rede, tempo esgotado)
 * vira um aviso único "Sem conexão", com id fixo (o sonner troca em vez de
 * empilhar), que fica até a conexão voltar. Recusa do servidor (ApiError)
 * segue pelo caminho de sempre, porque ali o motivo importa.
 */
export function avisarFalhaDeLeitura(err: unknown): void {
  if (err instanceof ApiError) {
    showApiError(err);
    return;
  }
  toast.warning(
    traduzir("Sem conexão. As conversas voltam a atualizar quando a conexão voltar.", idiomaAtual()),
    { id: ID_DO_AVISO_SEM_CONEXAO, duration: Infinity },
  );
  if (!ouvindoAVolta && typeof window !== "undefined") {
    ouvindoAVolta = true;
    window.addEventListener("online", conexaoVoltou);
  }
}
