"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/**
 * Remarca de verdade — `PATCH /api/v1/agenda/agendamentos`.
 *
 * ═══ O defeito que este hook fechou (com a lista de baixo, removida em 27/11/2026) ═══
 *
 * `HistoricoDaAgenda` aceitava `onRemarcar` e `onCancelar` desde que nasceu, com
 * `disabled={!onRemarcar}` nos botões — e `app/app/agenda/_client.tsx` montava o
 * componente **sem nenhuma callback**. Resultado: os dois botões nasciam CINZAS
 * em toda linha, de toda organização, para sempre. Controle decorativo, que é um
 * defeito que esta base já pagou uma vez (PR #295, cinco deles).
 *
 * E o `title` do botão cinza dizia "Disponível quando a agenda estiver
 * conectada" — falso, e pior que o silêncio: PATCH e DELETE não tocam o Google.
 * Quem lia acreditava que faltava conectar a agenda, quando faltava a fiação.
 *
 * Medido antes: `grep -rn "crm_cancel_appointment|cancelarAgendamentoHandler|
 * alterarAgendamentoHandler" app/ components/ hooks/` → zero em `components/`,
 * zero em `hooks/`, zero em qualquer `app/app/**`. **Só a IA conseguia remarcar
 * ou cancelar** — a pessoa que atende, não.
 *
 * A mutação invalida `["agenda"]`, a mesma chave que `useAgendamentos` usa,
 * então a grade e o painel repintam sozinhos. Cancelar e registrar desfecho
 * moram no painel do paciente (`DetalheDoCompromisso`).
 */
export function useRemarcarAgendamento() {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (entrada: {
      id: string;
      revision?: number;
      /**
       * O novo início. AUSENTE quando só a duração muda (a borda da grade, porte
       * de melgarafael/DeskcommCRM#5082): aí a rota reescreve só o fim.
       */
      starts_at?: string;
      guest_email?: string;
      /** A duração nova, em minutos. */
      duration_minutes?: number;
    }) => apiClient.patch<{ data: { id: string } }>("/api/v1/agenda/agendamentos", entrada),
    // O aviso diz o que aconteceu: sem `starts_at` nada foi remarcado — só o
    // tempo mudou.
    onSuccess: (_dados, entrada) => {
      toast.success(entrada.starts_at ? t("Agendamento remarcado.") : t("Duração alterada."));
      void qc.invalidateQueries({ queryKey: ["agenda"] });
    },
    onError: (err) => {
      showApiError(err);
      // Recusado ou passado para trás (409): a grade volta a ler o que vale
      // agora, em vez de seguir desenhando a versão que o servidor recusou.
      void qc.invalidateQueries({ queryKey: ["agenda"] });
    },
  });
}
