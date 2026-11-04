"use client";
/**
 * O botão "Enviar ao prontuário" (Exames do WhatsApp → Prontuário).
 *
 * - Barreira do duplo clique num `ref` SÍNCRONO: o estado só chega ao botão
 *   depois do segundo clique (mesma lição de `useEncaminharMensagem`).
 * - `emVoo` e `ultimoErro` em ESTADO, trocados por cópia: ref não redesenha a
 *   tela, e o "Enviando…" e o erro embaixo do botão precisam aparecer.
 * - O erro vai ao toast E fica no balão até a próxima tentativa: o toast some
 *   em 4 s, e a recepção precisa ler a frase.
 * - 45 s de prazo: o servidor tem até 40 s com a nova tentativa ao Prontuário.
 */
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import type { Message, SeloDoProntuario } from "@/lib/types/messaging";

interface Resposta {
  data: { message_id: string } & SeloDoProntuario;
}
type Pagina = { data: Message[] };

export function useEnviarAoProntuario(conversationId: string | null) {
  const qc = useQueryClient();
  const t = useT();
  const travados = useRef(new Set<string>());
  const [emVoo, setEmVoo] = useState<ReadonlySet<string>>(() => new Set());
  const [ultimoErro, setUltimoErro] = useState<ReadonlyMap<string, string>>(() => new Map());

  const enviar = useCallback(
    async (m: Message) => {
      if (travados.current.has(m.id)) return;
      travados.current.add(m.id);
      setEmVoo((s) => new Set(s).add(m.id));
      setUltimoErro((e) => {
        if (!e.has(m.id)) return e;
        const n = new Map(e);
        n.delete(m.id);
        return n;
      });
      try {
        const r = await apiClient.post<Resposta>(`/api/v1/messages/${m.id}/prontuario`, null, { timeoutMs: 45_000 });
        const selo: SeloDoProntuario = {
          ja_existia: r.data.ja_existia,
          enviado_em: r.data.enviado_em,
          enviado_por_user_id: r.data.enviado_por_user_id,
        };
        qc.setQueryData<InfiniteData<Pagina>>(["messages", conversationId], (old) =>
          old
            ? { ...old, pages: old.pages.map((p) => ({ ...p, data: p.data.map((x) => (x.id === m.id ? { ...x, prontuario_exame: selo } : x)) })) }
            : old,
        );
        if (r.data.ja_existia) toast.success(t("Este exame já estava no prontuário."));
        else toast.success(t("Exame enviado ao prontuário."));
      } catch (err) {
        showApiError(err);
        const frase = err instanceof ApiError ? t(err.message) : t("Erro inesperado. Tente novamente.");
        setUltimoErro((e) => new Map(e).set(m.id, frase));
      } finally {
        travados.current.delete(m.id);
        setEmVoo((s) => {
          const n = new Set(s);
          n.delete(m.id);
          return n;
        });
        void qc.invalidateQueries({ queryKey: ["messages", conversationId] });
      }
    },
    [qc, t, conversationId],
  );

  return { enviar, emVoo, ultimoErro };
}
