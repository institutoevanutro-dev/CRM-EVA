/**
 * O transporte de conversões da Meta (Conversions API). Só o evento `Schedule`.
 *
 * ESTE é o único arquivo do repo, fora de `lib/channels/`, que escreve o nome
 * do endpoint de conversões da Meta.
 *
 * ─── O corpo é uma lista fechada ────────────────────────────────────────────
 *
 * `event_name`, `event_time`, `event_id`, `action_source` e `user_data` com
 * `ph`/`em` em SHA-256 e, quando houver, o `ctwa_clid`. Não há `custom_data`:
 * valor, tipo de consulta e procedimento não saem.
 *
 * ─── `action_source` depende de haver clique ────────────────────────────────
 *
 * `business_messaging` + `messaging_channel: whatsapp` é o que aceita o
 * `ctwa_clid` como identidade e liga o agendamento ao anúncio. Sem clique (o
 * caso do transporte por QR, que não recebe o `ctwa_clid`), o evento vai como
 * `chat` e a Meta tenta casar só pelo telefone hasheado.
 *
 * ─── Regras da plataforma que quebram calado ────────────────────────────────
 *
 * `event_time` em SEGUNDOS (em ms o evento cai no futuro e volta 200), e evento
 * com mais de 7 dias é recusado: o teto está aqui porque o número é da Meta.
 */
import { VERSAO_PADRAO_DA_GRAPH } from "@/lib/graph-version";
import { logger } from "@/lib/logger";
import { emailHashMeta, telefoneHashMeta } from "../identificadores";
import type {
  ConversaoDeAgendamento,
  CredencialMeta,
  ResultadoDeEnvio,
  TransporteDeConversao,
} from "../types";

const VERSAO_DA_API = VERSAO_PADRAO_DA_GRAPH;
const IDADE_MAXIMA_MS = 7 * 24 * 60 * 60 * 1000;
const TEMPO_LIMITE_MS = 10_000;

/** O corpo exato que sai. Exportado para o teste vigiar campo a campo. */
export function montarCorpoMeta(
  credencial: CredencialMeta,
  conversao: ConversaoDeAgendamento,
): Record<string, unknown> | null {
  const ph = telefoneHashMeta(conversao.telefone);
  const em = emailHashMeta(conversao.email);
  if (!ph && !em) return null;

  const userData: Record<string, unknown> = {};
  if (ph) userData.ph = [ph];
  if (em) userData.em = [em];
  if (conversao.cliqueMeta) userData.ctwa_clid = conversao.cliqueMeta;

  const evento: Record<string, unknown> = {
    event_name: conversao.evento,
    event_time: Math.floor(conversao.ocorridoEm.getTime() / 1000),
    event_id: conversao.eventoId,
    action_source: conversao.cliqueMeta ? "business_messaging" : "chat",
    user_data: userData,
  };
  if (conversao.cliqueMeta) evento.messaging_channel = "whatsapp";

  const corpo: Record<string, unknown> = { data: [evento] };
  if (credencial.testEventCode) corpo.test_event_code = credencial.testEventCode;
  return corpo;
}

/**
 * 613/80004 é cota: 4xx que se resolve sozinho. 190/102/463 é token, e o resto
 * dos 4xx pede alguém na configuração.
 */
function classifica4xx(codigo: number | null, status: number): ResultadoDeEnvio {
  if (codigo === 613 || codigo === 80004) return { tipo: "transitorio", codigo: `meta_${codigo}` };
  return { tipo: "permanente", codigo: codigo !== null ? `meta_${codigo}` : `http_${status}` };
}

async function enviar(
  credencial: CredencialMeta,
  conversao: ConversaoDeAgendamento,
): Promise<ResultadoDeEnvio> {
  if (Date.now() - conversao.ocorridoEm.getTime() > IDADE_MAXIMA_MS) {
    return { tipo: "permanente", codigo: "evento_antigo" };
  }
  const corpo = montarCorpoMeta(credencial, conversao);
  if (!corpo) return { tipo: "permanente", codigo: "sem_identificador" };

  const url =
    `https://graph.facebook.com/${VERSAO_DA_API}/` +
    `${encodeURIComponent(credencial.datasetId)}/events`;

  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // No header, nunca na query string: token em URL vaza para log de proxy.
        authorization: `Bearer ${credencial.accessToken}`,
      },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
  } catch {
    return { tipo: "transitorio", codigo: "rede" };
  }

  if (resposta.ok) {
    // Porte do upstream (#1566): 200 sem `events_received: 1` não é recebimento.
    const lido = (await resposta.json().catch(() => null)) as { events_received?: unknown } | null;
    return lido?.events_received === 1 ? { tipo: "ok" } : { tipo: "transitorio", codigo: "sem_confirmacao" };
  }

  let codigo: number | null = null;
  try {
    const json = (await resposta.json()) as { error?: { code?: unknown } };
    if (typeof json.error?.code === "number") codigo = json.error.code;
  } catch {
    // Corpo não-JSON: gateway/WAF no meio. Fica só o status.
  }

  // Sem a mensagem da plataforma: ela pode repetir o que foi enviado.
  logger.warn("[conversoes.meta] envio recusado", {
    status: resposta.status,
    codigo,
    agendamentoId: conversao.agendamentoId,
  });

  if (resposta.status === 429 || resposta.status >= 500) {
    return { tipo: "transitorio", codigo: `http_${resposta.status}` };
  }
  return classifica4xx(codigo, resposta.status);
}

export const transporteMeta: TransporteDeConversao<CredencialMeta> = {
  plataforma: "meta_ads",
  enviar,
};

/** Exportados para o teste vigiar as regras sem falar com a rede. */
export const INTERNOS = { classifica4xx, IDADE_MAXIMA_MS, VERSAO_DA_API } as const;
