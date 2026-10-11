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

type LinhaDeAlvo = { id: string; tags?: string[] };

type Alvo = {
  table: "crm_leads" | "contacts";
  row: LinhaDeAlvo;
  event: "lead.tag_added" | "contact.tag_added";
  kind: "crm_lead" | "contact";
};

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const tags = Array.isArray(config.tags) ? config.tags.map(String) : [];
  if (!tags.length) return { type: "add_tag", status: "skipped", detail: { reason: "no_tags" } };

  const lead = ctx.context.lead as { id: string; contact_id?: string; tags?: string[] } | undefined;
  const contact = ctx.context.contact as { id: string; tags?: string[] } | undefined;

  let target: Alvo | null = null;
  if (config.destino === "contato") {
    // O contato do LEAD primeiro; o do contexto cobre o evento que chega sem lead.
    const idDoContato = lead?.contact_id ?? contact?.id;
    if (!idDoContato) return { type: "add_tag", status: "skipped", detail: { reason: "no_contact" } };
    const { data, error } = await ctx.admin
      .from("contacts")
      .select("id, tags")
      .eq("id", idDoContato)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    if (error) return { type: "add_tag", status: "failed", error: error.message };
    if (!data) return { type: "add_tag", status: "skipped", detail: { reason: "no_contact" } };
    target = { table: "contacts", row: data as LinhaDeAlvo, event: "contact.tag_added", kind: "contact" };
  } else {
    target = lead
      ? { table: "crm_leads", row: lead, event: "lead.tag_added", kind: "crm_lead" }
      : contact
        ? { table: "contacts", row: contact, event: "contact.tag_added", kind: "contact" }
        : null;
    if (!target) return { type: "add_tag", status: "skipped", detail: { reason: "no_target" } };
  }

  const prev = target.row.tags ?? [];
  const added = tags.filter((t) => !prev.includes(t));
  if (!added.length) return { type: "add_tag", status: "success", detail: { added: [] } };

  const contactId = target.table === "contacts" ? target.row.id : (lead?.contact_id ?? contact?.id);
  const serviceOrigin = contactId
    ? await originFromAutomationEvent(ctx, contactId)
    : null;
  const merged = [...prev, ...added];
  const { error } = await ctx.admin
    .from(target.table)
    .update({ tags: merged, updated_at: new Date().toISOString() })
    .eq("id", target.row.id)
    .eq("organization_id", ctx.organizationId);
  if (error) return { type: "add_tag", status: "failed", error: error.message };

  await ctx.admin.rpc("emit_event", {
    p_event_type: target.event,
    p_entity_kind: target.kind,
    p_entity_id: target.row.id,
    p_payload: { added_tags: added, tags: merged, service_origin: serviceOrigin },
    p_metadata: { caused_by_rule: ctx.ruleId },
    p_organization_id: ctx.organizationId,
  });
  return { type: "add_tag", status: "success", detail: { added } };
}

registerAction({ type: "add_tag", execute });
