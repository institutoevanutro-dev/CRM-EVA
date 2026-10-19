/**
 * O que a TELA de Conversões precisa saber — e nada além.
 *
 * ⚠️ NENHUM SEGREDO SAI DAQUI. A leitura devolve SE existe token gravado, nunca
 * o valor: o campo de segredo volta vazio e "vazio" significa "mantenha".
 *
 * ⚠️ NENHUM DADO DE PACIENTE TAMBÉM. A lista de envios mostra plataforma,
 * situação, motivo, código e horário, e um link para o compromisso — quem abre
 * o link passa pela permissão da Agenda.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { PlataformaDeAnuncio } from "@/lib/plataformas-de-anuncio/types";
import { lerPreferencias, type PreferenciasDeConversao } from "./preferencias";

export interface EstadoMeta {
  datasetId: string | null;
  temToken: boolean;
  habilitada: boolean;
  testEventCode: string | null;
}

export interface EstadoGoogle {
  customerId: string | null;
  loginCustomerId: string | null;
  conversionActionId: string | null;
  clientId: string | null;
  temClientSecret: boolean;
  temRefreshToken: boolean;
  temDeveloperToken: boolean;
  habilitada: boolean;
}

export interface EnvioDeAgendamento {
  agendamentoId: string;
  plataforma: PlataformaDeAnuncio;
  status: string;
  motivo: string | null;
  codigo: string | null;
  tentativas: number;
  tentadoEm: string;
}

export interface EstadoDasConversoes {
  meta: EstadoMeta;
  google: EstadoGoogle;
  preferencias: PreferenciasDeConversao;
  envios: EnvioDeAgendamento[];
  enviados: number;
}

export async function lerEstadoDasConversoes(
  admin: SupabaseClient,
  organizationId: string,
): Promise<EstadoDasConversoes> {
  const [conexoes, org, envios, enviados] = await Promise.all([
    admin
      .from("ad_platform_connections")
      // Os bytea entram só para virar booleano aqui dentro; o valor morre nesta função.
      .select(
        "platform, enabled, dataset_id, test_event_code, access_token_encrypted, google_customer_id, " +
          "google_login_customer_id, google_conversion_action_id, google_oauth_client_id, " +
          "google_oauth_client_secret_encrypted, google_refresh_token_encrypted, google_developer_token_encrypted",
      )
      .eq("organization_id", organizationId),
    admin.from("organizations").select("settings").eq("id", organizationId).maybeSingle(),
    admin
      .from("ad_conversion_dispatches")
      .select("appointment_id, platform, status, reason, error_code, attempts, attempted_at")
      .eq("organization_id", organizationId)
      .not("appointment_id", "is", null)
      .order("attempted_at", { ascending: false })
      .limit(20),
    admin
      .from("ad_conversion_dispatches")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .not("appointment_id", "is", null)
      .eq("status", "sent"),
  ]);

  const linhas = (conexoes.data ?? []) as unknown as Record<string, unknown>[];
  const meta = linhas.find((l) => l.platform === "meta_ads") ?? {};
  const google = linhas.find((l) => l.platform === "google_ads") ?? {};
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);

  return {
    meta: {
      datasetId: s(meta.dataset_id),
      temToken: Boolean(meta.access_token_encrypted),
      habilitada: meta.enabled === true,
      testEventCode: s(meta.test_event_code),
    },
    google: {
      customerId: s(google.google_customer_id),
      loginCustomerId: s(google.google_login_customer_id),
      conversionActionId: s(google.google_conversion_action_id),
      clientId: s(google.google_oauth_client_id),
      temClientSecret: Boolean(google.google_oauth_client_secret_encrypted),
      temRefreshToken: Boolean(google.google_refresh_token_encrypted),
      temDeveloperToken: Boolean(google.google_developer_token_encrypted),
      habilitada: google.enabled === true,
    },
    preferencias: lerPreferencias((org.data as { settings?: unknown } | null)?.settings),
    envios: ((envios.data ?? []) as Record<string, unknown>[]).map((l) => ({
      agendamentoId: String(l.appointment_id),
      plataforma: l.platform as PlataformaDeAnuncio,
      status: String(l.status),
      motivo: s(l.reason),
      codigo: s(l.error_code),
      tentativas: Number(l.attempts ?? 0),
      tentadoEm: String(l.attempted_at),
    })),
    enviados: enviados.count ?? 0,
  };
}

/** O texto que o operador lê. O banco guarda slug; cada motivo diz o que fazer. */
export const MOTIVO_LEGIVEL: Record<string, string> = {
  tentando_de_novo: "A plataforma não respondeu. O sistema tenta de novo sozinho, com espera crescente.",
  recusado_pela_plataforma:
    "A plataforma recusou. Confira o identificador, o token e a ação de conversão no formulário acima.",
  sem_resposta: "A plataforma não respondeu depois de várias tentativas. Confira a conexão.",
  agendamento_cancelado: "O agendamento foi cancelado antes do envio. Nada foi enviado.",
  fora_da_origem: "O paciente não veio de anúncio desta plataforma. Nada foi enviado.",
  sem_conexao: "Nenhuma conta conectada para esta plataforma. Nada foi enviado.",
  conexao_desabilitada: "O envio estava desligado. Nada foi enviado.",
  credencial_incompleta: "Falta algum dado da conexão. Complete o formulário acima.",
  cifra_indisponivel:
    "Esta instalação está sem a chave mestra de criptografia. Quem instalou o sistema precisa configurá-la; refazer o cadastro não resolve.",
  contato_bloqueado: "O contato está bloqueado. Nada foi enviado.",
  sempre_atendimento_humano: "O contato está marcado como sempre atendimento humano. Nada foi enviado.",
  contato_oculto: "O contato está oculto. Nada foi enviado.",
  contato_anonimizado: "O contato foi anonimizado. Nada foi enviado.",
  contato_fundido: "O contato foi juntado a outro. Nada foi enviado.",
};

export const STATUS_LEGIVEL: Record<string, string> = {
  sent: "Enviado",
  sending: "Enviando",
  pending: "Aguardando nova tentativa",
  skipped: "Não enviado",
  error: "Falhou",
};
