import { originFromAutomationEvent } from "@/lib/atendimento/origem-automacao";
/**
 * Ação `create_or_move_lead` — reusa os handlers core de /api/v1/leads
 * (mesmo caminho que REST/MCP) em vez de duplicar a lógica de criação/move.
 *
 * Actor = `webhook_source` com id = ruleId (ator automático; audit registra
 * actor_type=webhook_source). requestId = `rule:${ruleId}` — os handlers
 * propagam esse valor pro metadata.request_id dos eventos que emitem, e é
 * esse prefixo "rule:" que o engine (Task 8) usa pra não reprocessar os
 * eventos derivados (anti-loop profundidade 1: regra→ação→handler→evento).
 */
import { registerAction } from "@/lib/automation/actions";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { createLeadHandler, moveLeadHandler } from "@/app/api/v1/leads/_handler";
import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import { escolheEtapaDeDestino, montaPayloadDoClone, type EtapaDoFunil, type OrigemParaClonar } from "@/lib/leads/clonar-para-funil";
import { mensagemDeErro } from "@/lib/automation/actions/erro-legivel";

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const pipelineId = typeof config.pipeline_id === "string" ? config.pipeline_id : null;
  const stageId = typeof config.stage_id === "string" ? config.stage_id : null;
  if (!pipelineId || !stageId) {
    return { type: "create_or_move_lead", status: "failed", error: "missing_config" };
  }

  const handlerCtx: HandlerCtx = {
    organization_id: ctx.organizationId,
    actor: { type: "webhook_source", id: ctx.ruleId },
    requestId: `rule:${ctx.ruleId}`,
  };
  const lead = ctx.context.lead as { id: string; pipeline_id: string; contact_id?: string } | undefined;
  const contact = ctx.context.contact as
    | { id: string; name?: string | null; display_name?: string | null; phone_number?: string | null }
    | undefined;

  const contactId = contact?.id ?? lead?.contact_id;
  handlerCtx.serviceOrigin = contactId
    ? (await originFromAutomationEvent(ctx, contactId)) ?? { kind: "unavailable", reason: "origin_capture_failed" }
    : { kind: "unavailable", reason: "origin_capture_failed" };

  try {
    if (lead && ctx.event?.event_type === "lead.won") {
      return await abrePosVenda(ctx, handlerCtx, lead as unknown as VendaGanha, contact, pipelineId, stageId);
    }
    if (lead) {
      if (lead.pipeline_id !== pipelineId) {
        return { type: "create_or_move_lead", status: "failed", error: "cross_pipeline_move_not_allowed" };
      }
      const movido = await moveLeadHandler(ctx.admin, handlerCtx, lead.id, { to_stage_id: stageId });
      publicaNoContexto(ctx, movido, contactId);
      return { type: "create_or_move_lead", status: "success", detail: { moved: lead.id } };
    }
    if (contact) {
      // Gatilho de CONTATO não traz lead no contexto (`lib/automation/engine.ts`),
      // e sem isto a ação chamada de "criar/mover" só sabia criar: o contato
      // ganhava um negócio novo a cada vez que a regra rodava (#958). O negócio
      // procurado é o ABERTO no funil de destino — negócio de outro funil segue
      // fora, pela mesma regra que recusa mover entre funis.
      const existente = await negocioAbertoDoContato(ctx, contact.id, pipelineId);
      if (existente) {
        const movido = await moveLeadHandler(ctx.admin, handlerCtx, existente, { to_stage_id: stageId });
        publicaNoContexto(ctx, movido, contact.id);
        return { type: "create_or_move_lead", status: "success", detail: { moved: existente } };
      }
      const created = await createLeadHandler(ctx.admin, handlerCtx, {
        pipeline_id: pipelineId,
        stage_id: stageId,
        // O título nasce do MESMO resolvedor das telas. Remontado à mão, ele
        // gravava `Contato 543134@lid` no card do funil — e título de lead
        // não se reescreve sozinho depois.
        title: nomeDoContato(contact) ?? contact.phone_number ?? "Lead da automação",
        contact_id: contact.id,
        source: "automation",
      } as Parameters<typeof createLeadHandler>[2]);
      publicaNoContexto(ctx, created, contact.id);
      return { type: "create_or_move_lead", status: "success", detail: { created: String(created.id) } };
    }
    return { type: "create_or_move_lead", status: "skipped", detail: { reason: "no_lead_or_contact" } };
  } catch (err) {
    return {
      type: "create_or_move_lead",
      status: "failed",
      error: mensagemDeErro(err),
    };
  }
}

type VendaGanha = OrigemParaClonar & { organization_id?: string };

/** A chave do card de pós-venda: uma por venda, garantida por `uniq_crm_leads_org_source_external`. */
const chaveDoPosVenda = (vendaId: string) => `pos_venda:${vendaId}`;

