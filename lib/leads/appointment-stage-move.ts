import { observeServiceOrigin } from "@/lib/atendimento/origem";
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { emitLeadActivity, stageChangeReason } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import type { Transicao } from "@/lib/agenda/laco";

/**
 * Espelha a transição de um agendamento (`calendar_appointments.status`) no
 * funil do CRM — MESMO padrão opt-in de `handoff-stage-move.ts`: a ponte é o
 * `slug` da etapa, e pipeline sem a etapa correspondente não muda de
 * comportamento nenhum (`sem_etapa_mapeada`, igual a `sem_etapa_de_handoff`).
 *
 * TRÊS transições avançam o card: `pending`, `confirmed` e `completed`
 * (compareceu). `rescheduled`, `cancelled` e `no_show` seguem fora do mapa, de
 * propósito: cancelar ou faltar a UM compromisso não é o negócio esfriando — o
 * cliente pode remarcar, e quem decide que o negócio morreu continua sendo o
 * agente (`crm_stages.agent_stage_hint = 'lost'`) ou um humano arrastando o
 * card, nunca o agendamento sozinho. Comparecer é o oposto: é o fato que a
 * clínica espera, e o funil que tem a etapa `compareceu` quer o card nela.
 *
 * ⚠️ SÓ PARA FRENTE. O mapa sozinho levava o card para TRÁS: um negócio em
 * "Comprovante em conferência" voltaria para "Agendado" quando a recepção
 * confirmasse o horário depois. A régua é a `position` da etapa — a mesma ordem
 * que o quadro mostra —, e destino na mesma posição ou antes da etapa atual é
 * `etapa_anterior`, sem movimento.
 *
 * ⚠️ NEGÓCIO FECHADO. Perdido nunca se mexe pela agenda. Ganho só vai para
 * outra etapa de GANHO à frente: é a clínica que fecha no sinal e quer o card
 * em `compareceu` quando o paciente vem. Levar um ganho para etapa aberta
 * reabriria o negócio, e isso continua sendo decisão de gente.
 *
 * Medido no Instituto em 25/11/2026: o funil guardava os slugs do modelo de
 * loja, esta função devolvia `sem_etapa_mapeada` em silêncio, e cerca de 50
 * pacientes com consulta marcada ou já atendidos seguiam em "Novo lead".
 */
export const SLUG_ETAPA_POR_TRANSICAO: Partial<Record<Transicao, string>> = {
  pending: "agendamento-solicitado",
  confirmed: "agendado",
  completed: "compareceu",
};

export interface ResultadoDoMovimentoDeAgendamento {
  moveu: boolean;
  motivo:
    | "movido"
    | "transicao_nao_mapeada"
    | "sem_etapa_mapeada"
    | "ja_esta_la"
    | "etapa_anterior"
    | "lead_nao_encontrado"
    | "lead_fechado"
    | "conflito_humano"
    | "falha_de_escrita"
    | "indisponivel";
}

