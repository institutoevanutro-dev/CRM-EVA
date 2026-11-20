"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { liberarEcoLocal, marcarEcoLocal } from "@/lib/kanban/local-echo";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Lead } from "@/lib/types/leads";
import type { BoardData } from "@/lib/kanban/types";

interface MoveArgs {
  leadId: string;
  stageId: string;
  positionInStage: number;
  expectedUpdatedAt: string;
}

export function useMoveCard(pipelineId: string) {
  const qc = useQueryClient();
  const queryKey = ["board", pipelineId] as const;

  return useMutation({
    mutationFn: async (args: MoveArgs) => {
      // Minha própria ação não pulsa: o card já se moveu sob o cursor.
      marcarEcoLocal(args.leadId);
      return apiClient.post<{ data: Lead }>(`/api/v1/leads/${args.leadId}/move`, {
        stage_id: args.stageId,
        position_in_stage: args.positionInStage,
        expected_updated_at: args.expectedUpdatedAt,
      });
    },
    onMutate: async (args) => {
      await qc.cancelQueries({ queryKey });
      const snapshot = qc.getQueryData<BoardData>(queryKey);
      if (snapshot) {
        qc.setQueryData<BoardData>(queryKey, {
          ...snapshot,
          leads: snapshot.leads.map((l) =>
            l.id === args.leadId
              ? { ...l, stage_id: args.stageId, position_in_stage: args.positionInStage }
              : l,
          ),
        });
      }
      return { snapshot };
    },
    onSuccess: (res, args) => {
      // A resposta é o lead como o servidor o deixou, com o `updated_at` final.
      // Sem gravá-la aqui, o cache seguia com o valor de antes até o refetch do
      // `onSettled` chegar, e arrastar o mesmo card de novo nesse intervalo
      // mandava `expected_updated_at` velho → 409 (issue #916).
      //
      // Desde o porte do #4911 do original, é a ÚNICA reconciliação do arraste
      // que deu certo: o servidor já mandou o estado autoritativo da linha, e
      // reler o funil inteiro não traria nada a mais. Se a etapa que voltou for
      // diferente da otimista, a fusão corrige o card na tela.
      //
      // Exceção do fork: o card que veio dos fechados antigos ("Ver mais") não
      // mora nesta chave, então a fusão não o alcança — só para ele relê (por
      // prefixo, alcança a chave dos antigos).
      const atual = qc.getQueryData<BoardData>(queryKey);
      if (atual && !atual.leads.some((l) => l.id === args.leadId)) {
        void qc.invalidateQueries({ queryKey });
        return;
      }
      qc.setQueryData<BoardData>(queryKey, (atual) =>
        atual
          ? {
              ...atual,
              leads: atual.leads.map((l) => (l.id === args.leadId ? { ...l, ...res.data } : l)),
            }
          : atual,
      );
    },
    onError: (err, _args, ctx) => {
      if (ctx?.snapshot) qc.setQueryData(queryKey, ctx.snapshot);
      // Relê em TODO erro, não só no 409. Rede caída, timeout ou 5xx podem
      // chegar DEPOIS de a rota já ter gravado o movimento: o snapshot devolve
      // o card à coluna antiga, e o evento de realtime desse lead cai na marca
      // de eco (useBoard o ignora). Sem esta releitura, a tela ficaria errada
      // até o próximo evento do funil. Erro é raro; o arraste que dá certo
      // continua sem reler.
      void qc.invalidateQueries({ queryKey });
      showApiError(err);
    },
    onSettled: (_data, _err, args) => {
      // A marca fecha com a AÇÃO, não com o relógio: daqui em diante só a folga
      // curta do último evento da cascata (ver lib/kanban/local-echo.ts).
      liberarEcoLocal(args.leadId);
      // AQUI NÃO SE RELÊ O QUADRO (porte do #4911 do original). Era esta linha
      // que fazia todo arraste recarregar o funil INTEIRO — num funil com
      // milhares de negócios, uma leitura completa da rota do quadro a cada
      // card solto. O `onSuccess` já fundiu a resposta do servidor no card; o
      // que chegar de fora vem pelo realtime, agrupado (useBoard), e a rede de
      // segurança confere a assinatura na volta para a aba. Erro relê no
      // `onError`, porque ali o estado do servidor é desconhecido.
    },
  });
}
