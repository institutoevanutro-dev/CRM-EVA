"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { useRefetchDeSeguranca } from "@/hooks/realtime/useRefetchDeSeguranca";

import type { Agendamento } from "@/components/agenda/tipos";

import type { RecorteDaGrade } from "./useAgendamentos";

/**
 * A AGENDA SE ATUALIZA SOZINHA (achado 2 da auditoria de 16/11).
 *
 * Consulta marcada pela IA no WhatsApp ou por um colega só aparecia depois de
 * recarregar: não havia realtime, nem recarga periódica, e "recarregar ao
 * voltar para a aba" é desligado no app inteiro (`lib/query/client.ts`).
 *
 * O padrão é o do funil (`hooks/kanban/useBoard.ts`), em duas peças:
 *
 *  1. O CANAL: `calendar_appointments` já está na publicação `supabase_realtime`
 *     (migration 0183). Qualquer mudança da organização invalida `["agenda"]`
 *     inteiro — grade, horários livres, detalhe e histórico releem, e um
 *     horário recém-ocupado pela IA deixa de ser oferecido aqui.
 *  2. A REDE DE SEGURANÇA (`useRefetchDeSeguranca`, a cada 30 s e ao voltar
 *     para a aba): cobre o que o canal não traz — o DELETE (só leva o id, e o
 *     filtro por organização não o casa), a ocupação do Google e os bloqueios,
 *     que não moram nesta tabela — e um canal que morreu calado.
 */
export function useAgendaAoVivo(recorte: RecorteDaGrade | null) {
  const qc = useQueryClient();
  const orgId = useActiveOrg()?.orgId ?? null;

  const onChange = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["agenda"] });
  }, [qc]);

  const { status, ultimaEntrega } = useRealtimeChannel({
    name: orgId ? `agenda-${orgId}` : "agenda-disabled",
    postgresChanges: orgId
      ? { event: "*", schema: "public", table: "calendar_appointments", filter: `organization_id=eq.${orgId}` }
      : undefined,
    onChange,
    enabled: !!orgId,
  });

  // Chave memoizada: array novo a cada render refazia o intervalo de 30 s do refetch de segurança.
  const queryKey = useMemo(() => ["agenda", "agendamentos", recorte] as const, [recorte]);
  const seguranca = useRefetchDeSeguranca<Agendamento[]>({
    queryKey,
    assinatura: (lista) =>
      (lista ?? [])
        .map((a) => `${a.id}:${a.revision ?? ""}:${a.comeca}:${a.situacao}`)
        .sort()
        .join("|"),
    ultimaEntrega,
    intervaloMs: 30_000,
    enabled: recorte !== null,
  });

  return { status, seguranca };
}
