/**
 * A CÓPIA da ocupação da Clinicorp para a Agenda — um lugar só, que o cron e o
 * botão "Copiar agora" chamam.
 *
 * Lê `GET /appointment/list` (HTTP Basic: "Usuário API" e "Token API") do dia de
 * hoje até `DIAS_COPIADOS` à frente, em blocos, com agendamentos, compromissos,
 * desmarcados e excluídos — os dois últimos para LIBERAR o horário que já tinha
 * sido copiado. Reduz cada item a intervalo (`lerAgendaDaClinicorp`) e grava por
 * `fn_agenda_clinicorp_gravar` (migration 0433).
 *
 * ⚠️ DADO DE PACIENTE. A resposta traz nome, telefone, e-mail e observação. Este
 * arquivo nunca registra o corpo, nunca o põe em erro, e o que guarda de falha é
 * texto NOSSO (`MOTIVOS`). O token também nunca sai daqui: vai só no cabeçalho.
 *
 * ⚠️ SERVICE ROLE. O `admin` vem de quem chama (cron ou rota de gestor); toda
 * consulta filtra `organization_id`, resolvido de fonte confiável por quem chama.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { diaLocalISO } from "@/lib/agenda/fuso";
import { env } from "@/lib/env";
import { fusoUtilizavel } from "@/lib/tempo/fusos";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { jsonComIdsGrandes, lerAgendaDaClinicorp, lerProfissionaisDaClinicorp } from "./item";

/** Quantos dias à frente a cópia cobre. Acima do teto de uma consulta do motor (62). */
export const DIAS_COPIADOS = 90;
/** O tamanho de cada pedido à Clinicorp. A API não documenta limite de período. */
const DIAS_POR_PEDIDO = 30;
const TEMPO_MAXIMO_MS = 20_000;
/** A cópia do passado não serve ao motor; some depois disto. */
const GUARDA_DO_PASSADO_DIAS = 30;

export const MOTIVOS = {
  credencial: "A Clinicorp recusou o Usuário API ou o Token API. Confira e salve de novo.",
  indisponivel: "A Clinicorp não respondeu. A cópia tenta de novo sozinha.",
  formato: "A Clinicorp respondeu num formato que o CRM não reconhece.",
  token_ilegivel: "Não consegui ler o Token API guardado. Salve a credencial de novo.",
  gravacao: "Não consegui gravar a cópia no banco.",
} as const;

export type ResultadoDaCopia =
  | { ok: true; itens: number; gravados: number; profissionais: number }
  | { ok: false; motivo: keyof typeof MOTIVOS | "nao_configurada"; erroAnterior: string | null };

class FalhaDaClinicorp extends Error {
  constructor(readonly motivo: keyof typeof MOTIVOS) {
    super(motivo);
  }
}

const baseDaApi = () => (env.CLINICORP_API_URL?.trim() || "https://api.clinicorp.com/rest/v1").replace(/\/+$/, "");

