"use client";

import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { trilhasDaEquipe } from "@/lib/agenda/tipos";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaAtual } from "@/lib/i18n/IdiomaProvider";

import type { Pessoa } from "@/components/agenda/tipos";

interface MembroDto {
  user_id: string;
  role: string;
  full_name: string | null;
  revoked_at?: string | null;
}

/**
 * As pessoas da equipe, com a trilha de cor de cada uma.
 *
 * A cor NÃO vem da API: vem de `trilhaPadraoDoMembro(user_id)`, que deriva do id de
 * forma estável. É por isso que a pessoa não troca de cor entre um carregamento
 * e outro, nem quando alguém novo entra na equipe — e é o motivo de este hook
 * não precisar de nenhuma coluna de cor no banco.
 *
 * Quem foi revogado sai da lista: o filtro por pessoa é para quem atende hoje, e
 * uma agenda com ex-funcionário na barra confunde sem informar.
 */
export function usePessoasDaAgenda() {
  return useQuery({
    queryKey: ["agenda", "pessoas"],
    queryFn: async (): Promise<Pessoa[]> => {
      try {
        // A lista MÍNIMA da Agenda (id, papel, nome), e não `/api/v1/team`, que
        // é só de gerente: a recepção tomava 403, a barra vinha vazia e o
        // painel dizia "Você" sobre a jornada da médica. Porte de
        // melgarafael/DeskcommCRM 297e7ff5a (#896, item 1).
        const r = await apiClient.get<{ data: MembroDto[] }>("/api/v1/agenda/pessoas");
        const lista = (r as unknown as { data?: MembroDto[] }).data ?? (r as unknown as MembroDto[]);
        const ativos = (lista ?? []).filter((m) => !m.revoked_at);
        // As trilhas saem da EQUIPE inteira de uma vez, não pessoa a pessoa: é a
        // única forma de garantir que duas pessoas não caiam na mesma cor. O
        // hash sozinho dá estabilidade e não dá distinção — medido, duas caíram
        // na trilha 7 nesta organização.
        const trilhas = trilhasDaEquipe(ativos.map((m) => m.user_id));
        return ativos
          .map((m) => ({
            id: m.user_id,
            // `full_name` pode vir null quando o service role não está
            // configurado — a rota degrada assim de propósito. A lista mínima
            // não traz e-mail, então o rótulo neutro é o que sobra.
            nome: m.full_name ?? "Sem nome",
            trilha: trilhas.get(m.user_id) ?? 1,
          }));
      } catch (err) {
        // O 403 chegava como "Você não tem permissão para esta ação", sem dizer
        // QUAL permissão nem que a grade continuava funcionando.
        if (err instanceof ApiError && err.status === 403) {
          toast.warning(
            traduzir(
              "Os nomes da equipe na agenda pedem um papel acima de Somente leitura. A grade continua funcionando.",
              idiomaAtual(),
            ),
          );
        } else {
          showApiError(err);
        }
        throw err;
      }
    },
  });
}
