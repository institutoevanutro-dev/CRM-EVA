/**
 * Ação `add_tag` — merge idempotente de tags no LEAD do contexto (ou no
 * CONTATO, se o contexto não tiver lead). Emite o próprio evento
 * lead.tag_added/contact.tag_added com metadata.caused_by_rule — é a ação, e
 * não um handler reusado, então é ela quem carrega o anti-loop.
 *
 * `config.destino` é OPCIONAL. `card` é o padrão e é o caminho de sempre: lead
 * manda, e sem lead o contato do contexto. `contato` grava na caixa que o Inbox
 * consulta. Com `contato` a leitura é NO BANCO, não no contexto: o evento pode
 * trazer `contact.tags` velho, e um merge a partir dele regravaria as etiquetas
 * do contato com o que o evento lembra. Sem contato resolvível a ação é
 * IGNORADA (`skipped`/`no_contact`), nunca troca de destino em silêncio.
 *
 * Portado do projeto original (DeskcommCRM, issue #2498, PR #2701).
 */
import { originFromAutomationEvent } from "@/lib/atendimento/origem-automacao";
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";

/** A função SQL que faz a junção na linha alvo — uma por tabela (migration 0386). */
type RpcDaJuncao = "fn_lead_adicionar_etiquetas" | "fn_contato_adicionar_etiquetas";

type Alvo = {
  table: "crm_leads" | "contacts";
  id: string;
  event: "lead.tag_added" | "contact.tag_added";
  kind: "crm_lead" | "contact";
  rpc: RpcDaJuncao;
  /** A foto do CONTEXTO quando o alvo é ela mesma — é ela que as próximas regras do mesmo evento enxergam. */
  foto?: { tags?: string[] };
};

function lista(valor: unknown): string[] {
  return Array.isArray(valor) ? valor.map(String) : [];
}

/**
 * A junção acontece DENTRO do `UPDATE` (funções da migration 0386), nunca aqui:
 * o `event_log` tem dois drenos concorrentes e o claim é por LINHA, não por
 * negócio — dois eventos distintos do mesmo negócio liam a mesma lista e o
 * último a gravar apagava a etiqueta do outro. Reler antes do merge (a correção
 * anterior) só estreitava a janela. Portado do projeto original (DeskcommCRM,
 * PR #2967 de @webtecnica).
 */
async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const tags = Array.isArray(config.tags) ? config.tags.map(String) : [];
  if (!tags.length) return { type: "add_tag", status: "skipped", detail: { reason: "no_tags" } };

  const lead = ctx.context.lead as { id: string; contact_id?: string; tags?: string[] } | undefined;
  const contact = ctx.context.contact as { id: string; tags?: string[] } | undefined;

  let target: Alvo;
  if (config.destino === "contato") {
    // O contato do LEAD primeiro; o do contexto cobre o evento que chega sem lead.
    const idDoContato = lead?.contact_id ?? contact?.id;
    if (!idDoContato) return { type: "add_tag", status: "skipped", detail: { reason: "no_contact" } };
    target = { table: "contacts", id: idDoContato, event: "contact.tag_added", kind: "contact", rpc: "fn_contato_adicionar_etiquetas" };
  } else if (lead) {
    target = { table: "crm_leads", id: lead.id, event: "lead.tag_added", kind: "crm_lead", rpc: "fn_lead_adicionar_etiquetas", foto: lead };
  } else if (contact) {
    target = { table: "contacts", id: contact.id, event: "contact.tag_added", kind: "contact", rpc: "fn_contato_adicionar_etiquetas", foto: contact };
  } else {
    return { type: "add_tag", status: "skipped", detail: { reason: "no_target" } };
  }

  const parametros =
    target.table === "contacts"
      ? { p_org: ctx.organizationId, p_contato: target.id, p_etiquetas: tags }
      : { p_org: ctx.organizationId, p_lead: target.id, p_etiquetas: tags };
  const { data, error } = await ctx.admin.rpc(target.rpc, parametros);
  if (error) return { type: "add_tag", status: "failed", error: error.message };

  // Nulo = linha inexistente OU de outra organização: nada lido, nada gravado.
  if (data === null || data === undefined) {
    if (config.destino === "contato") return { type: "add_tag", status: "skipped", detail: { reason: "no_contact" } };
    return { type: "add_tag", status: "skipped", detail: { reason: "no_target" } };
  }

  const retorno = data as { tags?: unknown; adicionadas?: unknown };
  const merged = lista(retorno.tags);
  const added = lista(retorno.adicionadas);
  if (target.foto) target.foto.tags = merged;
  if (!added.length) return { type: "add_tag", status: "success", detail: { added: [] } };

  const contactId = target.table === "contacts" ? target.id : (lead?.contact_id ?? contact?.id);
  const serviceOrigin = contactId ? await originFromAutomationEvent(ctx, contactId) : null;

  await ctx.admin.rpc("emit_event", {
    p_event_type: target.event,
    p_entity_kind: target.kind,
    p_entity_id: target.id,
    p_payload: { added_tags: added, tags: merged, service_origin: serviceOrigin },
    p_metadata: { caused_by_rule: ctx.ruleId },
    p_organization_id: ctx.organizationId,
  });
  return { type: "add_tag", status: "success", detail: { added } };
}

registerAction({ type: "add_tag", execute });