export async function moverLeadParaEtapaDeAgendamento(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    leadId: string;
    transicao: Transicao;
  },
): Promise<ResultadoDoMovimentoDeAgendamento> {
  const slugAlvo = SLUG_ETAPA_POR_TRANSICAO[input.transicao];
  if (!slugAlvo) {
    return { moveu: false, motivo: "transicao_nao_mapeada" };
  }

  const { data: lead, error: erroLead } = await admin
    .from("crm_leads")
    .select("id, pipeline_id, stage_id, contact_id, status")
    .eq("id", input.leadId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (erroLead) {
    logger.warn("[appointment-stage-move] leitura do lead falhou", {
      lead_id: input.leadId,
      organization_id: input.organizationId,
      error: erroLead.message,
    });
    return { moveu: false, motivo: "indisponivel" };
  }
  if (!lead) {
    return { moveu: false, motivo: "lead_nao_encontrado" };
  }
  const leadRow = lead as {
    id: string;
    pipeline_id: string;
    stage_id: string;
    contact_id: string | null;
    status: string;
  };

  // Perdido não volta a se mexer por causa de um agendamento — moveria um card
  // que a organização já considera encerrado. O ganho espera o destino: ele só
  // segue para outra etapa de ganho (ver cabeçalho).
  if (leadRow.status !== "open" && leadRow.status !== "won") {
    return { moveu: false, motivo: "lead_fechado" };
  }

  const { data: etapaData, error: erroEtapa } = await admin
    .from("crm_stages")
    .select("id, name, position, is_won")
    .eq("pipeline_id", leadRow.pipeline_id)
    .eq("slug", slugAlvo)
    .eq("is_archived", false)
    .maybeSingle();
  if (erroEtapa) {
    logger.warn("[appointment-stage-move] leitura da etapa alvo falhou", {
      lead_id: leadRow.id,
      organization_id: input.organizationId,
      error: erroEtapa.message,
    });
    return { moveu: false, motivo: "indisponivel" };
  }
  let etapa = etapaData;
  if (!etapa && slugAlvo.includes("-")) {
    const { data: etapaLegada, error: erroLegada } = await admin
      .from("crm_stages")
      .select("id, name, position, is_won")
      .eq("pipeline_id", leadRow.pipeline_id)
      .eq("slug", slugAlvo.replace(/-/g, "_"))
      .eq("is_archived", false)
      .maybeSingle();
    if (erroLegada) {
      logger.warn("[appointment-stage-move] leitura da etapa alvo (slug legado) falhou", {
        lead_id: leadRow.id,
        organization_id: input.organizationId,
        error: erroLegada.message,
      });
      return { moveu: false, motivo: "indisponivel" };
    }
    if (etapaLegada) {
      etapa = etapaLegada;
    }
  }
  if (!etapa) {
    return { moveu: false, motivo: "sem_etapa_mapeada" };
  }
  const etapaRow = etapa as { id: string; name: string; position: number | string; is_won: boolean };

  if (leadRow.status === "won" && etapaRow.is_won !== true) {
    return { moveu: false, motivo: "lead_fechado" };
  }

  if (leadRow.stage_id === etapaRow.id) {
    return { moveu: false, motivo: "ja_esta_la" };
  }

  // A origem decide a DIREÇÃO, então o erro de leitura deixou de ser
  // descartável: sem ela não há como saber se o movimento seria para trás.
  // Origem que não existe mais (sem linha) não tem posição a comparar — o card
  // segue, como seguia antes desta regra.
  const { data: origem, error: erroOrigem } = await admin
    .from("crm_stages")
    .select("name, position")
    .eq("id", leadRow.stage_id)
    .maybeSingle();
  if (erroOrigem) {
    logger.warn("[appointment-stage-move] leitura da etapa de origem falhou", {
      lead_id: leadRow.id,
      organization_id: input.organizationId,
      error: erroOrigem.message,
    });
    return { moveu: false, motivo: "indisponivel" };
  }
  const origemRow = origem as { name: string; position: number | string } | null;
  if (origemRow && Number(origemRow.position) >= Number(etapaRow.position)) {
    return { moveu: false, motivo: "etapa_anterior" };
  }

  const serviceOrigin = await observeServiceOrigin(admin, input.organizationId, leadRow.contact_id);
  const { data: atualizadas, error: erroUpdate } = await admin
    .from("crm_leads")
    .update({ stage_id: etapaRow.id })
    .eq("id", leadRow.id)
    // Trava otimista pelo estágio de ORIGEM: se um humano moveu o card entre a
    // leitura e a escrita, a decisão dele vence.
    .eq("stage_id", leadRow.stage_id)
    // `status` volta junto porque o gatilho `fn_crm_lead_close_on_stage` o
    // recalcula pela etapa: aberto que entra em etapa de ganho sai daqui ganho.
    .select("id, status");
  if (erroUpdate) {
    logger.warn("[appointment-stage-move] update de stage_id falhou", {
      lead_id: leadRow.id,
      organization_id: input.organizationId,
      error: erroUpdate.message,
    });
    return { moveu: false, motivo: "falha_de_escrita" };
  }
  if ((atualizadas ?? []).length === 0) {
    return { moveu: false, motivo: "conflito_humano" };
  }

  const atividade = await emitLeadActivity(admin, {
    organizationId: input.organizationId,
    leadId: leadRow.id,
    contactId: leadRow.contact_id,
    type: "stage_changed",
    sourceModule: "agenda",
    sourceId: leadRow.id,
    actor: { type: "webhook_source", id: "appointment-stage-move" },
    reason: stageChangeReason(origemRow?.name ?? null, etapaRow.name),
    payload: { motivo_do_movimento: `agendamento:${input.transicao}`, de: leadRow.stage_id, para: etapaRow.id },
  });
  if (!atividade.ok) {
    await registraFalhaDeAtividade(admin, {
      organizationId: input.organizationId,
      leadId: leadRow.id,
      tipo: "stage_changed",
      origem: "lib/leads/appointment-stage-move",
      erro: atividade.error,
    });
  }

  // Mesmo evento que `agent-stage-sync.ts` e `handoff-stage-move.ts` emitem ao
  // mover o card — para que regras de automação e follow-up que escutam
  // `lead.stage_changed` reajam igual, seja qual for a mão que moveu o card.
  const { error: erroEvento } = await admin.rpc("emit_event" as never, {
    p_event_type: "lead.stage_changed",
    p_entity_kind: "crm_lead",
    p_entity_id: leadRow.id,
    p_payload: {
      service_origin: serviceOrigin,
      pipeline_id: leadRow.pipeline_id,
      from_stage_id: leadRow.stage_id,
      to_stage_id: etapaRow.id,
      status: (atualizadas?.[0] as { status?: string } | undefined)?.status ?? leadRow.status,
    },
    p_metadata: { actor_kind: "system", source: "appointment-stage-move", transicao: input.transicao },
    p_organization_id: input.organizationId,
  } as never);
  if (erroEvento) {
    logger.error("[appointment-stage-move] emit_event lead.stage_changed falhou", {
      lead_id: leadRow.id,
      organization_id: input.organizationId,
      error: (erroEvento as { message?: string }).message ?? String(erroEvento),
    });
  }

  return { moveu: true, motivo: "movido" };
}

/**
 * QUAL card a agenda espelha. O roteamento da timeline
 * (`resolveActiveLeadForContact`) responde "qual é O negócio aberto da pessoa"
 * — e para esta função a pergunta é outra: qual negócio está num funil que TEM
 * a etapa da transição. Medido no Instituto em 25/11/2026: o paciente sai da
 * consulta com um card aberto de protocolo (o Prontuário o cria ao salvar o
 * orçamento), o roteamento escolhia esse card, o funil de protocolos não tem
 * `compareceu`, e o card de atendimento ficava em "Sinal pago" para sempre.
 *
 * Regra: entre os negócios do contato nos funis que têm a etapa alvo, fica o
 * que o roteamento já escolheu; senão o aberto mais recente; e, só no
 * comparecimento, o ganho fechado mais recente (o card do sinal). Nenhum
 * candidato, ou qualquer falha de leitura, devolve `leadAtivo` — o
 * comportamento de antes, que nesse caso termina em `sem_etapa_mapeada`.
 */
export async function leadParaEspelharNaAgenda(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    contactId: string;
    transicao: Transicao;
    leadAtivo: string | null;
  },
): Promise<string | null> {
  const slug = SLUG_ETAPA_POR_TRANSICAO[input.transicao];
  if (!slug) return input.leadAtivo;
  const slugs = slug.includes("-") ? [slug, slug.replace(/-/g, "_")] : [slug];

  const { data: etapas, error: erroEtapas } = await admin
    .from("crm_stages")
    .select("pipeline_id")
    .eq("organization_id", input.organizationId)
    .in("slug", slugs)
    .eq("is_archived", false);
  if (erroEtapas) return input.leadAtivo;
  const funis = [...new Set(((etapas ?? []) as Array<{ pipeline_id: string }>).map((e) => e.pipeline_id))];
  if (funis.length === 0) return input.leadAtivo;

  const situacoes = input.transicao === "completed" ? ["open", "won"] : ["open"];
  const { data: candidatos, error: erroCandidatos } = await admin
    .from("crm_leads")
    .select("id, status, last_activity_at, closed_at, created_at")
    .eq("organization_id", input.organizationId)
    .eq("contact_id", input.contactId)
    .in("pipeline_id", funis)
    .in("status", situacoes);
  if (erroCandidatos) return input.leadAtivo;

  type Candidato = { id: string; status: string; last_activity_at: string | null; closed_at: string | null; created_at: string };
  const lista = (candidatos ?? []) as Candidato[];
  if (input.leadAtivo && lista.some((c) => c.id === input.leadAtivo)) return input.leadAtivo;
  const maisRecente = (a: string | null, b: string | null) => Date.parse(b ?? "") - Date.parse(a ?? "") || 0;
  const aberto = lista
    .filter((c) => c.status === "open")
    .sort((a, b) => maisRecente(a.last_activity_at ?? a.created_at, b.last_activity_at ?? b.created_at))[0];
  if (aberto) return aberto.id;
  const ganho = lista.filter((c) => c.status === "won").sort((a, b) => maisRecente(a.closed_at, b.closed_at))[0];
  return ganho?.id ?? input.leadAtivo;
}
