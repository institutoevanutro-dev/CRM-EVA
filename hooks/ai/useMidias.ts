"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import type { SituacaoDaMidia } from "@/lib/midias/termo";

export interface VarianteDaMidia {
  key: "A" | "B";
  mime: string;
  size_bytes: number;
  url: string;
}
export interface MidiaItem {
  id: string;
  title: string;
  when_to_use: string | null;
  tags: string[];
  contains_person: boolean;
  consent_subject: string | null;
  consent_scope: string | null;
  consent_signed_at: string | null;
  consent_expires_at: string | null;
  consent_revoked_at: string | null;
  situacao: SituacaoDaMidia;
  variantes: VarianteDaMidia[];
}
export interface TermoDeUso {
  subject: string;
  scope: string;
  signed_at: string;
  expires_at: string | null;
}

const BASE = "/api/v1/ai/midias";
const KEY = ["midias"];

export function useMidias() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => apiClient.get<{ data: { itens: MidiaItem[] } }>(BASE).then((r) => r.data.itens),
  });
}

function useMutacao<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }) });
}

export function useCriarMidia() {
  return useMutacao((input: { title: string; when_to_use?: string; tags?: string[]; contains_person: boolean }) =>
    apiClient.post<{ data: { id: string } }>(BASE, input),
  );
}

export function useEditarMidia() {
  return useMutacao(
    (input: {
      id: string;
      title?: string;
      when_to_use?: string;
      tags?: string[];
      contains_person?: boolean;
      consent?: TermoDeUso;
      revogar?: true;
    }) => {
      const { id, ...corpo } = input;
      return apiClient.patch<{ data: { id: string } }>(`${BASE}/${id}`, corpo);
    },
  );
}

export function useApagarMidia() {
  return useMutacao((id: string) => apiClient.delete<unknown>(`${BASE}/${id}`));
}

export function useSubirArquivo() {
  return useMutacao(async (input: { id: string; variante: "A" | "B"; arquivo: File }) => {
    // multipart: o apiClient só fala JSON, então o fetch é direto e o erro vira ApiError como nos demais.
    const form = new FormData();
    form.set("variante", input.variante);
    form.set("arquivo", input.arquivo);
    const res = await fetch(`${BASE}/${input.id}/arquivo`, { method: "POST", body: form });
    if (!res.ok) {
      const corpo = (await res.json().catch(() => null)) as {
        error?: { code?: string; message?: string; details?: Record<string, unknown> };
      } | null;
      throw new ApiError(
        res.status,
        corpo?.error?.code ?? "unknown",
        corpo?.error?.details,
        res.headers.get("x-request-id") ?? "",
        corpo?.error?.message,
      );
    }
    return res.json() as Promise<unknown>;
  });
}

export function useRemoverArquivo() {
  return useMutacao((input: { id: string; variante: "A" | "B" }) =>
    apiClient.delete<unknown>(`${BASE}/${input.id}/arquivo?variante=${input.variante}`),
  );
}
