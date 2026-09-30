"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { marcarReleitura } from "@/lib/audit/releitura";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Contact } from "@/lib/types/contacts";

interface ContactResponse {
  data: Contact;
  meta?: { cpf_available?: boolean };
}

export function useContact(id: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ["contact", id],
    enabled: !!id,
    queryFn: async () => {
      try {
        const qs = marcarReleitura(new URLSearchParams(), qc.getQueryData(["contact", id]) !== undefined);
        const sufixo = qs.size > 0 ? `?${qs.toString()}` : "";
        return await apiClient.get<ContactResponse>(`/api/v1/contacts/${id}${sufixo}`);
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}