/**
 * O GANHO ABRE O CARD DE PÓS-VENDA. Porte do upstream (PR 2787 de @webtecnica,
 * issue 2769 lá), adaptado ao motor deste fork.
 *
 * Com o gatilho `lead.won`, esta ação NÃO move nada: a venda fica ganha, na
 * etapa dela, e conta nos relatórios; nasce um card NOVO no funil e etapa que a
 * regra escolheu, com o conteúdo da venda (o MESMO `montaPayloadDoClone` da
 * troca de funil) e `source_metadata.clonado_de` apontando para ela. É opt-in:
 * sem uma regra `lead.won` ligada, nada disto roda.
 *
 * UM CARD POR VENDA. `external_id = pos_venda:<id da venda>` com a origem da
 * venda cai no índice único `uniq_crm_leads_org_source_external`: o evento
 * reprocessado, a venda reaberta e ganha de novo e dois drenos ao mesmo tempo
 * terminam no mesmo card, e a recusa do banco vira "já existia", nunca erro.
 * A chave não depende do funil da regra, então trocar o destino depois não
 * abre um segundo card para a mesma venda.
 *
 * Não envia nada: criar o lead emite `lead.created` com `request_id` `rule:`,
 * que o motor não reprocessa, e nenhum consumidor de `lead.created` manda
 * mensagem.
 */
async function abrePosVenda(
  ctx: ActionCtx,
  handlerCtx: HandlerCtx,
  venda: VendaGanha,
  contact: { id: string; is_blocked?: boolean | null; is_anonymized?: boolean | null; is_merged_into?: string | null } | undefined,
  pipelineId: string,
  stageId: string,
): Promise<ActionResultDetail> {
  const falha = (error: string): ActionResultDetail => ({ type: "create_or_move_lead", status: "failed", error });
  const pula = (reason: string): ActionResultDetail => ({ type: "create_or_move_lead", status: "skipped", detail: { reason } });

  // Uma 2ª regra `lead.won` do MESMO evento enxerga o card que a 1ª publicou
  // no contexto; sem isto ela abriria o pós-venda do pós-venda.
  if (typeof ctx.event.entity_id === "string" && ctx.event.entity_id !== venda.id) {
    return falha("pos_venda_ja_aberto_neste_evento");
  }
  // O mesmo funil não é continuação: mover a venda recém-ganha para etapa
  // aberta a reabre (o laço que o upstream mediu na issue 1528 de lá).
  if (venda.pipeline_id === pipelineId) return falha("continuacao_exige_outro_funil");
  // O contexto é a linha de AGORA: reaberta antes de o evento ser drenado, a
  // venda não é mais venda.
  if (venda.status !== "won") return pula("negocio_nao_esta_ganho");
  // Como no nascimento do lead pela conversa (`lib/leads/nascimento-do-lead.ts`).
  if (contact?.is_blocked) return pula("contact_blocked");
  if (contact?.is_anonymized) return pula("contato_anonimizado");
  if (contact?.is_merged_into) return pula("contato_mesclado");

  const existente = await posVendaDaVenda(ctx, venda.id);
  if (existente.erro) return falha(existente.erro);
  if (existente.card) return jaExistia(ctx, existente.card, venda.id);

  const { data: etapas, error: etapasErr } = await ctx.admin
    .from("crm_stages")
    .select("id, pipeline_id, position, is_won, is_lost, is_archived")
    .eq("organization_id", ctx.organizationId)
    .eq("pipeline_id", pipelineId)
    .eq("is_archived", false)
    .order("position", { ascending: true });
  if (etapasErr) return falha(etapasErr.message);
  // Etapa de outro funil (ou de outra organização) e etapa de fechamento são
  // recusadas com a frase pronta, que é o que a aba Atividade mostra.
  const destino = escolheEtapaDeDestino((etapas ?? []) as EtapaDoFunil[], stageId);
  if (!destino.ok) return falha(destino.texto);

  let card: Record<string, unknown>;
  try {
    card = await createLeadHandler(ctx.admin, handlerCtx, {
      ...montaPayloadDoClone(venda, destino.etapa),
      external_id: chaveDoPosVenda(venda.id),
    });
  } catch (err) {
    // Outro dreno gravou entre a leitura e o insert: o índice único recusou.
    const venceu = await posVendaDaVenda(ctx, venda.id);
    if (venceu.card) return jaExistia(ctx, venceu.card, venda.id);
    throw err;
  }
  publicaNoContexto(ctx, card, venda.contact_id ?? undefined);
  const cardId = String(card.id ?? "");

  const { data: funis } = await ctx.admin
    .from("crm_pipelines")
    .select("id, name")
    .eq("organization_id", ctx.organizationId)
    .in("id", [venda.pipeline_id, pipelineId]);
  const nomeDo = (id: string) => ((funis ?? []) as Array<{ id: string; name?: string | null }>).find((f) => f.id === id)?.name;
  const nomeDaVenda = nomeDo(venda.pipeline_id);
  const nomeDoDestino = nomeDo(pipelineId);

  const linhas = [
    {
      leadId: venda.id,
      type: "post_sale_opened" as const,
      reason: nomeDoDestino ? `Card de pós-venda aberto no funil ${nomeDoDestino}` : "Card de pós-venda aberto",
      payload: { to_lead_id: cardId, to_pipeline_id: pipelineId },
    },
    {
      leadId: cardId,
      type: "moved_from_pipeline" as const,
      reason: nomeDaVenda ? `Pós-venda da venda ganha no funil ${nomeDaVenda}` : "Pós-venda de uma venda ganha",
      payload: { from_lead_id: venda.id, from_pipeline_id: venda.pipeline_id },
    },
  ];
  for (const linha of linhas) {
    const r = await emitLeadActivity(ctx.admin, {
      organizationId: ctx.organizationId,
      contactId: venda.contact_id ?? null,
      sourceModule: "automation",
      sourceId: ctx.ruleId,
      actor: handlerCtx.actor,
      ...linha,
    });
    if (!r.ok) {
      await registraFalhaDeAtividade(ctx.admin, {
        organizationId: ctx.organizationId,
        leadId: linha.leadId,
        tipo: linha.type,
        origem: "lib/automation/actions/create-or-move-lead",
        erro: r.error,
        requestId: handlerCtx.requestId,
      });
    }
  }

  await audit({
    action: "lead.post_sale_opened",
    actorUserId: null,
    organizationId: ctx.organizationId,
    resourceType: "crm_lead",
    resourceId: venda.id,
    requestId: handlerCtx.requestId,
    metadata: {
      actor_type: "webhook_source",
      actor_id: ctx.ruleId,
      post_sale_lead_id: cardId,
      to_pipeline_id: pipelineId,
      to_stage_id: destino.etapa.id,
    },
  });

  return { type: "create_or_move_lead", status: "success", detail: { criado: cardId, origem: venda.id } };
}

