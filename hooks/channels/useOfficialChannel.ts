"use client";
import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { Coexistencia } from "@/lib/channels/meta/coexistencia";

export interface OfficialChannelState {
  channel_session_id?: string | null;
  connected: boolean;
  /** Existe token gravado? O token em si NUNCA volta — ver a rota. */
  hasToken: boolean;
  phoneNumberId: string | null;
  wabaId: string | null;
  displayName: string | null;
  phoneNumber: string | null;
  status: string | null;
  cadastroIncorporado?: {
    disponivel: boolean;
    appId: string | null;
    configId: string | null;
    versao: string;
    faltam: ("META_APP_ID" | "META_ES_CONFIG_ID" | "META_APP_SECRET")[];
    configurarEm: string | null;
  };
  /** `metadata.coexistencia` da sessão: pedidos de contatos/histórico e o progresso. */
  coexistencia?: Coexistencia | null;
  webhook: {
    callbackUrl: string;
    verifyToken: string | null;
    /**
     * De onde vem o token que vale. `instalacao` = cadastrado na tela de
     * administração: existe, mas não volta num GET (foi mostrado uma vez, lá).
     * Opcional: ausente é lido como desconhecido, e a tela cai no aviso genérico.
     */
    verifyTokenOrigem?: "ambiente" | "instalacao" | null;
    /** Onde se cadastra o App da Meta — só para quem pode abrir a tela da instalação. */
    configurarEm?: string | null;
    fields: string[];
    /**
     * O que a Meta respondeu quando o CRM assinou o webhook desta conta.
     * `null`/ausente = conectado antes dessa assinatura existir.
     */
    assinatura?: { assinado: boolean; motivo?: string; em: string } | null;
  } | null;
}

export interface ConnectInput {
  phone_number_id: string;
  waba_id: string;
  token: string;
}

export function useOfficialChannel() {
  const marca = useRef({ visto: "", desde: 0 });
  return useQuery({
    queryKey: ["official-channel"],
    queryFn: async () => apiClient.get<{ data: OfficialChannelState }>("/api/v1/channels/official"),
    staleTime: 15_000,
    // Enquanto o histórico entra, a barra anda sozinha.
    // Para sozinho se o progresso não muda por 30 min (celular dormindo, Meta parada).
    refetchInterval: (q) => {
      const h = q.state.data?.data.coexistencia?.historico;
      if (!h || h.concluido || h.erro_codigo) return false;
      const visto = `${h.fase}:${h.progresso}`;
      if (visto !== marca.current.visto) marca.current = { visto, desde: Date.now() };
      return Date.now() - marca.current.desde < 30 * 60_000 ? 5_000 : false;
    },
  });
}

export function useConnectOfficialChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConnectInput) =>
      apiClient.post<{
        data: {
          connected: boolean;
          displayName: string;
          phoneNumber: string | null;
          /** A Meta aceitou o endereço de recebimento desta conta? Ver a rota. */
          webhook?: { assinado: boolean; motivo?: string };
        };
      }>(
        "/api/v1/channels/official",
        input,
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["official-channel"] });
    },
  });
}

export interface CadastroIncorporadoInput {
  code: string;
  evento: string;
  waba_id: string | null;
  phone_number_id: string | null;
}

export function useCadastroIncorporado() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CadastroIncorporadoInput) =>
      apiClient.post<{
        data: {
          connected: boolean;
          displayName: string;
          phoneNumber: string | null;
          coexistencia: boolean;
          webhook?: { assinado: boolean; motivo?: string };
        };
      }>("/api/v1/channels/official/cadastro-incorporado", input),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["official-channel"] }),
  });
}

/** "Tentar de novo" do pedido de contatos/histórico (até 24 h depois da conexão). */
export function useSincronizarCoexistencia() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiClient.post<{ data: { pedidos: Coexistencia["pedidos"]; ate: string } }>(
        "/api/v1/channels/official/cadastro-incorporado/sincronizar",
        {},
      ),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["official-channel"] }),
  });
}