async function pedir(
  credencial: { usuario: string; token: string; assinante: string | null },
  caminho: string,
  parametros: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const url = new URL(`${baseDaApi()}${caminho}`);
  for (const [k, v] of Object.entries(parametros)) url.searchParams.set(k, v);
  if (credencial.assinante) url.searchParams.set("subscriber_id", credencial.assinante);
  let resposta: Response;
  try {
    resposta = await fetchImpl(url, {
      headers: {
        authorization: `Basic ${Buffer.from(`${credencial.usuario}:${credencial.token}`).toString("base64")}`,
        accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(TEMPO_MAXIMO_MS),
    });
  } catch {
    throw new FalhaDaClinicorp("indisponivel");
  }
  if (resposta.status === 401 || resposta.status === 403) throw new FalhaDaClinicorp("credencial");
  if (!resposta.ok) throw new FalhaDaClinicorp("indisponivel");
  try {
    return jsonComIdsGrandes(await resposta.text());
  } catch {
    throw new FalhaDaClinicorp("formato");
  }
}

/** `YYYY-MM-DD` somado de `dias` — aritmética de DIAS, ancorada ao meio-dia UTC. */
const somarDias = (dia: string, dias: number): string => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

export async function copiarDaClinicorp(
  admin: SupabaseClient,
  organizationId: string,
  opcoes: { agora?: Date; fetchImpl?: typeof fetch } = {},
): Promise<ResultadoDaCopia> {
  const agora = opcoes.agora ?? new Date();
  const fetchImpl = opcoes.fetchImpl ?? fetch;

  const [{ data: integracao }, { data: org }] = await Promise.all([
    admin
      .from("calendar_clinicorp_integrations")
      .select("api_user, api_token_encrypted, subscriber_id, last_sync_error")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    admin.from("organizations").select("timezone").eq("id", organizationId).maybeSingle(),
  ]);
  // Só de webhook (0434): a linha existe, mas sem credencial não há o que pedir à API.
  if (!integracao?.api_token_encrypted) return { ok: false, motivo: "nao_configurada", erroAnterior: null };
  const erroAnterior = (integracao.last_sync_error as string | null) ?? null;

  const registrarFalha = async (motivo: keyof typeof MOTIVOS): Promise<ResultadoDaCopia> => {
    await admin
      .from("calendar_clinicorp_integrations")
      .update({ last_sync_error: MOTIVOS[motivo], updated_at: new Date().toISOString() })
      .eq("organization_id", organizationId);
    return { ok: false, motivo, erroAnterior };
  };

  const token = await decryptWebhookSecret(admin, String(integracao.api_token_encrypted));
  if (!token) return registrarFalha("token_ilegivel");
  const credencial = {
    usuario: String(integracao.api_user),
    token,
    assinante: (integracao.subscriber_id as string | null) ?? null,
  };
  const fuso = fusoUtilizavel((org as { timezone?: string | null } | null)?.timezone);

  try {
    const hoje = diaLocalISO(agora, fuso);
    const ocupacoes = [];
    for (let desde = 0; desde < DIAS_COPIADOS; desde += DIAS_POR_PEDIDO) {
      const resposta = await pedir(
        credencial,
        "/appointment/list",
        {
          from: somarDias(hoje, desde),
          to: somarDias(hoje, Math.min(desde + DIAS_POR_PEDIDO, DIAS_COPIADOS) - 1),
          includeAssigns: "X",
          includeCanceled: "X",
          includeDeleted: "X",
        },
        fetchImpl,
      );
      try {
        ocupacoes.push(...lerAgendaDaClinicorp(resposta, fuso).ocupacoes);
      } catch {
        throw new FalhaDaClinicorp("formato");
      }
    }

    // O nome do profissional é conforto da tela de mapeamento: falhar aqui não
    // derruba a cópia, que já tem o id de quem ocupa.
    let profissionais: Array<{ professional_id: string; name: string | null }> = [];
    try {
      profissionais = lerProfissionaisDaClinicorp(
        await pedir(credencial, "/professional/list_all_professionals", {}, fetchImpl),
      );
    } catch {
      profissionais = [];
    }

    let gravados = 0;
    for (let i = 0; i < ocupacoes.length; i += 500) {
      const { data, error } = await admin.rpc("fn_agenda_clinicorp_gravar", {
        p_org: organizationId,
        p_itens: ocupacoes.slice(i, i + 500),
      });
      if (error) return registrarFalha("gravacao");
      gravados += Number(data ?? 0);
    }
    if (profissionais.length > 0) {
      const { error } = await admin.from("calendar_clinicorp_professionals").upsert(
        profissionais.map((p) => ({ organization_id: organizationId, ...p })),
        { onConflict: "organization_id,professional_id" },
      );
      if (error) return registrarFalha("gravacao");
    }

    await admin
      .from("calendar_clinicorp_events")
      .delete()
      .eq("organization_id", organizationId)
      .lt("ends_at", new Date(agora.getTime() - GUARDA_DO_PASSADO_DIAS * 86_400_000).toISOString());
    await admin
      .from("calendar_clinicorp_integrations")
      .update({ last_sync_at: agora.toISOString(), last_sync_error: null, updated_at: agora.toISOString() })
      .eq("organization_id", organizationId);

    return { ok: true, itens: ocupacoes.length, gravados, profissionais: profissionais.length };
  } catch (erro) {
    if (erro instanceof FalhaDaClinicorp) return registrarFalha(erro.motivo);
    throw erro;
  }
}