/** O card de pós-venda que esta venda já abriu. Falha de leitura é recusa: tratá-la como "não há" duplicaria. */
async function posVendaDaVenda(
  ctx: ActionCtx,
  vendaId: string,
): Promise<{ card?: Record<string, unknown>; erro?: string }> {
  const { data, error } = await ctx.admin
    .from("crm_leads")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .eq("external_id", chaveDoPosVenda(vendaId))
    .limit(1)
    .maybeSingle();
  if (error) return { erro: error.message };
  return data ? { card: data as Record<string, unknown> } : {};
}

function jaExistia(ctx: ActionCtx, card: Record<string, unknown>, vendaId: string): ActionResultDetail {
  // As ações seguintes da regra enxergam o MESMO card da primeira vez.
  publicaNoContexto(ctx, card, (card.contact_id as string | undefined) ?? undefined);
  return { type: "create_or_move_lead", status: "success", detail: { ja_existia: String(card.id ?? ""), origem: vendaId } };
}

/**
 * O negócio ABERTO do contato neste funil, se houver um.
 *
 * Só o funil de destino: o contato pode ter negócio em outro funil, e mover
 * entre funis é recusado logo acima. Falha de leitura devolve `null` — a ação
 * então cria, que é o comportamento de antes deste conserto.
 */
async function negocioAbertoDoContato(
  ctx: ActionCtx,
  contactId: string,
  pipelineId: string,
): Promise<string | null> {
  const { data } = await ctx.admin
    .from("crm_leads")
    .select("id")
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", contactId)
    .eq("pipeline_id", pipelineId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

/**
 * As ações seguintes da MESMA regra passam a enxergar o lead.
 *
 * `assign_owner` lê `ctx.context.lead` e, num gatilho de contato, devolvia
 * `skipped: missing_input` mesmo depois de esta ação ter criado o negócio —
 * a execução inteira aparecia como "Parcial" na aba Atividade (#958). As
 * condições da regra já foram avaliadas quando isto roda (`engine.ts` filtra
 * `applicable` antes do laço), então escrever aqui não muda o que casou.
 */
function publicaNoContexto(ctx: ActionCtx, row: Record<string, unknown>, contactId?: string): void {
  // A LINHA INTEIRA, mesclada com o que já havia no contexto — nunca um objeto
  // com três campos. `add_tag` lê `ctx.context.lead.tags` como "as tags do
  // banco" e grava `[...prev, ...added]`: com um objeto parcial, `prev` é `[]`
  // e o UPDATE APAGA as tags existentes do negócio, inclusive a de anúncio que
  // `lib/leads/nascimento-do-lead.ts` grava. `call_webhook` projeta o mesmo
  // objeto sobre LEAD_PUBLIC_FIELDS, então o corpo entregue ao endpoint do
  // cliente encolheria em silêncio pelo mesmo motivo.
  const anterior = (ctx.context.lead ?? {}) as Record<string, unknown>;
  ctx.context.lead = {
    ...anterior,
    ...row,
    contact_id: row.contact_id ?? contactId ?? anterior.contact_id ?? null,
  };
}

registerAction({ type: "create_or_move_lead", execute });
