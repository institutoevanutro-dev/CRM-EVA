/**
 * O PEDIDO QUE NINGUÉM DECIDIU LIBERA O HORÁRIO.
 *
 * Um tipo de agendamento com `requires_confirmation` cria o compromisso em
 * `pending`, e `pending` OCUPA o horário — medido: o slot some da lista de
 * livres e uma segunda marcação no mesmo horário é recusada com
 * `agenda_horario_indisponivel`. É a garantia que faz o modo "o cliente pede, uma
 * pessoa confirma" funcionar: entre o pedido e a conferência, ninguém mais leva
 * aquele horário.
 *
 * O que faltava é o outro lado dessa garantia. Sem expiração, **indecisão vira
 * horário travado para sempre**: o pedido que ninguém abriu segura a agenda por
 * semanas, e o efeito é indistinguível de agenda cheia — o próximo cliente ouve
 * "não tenho horário" por causa de um pedido abandonado.
 *
 * ═══ O PRAZO É EM HORAS, E NÃO "A VIRADA DO DIA" ═══
 *
 * A especificação de origem dizia "expira na virada do dia". Não segui, e o
 * motivo é medido: aquela regra vinha de duas migrations que **nunca foram
 * aplicadas** no sistema de origem — ela nunca rodou, então não há comportamento
 * a preservar, só uma escolha a fazer.
 *
 * E ela tem um defeito que só aparece no uso: um pedido feito às 23h expiraria
 * em uma hora, de madrugada, antes de qualquer pessoa acordar para decidir. O
 * prazo em horas trata todo pedido igual, independentemente da hora em que
 * chegou.
 *
 * `pending_expires_after_minutes` é por organização, com default de 24h — quem
 * confere a fila uma vez por dia não perde nada.
 *
 * ═══ DESDE QUANDO O PRAZO CONTA ═══
 *
 * De quando o compromisso FICOU pendente (`revision_started_at`), e não de
 * quando foi criado. A história e a regra estão em
 * `lib/agenda/expiracao-de-pendentes.ts`: com `created_at`, uma consulta antiga
 * que voltasse a `pending` já nascia vencida.
 *
 * ═══ POR ONDE O CANCELAMENTO PASSA ═══
 *
 * Pelo MESMO caminho de um cancelamento feito por uma pessoa:
 * `cancelarAgendamentoHandler`, que chama `fn_appointment_change`. Aqui havia
 * um UPDATE cru de `status` sem `cancelled_at`, e a constraint
 * `calendar_appointments_cancelamento_coerente` recusava o lote INTEIRO: esta
 * rota nunca conseguiu expirar nada, e cada rodada com algo a expirar só
 * deixava "update falhou" no log.
 *
 * O caminho comum grava `cancelled_at`, encerra o follow-up preso àquele
 * compromisso, resolve os avisos abertos dele na Central, registra a linha na
 * timeline do negócio e audita na organização. E confere a REVISÃO lida aqui:
 * se alguém confirmou ou remarcou entre a leitura e a escrita, a revisão mudou
 * e o banco recusa (PT409, a recusa permanente desde a 0358). É a segunda barreira; a primeira é o filtro.
 *
 * Uma linha por vez, de propósito: uma linha que falha não derruba as outras.
 *
 * ═══ O QUE ESTA ROTA NÃO FAZ ═══
 *
 * **Não fala com o cliente.** Expirar é operação interna: a pessoa pediu, não
 * confirmaram, e o horário voltou para a prateleira. Por isso o gatilho de
 * automação `appointment.cancelled` NÃO é emitido aqui (`semGatilho`): uma regra
 * "avise quem foi desmarcado" mandaria WhatsApp por uma decisão que ninguém
 * tomou. ⚠️ Uma saída continua existindo e não é desta rota: se o pedido já
 * estava no Google Agenda com o e-mail do cliente como convidado, o Google
 * avisa o convidado quando o evento é removido.
 *
 * **Não fecha o caso.** O pedido do cliente vive em `agent_cases`, que é outra
 * coisa: quem confere continua vendo que alguém pediu horário, e pode remarcar.
 * O que expira é a RESERVA, não o pedido.
 *
 * **Não toca no que já foi decidido.** Só `pending`. `confirmed`, `cancelled`,
 * `completed` e `no_show` estão fora do filtro, e o cancelamento repete a guarda
 * (`apenasSeStatus` + revisão).
 *
 * **Não mexe no passado.** Só compromisso que ainda vai acontecer: o que já
 * passou não segura horário de ninguém, e "cancelar" depois da hora reescreveria
 * a história (e avisaria o convidado do Google de um evento que já foi). A
 * agenda importada (`historical_import`) fica de fora duas vezes: pelo filtro e
 * pelo trigger `trg_aaa_appointment_history_guard`, que recusa mudar o status.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { cancelarAgendamentoHandler } from "@/app/api/v1/agenda/agendamentos/_handler";
import { pendentesVencidos, type PendenteExaminado } from "@/lib/agenda/expiracao-de-pendentes";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { agendaSettingsSchema } from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Teto de LEITURA por rodada. A varredura roda a cada 15 min; sobra volta na seguinte. */
const LIMITE_DA_VARREDURA = 500;

/**
 * Teto de CANCELAMENTOS por rodada. Pedido abandonado é raro: uma rodada que
 * quer cancelar dezenas de uma vez é mais provavelmente um engano (foi assim em
 * 12/10/2026) do que rotina. O teto não impede o engano, mas o torna lento e
 * barulhento: o resto espera a rodada seguinte e a rodada grita no log.
 */
