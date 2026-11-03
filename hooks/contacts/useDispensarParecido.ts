"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/**
 * "Não são a mesma pessoa": grava a dispensa do par no servidor, só gestor
 * (porte do #3640). Quem chama trata o erro (o da API já chega com código).
 */
export function useDispensarParecido() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contactIds: [string, string]) =>
      apiClient.post<{ data: { candidates: string[]; criada: boolean } }>("/api/v1/contacts/duplicates/dismiss", {
        contact_ids: contactIds,
      }),
    onSuccess: () => {
      // Sem isto, o par continuaria em "Parecidos — confira" até a próxima abertura.
      qc.invalidateQueries({ queryKey: ["contacts", "duplicates"] });
    },
  });
}
