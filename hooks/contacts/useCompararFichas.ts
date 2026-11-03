"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { marcarReleitura } from "@/lib/audit/releitura";
import type { FichaParaComparar } from "@/lib/contacts/juncao";

export type { FichaParaComparar };

interface CompararResponse {
  data: { contatos: FichaParaComparar[] };
}

/**
 * As duas fichas lado a lado (porte do #3640). Só roda com um par. Sem toast:
 * quem mostra o erro é a própria comparação, com "Tentar de novo". O pai e a
 * `ComparacaoDeFichas` chamam com a mesma chave, e o react-query faz uma
 * requisição só; a recarga sai marcada e não abre outra `contact.viewed`.
 */
export function useCompararFichas(ids: [string, string] | null) {
  const qc = useQueryClient();
  const queryKey = ["contacts", "compare", ids?.[0] ?? null, ids?.[1] ?? null] as const;
  return useQuery({
    queryKey,
    enabled: ids !== null,
    refetchOnWindowFocus: false,
    queryFn: () => {
      const qs = marcarReleitura(new URLSearchParams({ ids: ids!.join(",") }), qc.getQueryData(queryKey) !== undefined);
      return apiClient.get<CompararResponse>(`/api/v1/contacts/compare?${qs.toString()}`);
    },
  });
}
