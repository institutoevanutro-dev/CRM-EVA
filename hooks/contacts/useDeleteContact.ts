"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { showApiError } from "@/components/feedback/ApiErrorToast";

/** O que o diálogo "Excluir contato?" mostra quando a Agenda segura a ficha. */
export interface BloqueioDaExclusao {
  mensagem: string;
  /** A Agenda, já no compromisso quando há um só visível. */
  agendaHref: string;
  /** Há compromisso visível: o caminho para ficha duplicada é juntar. */
  sugerirJuntar: boolean;
}

/** Singular e plural por situação; a chave é o valor do banco (`status`). */
function rotulosDaSituacao(t: (texto: string) => string): Record<string, [string, string]> {
  return {
    pending: [t("aguardando confirmação"), t("aguardando confirmação")],
    confirmed: [t("confirmado"), t("confirmados")],
    cancelled: [t("cancelado"), t("cancelados")],
    completed: [t("realizado"), t("realizados")],
    no_show: [t("falta"), t("faltas")],
  };
}

/**
 * A pré-checagem do handler põe `agenda` em `error.details` (migration 0413):
 * quantos compromissos visíveis, em que situação, quantos excluídos ainda
 * pendentes no Google, e qual abrir. Qualquer outro 409 devolve null e cai no
 * texto genérico. As frases saem de chaves fixas do dicionário.
 */
export function bloqueioDaExclusao(
  details: Record<string, unknown> | undefined,
  t: (texto: string) => string,
): BloqueioDaExclusao | null {
  const agenda = details?.agenda as
    | { por_situacao?: Record<string, number>; pendentes_no_google?: number; compromisso_id?: string | null }
    | undefined;
  if (!agenda) return null;
  const porSituacao = Object.entries(agenda.por_situacao ?? {}).filter(([, n]) => n > 0);
  const visiveis = porSituacao.reduce((s, [, n]) => s + n, 0);
  const pendentes = agenda.pendentes_no_google ?? 0;
  if (visiveis < 1 && pendentes < 1) return null;

  const frases: string[] = [];
  if (visiveis > 0) {
    const rotulos = rotulosDaSituacao(t);
    const lista = porSituacao
      .map(([status, n]) => `${n} ${rotulos[status]?.[n === 1 ? 0 : 1] ?? status}`)
      .join(", ");
    frases.push(
      (visiveis === 1
        ? t("Este contato tem 1 compromisso na Agenda ({lista}).")
        : t("Este contato tem {n} compromissos na Agenda ({lista}).")
      )
        .replace("{n}", String(visiveis))
        .replace("{lista}", lista),
      t(
        "Compromisso é histórico do contato e impede a exclusão. Se esta ficha é duplicada, abra a ficha e use \"Juntar com outra ficha\": os compromissos passam para a ficha que fica. Se o compromisso foi lançado por engano, exclua-o na Agenda e tente de novo.",
      ),
    );
  }
  if (pendentes > 0) {
    frases.push(
      pendentes === 1
        ? t("1 compromisso já excluído ainda não saiu do Google Agenda. Tente de novo em alguns minutos.")
        : t("{n} compromissos já excluídos ainda não saíram do Google Agenda. Tente de novo em alguns minutos.").replace(
            "{n}",
            String(pendentes),
          ),
    );
  }
  return {
    mensagem: frases.join(" "),
    agendaHref: agenda.compromisso_id
      ? `/app/agenda?compromisso=${encodeURIComponent(agenda.compromisso_id)}`
      : "/app/agenda",
    sugerirJuntar: visiveis > 0,
  };
}

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contactId: string) =>
      apiClient.delete<unknown>(`/api/v1/contacts/${contactId}`),
    onError: (err) => {
      // O bloqueio pela Agenda é mostrado DENTRO do diálogo de exclusão, que
      // está aberto e é modal: um toast fora dele não recebe clique.
      if (err instanceof ApiError && bloqueioDaExclusao(err.details, (s) => s)) return;
      showApiError(err);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
}