export const TETO_DE_EXPIRACOES_POR_RODADA = 20;

export const MOTIVO_DA_EXPIRACAO = "Pedido expirado: ninguém confirmou dentro do prazo.";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const fornecido = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const aceitos = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (aceitos.length === 0 || !fornecido || !aceitos.includes(fornecido)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();

  // O prazo é POR ORGANIZAÇÃO, então a varredura não pode usar um corte único
  // no SQL. Busca os pendentes de todas as orgs e aplica o prazo de cada uma:
  // o volume é pequeno por construção (pendente é estado curto). Os mais
  // antigos primeiro, para o teto nunca deixar o mesmo pedido para trás.
  const { data, error } = await admin
    .from("calendar_appointments")
    .select("id, organization_id, revision, revision_started_at")
    .eq("status", "pending")
    .neq("source", "historical_import")
    .gt("starts_at", agora.toISOString())
    .order("revision_started_at", { ascending: true })
    .limit(LIMITE_DA_VARREDURA);

  if (error) {
    logger.error("[agenda-expira-pendentes] consulta falhou", { error: error.message, requestId });
    return fail("internal_error", "Falha ao buscar pendentes.", 500, { requestId });
  }

  const linhas = (data ?? []) as PendenteExaminado[];
  const vazio = { examinados: linhas.length, expirados: 0, mantidos: linhas.length, adiados: 0, mudaram: 0, falhas: 0 };
  if (linhas.length === 0) return ok(vazio, { requestId });

  // Um SELECT por organização presente, não um por linha.
  const orgs = [...new Set(linhas.map((l) => l.organization_id))];
  const { data: configs } = await admin
    .from("organizations")
    .select("id, settings")
    .in("id", orgs);

  const prazoPorOrg = new Map<string, number>();
  for (const o of configs ?? []) {
    const s = (o.settings as { agenda?: unknown } | null)?.agenda;
    prazoPorOrg.set(o.id, agendaSettingsSchema.parse(s ?? {}).pending_expires_after_minutes);
  }

  const vencidos = pendentesVencidos(linhas, prazoPorOrg, agora.getTime());
  if (vencidos.length === 0) return ok(vazio, { requestId });

  const daVez = vencidos.slice(0, TETO_DE_EXPIRACOES_POR_RODADA);
  const adiados = vencidos.length - daVez.length;

  let expirados = 0;
  let falhas = 0;
  let mudaram = 0;
  const porOrganizacao: Record<string, number> = {};
  for (const linha of daVez) {
    try {
      // `organization_id` é o da PRÓPRIA linha, e o handler filtra por ele em
      // toda leitura e escrita (service role ignora RLS).
      const r = await cancelarAgendamentoHandler(
        admin,
        {
          organization_id: linha.organization_id,
          // O ator que esta base dá ao que nasce de worker (mesmo de `agenda-reminder`).
          actor: { type: "webhook_source", id: linha.id },
          requestId,
        },
        { id: linha.id, revision: Number(linha.revision), reason: MOTIVO_DA_EXPIRACAO },
        { apenasSeStatus: "pending", semGatilho: true },
      );
      // `ja_estava`: alguém cancelou no intervalo. Não foi esta rodada.
      if (r.ja_estava) continue;
      expirados += 1;
      porOrganizacao[linha.organization_id] = (porOrganizacao[linha.organization_id] ?? 0) + 1;
    } catch (err) {
      // 409 é o caso BOM: alguém confirmou, remarcou ou decidiu entre a leitura
      // e a escrita, e a guarda (status + revisão) recusou. Não é falha.
      if (err instanceof ApiError && err.status === 409) {
        mudaram += 1;
        continue;
      }
      // A linha fica como está e as outras seguem.
      falhas += 1;
      logger.warn("[agenda-expira-pendentes] pedido não expirado", {
        appointment_id: linha.id,
        organization_id: linha.organization_id,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
    }
  }

  const resumo = {
    examinados: linhas.length,
    expirados,
    mantidos: linhas.length - vencidos.length,
    adiados,
    mudaram,
    falhas,
  };

  if (adiados > 0) {
    logger.error("[agenda-expira-pendentes] teto da rodada atingido: confira se os pedidos vencidos são reais", {
      ...resumo,
      teto: TETO_DE_EXPIRACOES_POR_RODADA,
      requestId,
    });
  }

  // Rodada que não expirou nada NÃO é mutação e não audita: a lei está no
  // CLAUDE.md §Audit log, e `cron-audita-so-quando-ha-efeito.test.ts` varre o
  // AST desta pasta atrás de `audit` incondicional. Cada cancelamento também
  // deixa a própria linha (`agenda.appointment_cancelled`) na organização dele.
  if (expirados > 0) {
    logger.info("[agenda-expira-pendentes] pedidos expirados", { ...resumo, por_organizacao: porOrganizacao, requestId });
    await audit({
      action: "agenda.pendente_expirado",
      resourceType: "calendar_appointment",
      requestId,
      metadata: { ...resumo, por_organizacao: porOrganizacao },
    });
  }

  // Nada saiu e tudo o que tentou falhou: a rodada responde erro, para o
  // agendador enxergar. Falha parcial responde 200 com a contagem.
  if (expirados === 0 && falhas > 0) {
    return fail("internal_error", "Nenhum pedido vencido pôde ser expirado.", 500, { requestId });
  }

  return ok(resumo, { requestId });
}

export const GET = handle;
export const POST = handle;
