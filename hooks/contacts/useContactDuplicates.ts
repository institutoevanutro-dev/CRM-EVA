"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { marcarReleitura } from "@/lib/audit/releitura";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { MotivoDeDuplicidade } from "@/lib/contacts/duplicados";

export interface ContatoDuplicado {
  id: string;
  name: string | null;
  display_name: string | null;
  email: string | null;
  phone_number: string | null;
  created_at: string;
  last_activity_at: string | null;
}

export interface GrupoDuplicado {
  chave: string;
  motivos: MotivoDeDuplicidade[];
  principal_sugerido: string;
  contatos: ContatoDuplicado[];
}

interface DuplicatesResponse {
  data: GrupoDuplicado[];
  meta?: { varreu_tudo?: boolean; contatos_varridos?: number };
}

/**
 * A varredura só roda quando alguém abre a tela (`enabled`), e não fica
 * revalidando em foco: é uma leitura de toda a base de contatos vivos, cara o
 * bastante para não valer a pena repetir sozinha atrás de um diálogo fechado.
 *
 * A recarga depois de juntar ou dispensar sai marcada (`?atualizacao=1`): é a
 * mesma lista na tela, e não abre outra linha `contact.listed` na trilha.
 */
export function useContactDuplicates(enabled: boolean) {
  const qc = useQueryClient();
  const queryKey = ["contacts", "duplicates"] as const;
  return useQuery({
    queryKey,
    enabled,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const qs = marcarReleitura(new URLSearchParams(), qc.getQueryData(queryKey) !== undefined).toString();
      try {
        return await apiClient.get<DuplicatesResponse>(`/api/v1/contacts/duplicates${qs ? `?${qs}` : ""}`);
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}
