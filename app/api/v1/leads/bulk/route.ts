import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads/bulk
 *
 * Bulk operations on leads (move/assign/tag/delete). Discriminated by `action`.
 * AT-06: max 50 ids per call.
 *
 * Status transitions are NOT performed here — bulk move only changes
 * stage_id/position; the trigger will close-as-won/lost if the target is a
 * close stage. RLS scopes everything to the caller's tenant.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { resolveOwnerPatch } from "@/lib/leads/owner-patch";
import { emitLeadActivity, stageChangeReason } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import { bulkLeadActionSchema, validateRequest } from "@/lib/schemas";
import {
  decideMotivoDaPerda,
  etapaDePerda,
  razaoDaPerdaNaTimeline,
  recusaDeMotivoDaPerdaPeloBanco,
} from "@/lib/leads/motivo-da-perda";
import { createClient } from "@/lib/supabase/server";
import { observeServiceOrigin } from "@/lib/atendimento/origem";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { RECUSA_DE_TROCA_DE_FUNIL } from "@/lib/leads/clonar-para-funil";

export const dynamic = "force-dynamic";

const MAX_BULK = 50;

/** Uma linha do retorno de `fn_mover_leads_em_lote` (migration 0209). */
interface LeadMovidoEmLote {
  lead_id: string;
  from_stage_id: string;
  pipeline_id: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const supabase = await createClient();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const user = authz.user;

  let input;
  try {
    input = await validateRequest(bulkLeadActionSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  if (input.lead_ids.length > MAX_BULK) {
    return fail("bulk_too_large", `${t("Máximo")} ${MAX_BULK} ${t("leads por bulk.")}`, 422, { requestId });
  }

  // G3-04: assign é reatribuição de dono em lote → piso ≥manager (spec 04 §6.5,
  // INB-03). Gate por-action: move/tag/delete continuam agent+ (piso acima);
  // só o assign exige manager. Reusa o helper (nada de ROLE_RANK na mão).
  if (input.action === "assign") {
    const mgr = await requireRole("manager", { requestId, resource: "crm_leads" });
    if (!mgr.ok) return mgr.response;

    // Novo dono tem que ser membro ativo agent+ da MESMA org (org de fonte
    // confiável = authz, nunca body). owner_user_id null = desatribuir (válido).
    // A RLS de user_organizations só mostra o próprio membership a um manager,
    // por isso o admin client filtrado pela org resolvida.
    const ownerId = input.params.owner_user_id;
    if (ownerId !== null) {
      // INB-09 nota 1: fail-closed. A validação de membership só roda com service
      // role (a RLS de user_organizations não mostra membership alheio a um
      // manager). Sem service role NÃO se pode validar o dono → recusar em vez
      // de atribuir um owner não-verificado. Desatribuir (owner null) segue livre.
      if (!isServiceRoleConfigured()) {
        return fail(
          "owner_validation_unavailable",
          t("Não foi possível validar o responsável agora. Tente novamente em instantes."),
          422,
          { requestId },
        );
      }
      const admin = createAdminClient();
      const { data: member, error: memberErr } = await admin
        .from("user_organizations")
        .select("role")
        .eq("organization_id", authz.org.orgId)
        .eq("user_id", ownerId)
        .is("revoked_at", null)
        .maybeSingle();
      if (memberErr) return fail("internal_error", memberErr.message, 500, { requestId });
      if (!member || member.role === "viewer") {
        return fail(
          "invalid_owner",
          t("Responsável não é um atendente ativo desta organização."),
          422,
          { requestId },
        );
      }
    }
  }

  // INB-09 nota 2: org de fonte confiável = org ativa do cookie (authz), NUNCA
  // inferida do 1º lead. A RLS já escopa por org do membro, mas um ator em 2+
  // orgs veria leads de ambas — o filtro explícito garante que o bulk só toca a
  // org ativa (mesmo padrão do gate de owner acima).
  const organizationId = authz.org.orgId;
  // `lost_reason` entra no select por causa da decisão de perda (issue #917): o
  // motivo que o negócio JÁ tem é metade da pergunta "esta escrita o deixa perdido
  // sem motivo?" — e perguntar card a card depois custaria N consultas.
  const { data: scoped } = await supabase
    .from("crm_leads")
    .select("id, organization_id, tags, stage_id, pipeline_id, contact_id, lost_reason, status")
    .eq("organization_id", organizationId)
    .in("id", input.lead_ids);

  const visible = scoped ?? [];
  const first = visible[0];
  if (!first) {
    return fail(
      "not_found",
      t("Nenhum lead acessível na operação."),
      404,
      { requestId },
    );
  }
  const visibleIds = visible.map((r) => r.id);

  let updatedCount = 0;
  const nowIso = new Date().toISOString();

  switch (input.action) {
    case "move": {
      // ── O MOTIVO DA PERDA (issue #917) ──────────────────────────────────────
      //
      // O lote fecha N negócios de uma vez e a função do banco é uma transação só
      // ("move todos ou não move nenhum"): UM card que ficaria perdido sem motivo
      // derruba o lote inteiro com 23514, e o operador recebia 500 sem saber qual
      // card ofendeu. A decisão é a mesma das outras rotas de movimento — e a
      // resposta também: recusa de negócio, nomeando os cards, ANTES de o banco
      // tentar. Card que já tem motivo passa: trocar de "Perdido" para outra
      // etapa de perda não é uma perda nova.
      // A etapa é da org ATIVA (a RLS sozinha mostra as de todas as orgs do
      // membro) e do MESMO funil dos cards: `fn_mover_leads_em_lote` é INVOKER e
      // grava `stage_id` como vier — sem isto o lote furava a regra que a rota
      // individual impõe (`pipeline_immutable_use_clone`).
      const { data: etapaDeDestino, error: etapaErr } = await supabase
        .from("crm_stages")
        .select("id, name, is_lost, pipeline_id")
        .eq("id", input.params.stage_id)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (etapaErr) return fail("internal_error", etapaErr.message, 500, { requestId });
      if (!etapaDeDestino) {
        return fail("not_found", t("Stage não encontrado."), 404, { requestId });
      }
      const deOutroFunil = visible.filter((l) => l.pipeline_id !== etapaDeDestino.pipeline_id).map((l) => l.id);
      if (deOutroFunil.length > 0) {
        return fail("pipeline_immutable_use_clone", t(RECUSA_DE_TROCA_DE_FUNIL), 422, {
          requestId,
          details: { lead_ids: deOutroFunil, use: "/api/v1/leads/{id}/clone" },
        });
      }

      const motivoDoLote = input.params.lost_reason ?? null;
      let recusaDoMotivo: { codigo: string; mensagem: string } | null = null;
      const leadsSemMotivo: string[] = [];
      for (const linha of visible) {
        const veredito = decideMotivoDaPerda({
          etapaDeDestino,
          motivo: motivoDoLote,
          motivoAtual: linha.lost_reason ?? null,
          idioma: user.idioma,
        });
        if (!veredito.ok) {
          recusaDoMotivo ??= { codigo: veredito.codigo, mensagem: veredito.mensagem };
          leadsSemMotivo.push(linha.id);
        }
      }
      if (recusaDoMotivo) {
        return fail(recusaDoMotivo.codigo, recusaDoMotivo.mensagem, 422, {
          requestId,
          details: { lead_ids: leadsSemMotivo },
        });
      }

      // Migration 0209: quem posiciona é o banco. Escrever aqui um
      // `position_in_stage` escalar para N linhas dava a TODOS os cards do lote
      // o mesmo número, e `midpoint(prev, next)` devolve NaN quando os vizinhos
      // empatam — o primeiro arrasto para entre dois cards do lote mandava NaN
      // como posição. A função dá uma posição distinta a cada um e faz do lote
      // uma transação só: move todos ou não move nenhum.
      //
      // O tipo é declarado aqui porque `createClient()` deste repo devolve um
      // cliente SEM o genérico `Database` — sem a anotação, `data` chega como
      // `any` e a checagem some justamente no lugar que passou a depender de
      // três campos vindos do banco.
      //
      // `p_lost_reason` (migration 0263) é o outro lado da decisão acima: o
      // motivo tem de entrar na MESMA escrita que muda a etapa, e quem escreve a
      // etapa do lote é esta função. String vazia é `null` — quem não trouxe
      // motivo não sobrescreve o que o card já tem.
      //
      // QUEM JÁ ESTAVA PERDIDO NÃO TEM O MOTIVO TROCADO (porte do upstream
      // #2922, issue #2887). A função grava `p_lost_reason` em TODA linha do
      // lote; um card que já estava perdido tinha o motivo dele trocado em
      // silêncio (o `status` não muda: sem evento, sem timeline, sem
      // auditoria). O upstream corrigiu dentro da função (migration 0674). Aqui
      // o conserto é na rota, sem migration: quem já está `lost` vai numa
      // chamada SEM motivo (a coluna fica fora da escrita), os demais na
      // chamada com o motivo do lote. A segunda chamada lê o piso já com a
      // primeira gravada, então as posições continuam distintas.
      // ponytail: duas transações em vez de uma; se a segunda falhar, a
      // primeira (só cards que já estavam perdidos, trocando de etapa) fica.
      // Upgrade: a 0674 do upstream, quando valer reaplicar o baseline.
      const motivoGravado = (motivoDoLote ?? "").trim() || null;
      const jaPerdidos = motivoGravado
        ? visible.filter((l) => l.status === "lost").map((l) => l.id)
        : [];
      const novos = visibleIds.filter((id) => !jaPerdidos.includes(id));
      const mover = (ids: string[], motivo: string | null) =>
        supabase.rpc("fn_mover_leads_em_lote", {
          p_organization_id: organizationId,
          p_lead_ids: ids,
          p_stage_id: input.params.stage_id,
          p_lost_reason: motivo,
        });
      let data: unknown[] = [];
      let error: { code?: string; message: string } | null = null;
      for (const [ids, motivo] of [
        [jaPerdidos, null],
        [novos, motivoGravado],
      ] as const) {
        if (ids.length === 0 || error) continue;
        const r = await mover([...ids], motivo);
        error = r.error;
        data = data.concat((r.data ?? []) as unknown[]);
      }
      if (error) {
        // Rede de segurança (#917): a recusa do banco por motivo da perda (o
        // motivo veio, mas não é do vocabulário deste funil) vira recusa de
        // negócio. Qualquer outro erro continua 500 com o texto do Postgres.
        const recusaDoBanco = recusaDeMotivoDaPerdaPeloBanco(error, user.idioma);
        if (recusaDoBanco) {
          return fail(recusaDoBanco.codigo, recusaDoBanco.mensagem, 422, { requestId });
        }
        return fail("internal_error", error.message, 500, { requestId });
      }
      const movidosNoBanco = (data ?? []) as LeadMovidoEmLote[];
      updatedCount = movidosNoBanco.length;

      // Per-lead lead.stage_changed so the automation engine (which only
      // consumes per-entity events) fires for bulk moves too — mirrors
      // moveLeadHandler's payload. Skip leads already at the target stage.
      //
      // A etapa de ORIGEM vem da função, não do `select` de antes: ela é lida
      // dentro do mesmo `update`, então não existe janela em que outra escrita
      // mova o card entre a leitura e a atualização e a timeline conte a
      // transição errada.
      const movidos = movidosNoBanco.filter((r) => r.from_stage_id !== input.params.stage_id);

      // Wave 3 (CORE 2): mover 30 cards de uma vez é 30 mudanças de estado —
      // cada uma entra no barramento, senão o lote inteiro fica invisível na
      // timeline e a operação em massa vira o buraco por onde a atividade some.
      //
      // Uma atividade POR LEAD, e não uma agregada: `crm_lead_activities` é a
      // timeline DE UM LEAD. Trinta cards movidos são uma linha em cada uma de
      // trinta timelines — não trinta linhas numa só. O ruído que uma agregada
      // evitaria não existe aqui; o que existiria sem elas é o oposto, um card
      // que mudou de etapa sem nada que conte por quê. `payload.bulk = true`
      // marca a origem, para quem lê distinguir lote de arrasto à mão.
      const nomesEstagio = new Map<string, string>();
      const { data: stageRows } = await supabase
        .from("crm_stages")
        .select("id, name")
        .eq("organization_id", organizationId)
        .in("id", [input.params.stage_id, ...movidos.map((r) => r.from_stage_id)]);
      for (const s of (stageRows ?? []) as Array<{ id: string; name: string }>) {
        nomesEstagio.set(s.id, s.name);
      }

      // A PERDA DO LOTE É A PERDA DO CARD, POR CARD (portes do upstream #2868 e
      // #2922): quem fecha AGORA (etapa de perda e card que não estava
      // perdido) ganha a linha "Perdido — <motivo>" da `/lose` e a auditoria
      // `lead.lost`. Quem já estava perdido só troca de etapa. O tipo segue
      // `stage_changed`: é dele que as métricas do funil contam o encerramento.
      const statusDoCard = new Map(visible.map((l) => [l.id, l.status as string | null]));
      const motivoDoCard = new Map(visible.map((l) => [l.id, (l.lost_reason as string | null) ?? null]));
      const ehPerdaNova = (row: LeadMovidoEmLote) =>
        etapaDePerda(etapaDeDestino) && statusDoCard.get(row.lead_id) !== "lost";

      await Promise.all(
        movidos.map(async (row) => {
          const perdaNova = ehPerdaNova(row);
          const motivo = perdaNova
            ? (motivoGravado ?? (motivoDoCard.get(row.lead_id) ?? "").trim())
            : "";
          const r = await emitLeadActivity(supabase, {
            organizationId,
            leadId: row.lead_id,
            type: "stage_changed",
            sourceModule: "crm",
            sourceId: row.lead_id,
            actor: { type: "user", id: user.id },
            reason:
              perdaNova && motivo.length > 0
                ? razaoDaPerdaNaTimeline(motivo)
                : stageChangeReason(
                    nomesEstagio.get(row.from_stage_id) ?? null,
                    nomesEstagio.get(input.params.stage_id) ?? null,
                  ),
            payload: {
              ...(perdaNova ? { desfecho: "lost" } : {}),
              from_stage_id: row.from_stage_id,
              to_stage_id: input.params.stage_id,
              pipeline_id: row.pipeline_id,
              bulk: true,
            },
          });
          if (!r.ok) {
            // O bulk é o pior caso dos três: N leads movidos, e uma falha de
            // atividade some junto com as outras N-1 que deram certo. Sem o
            // aviso, o buraco na timeline não tem nem tamanho conhecido.
            await registraFalhaDeAtividade(supabase, {
              organizationId,
              leadId: row.lead_id,
              tipo: "stage_changed",
              origem: "leads/bulk",
              erro: r.error,
              requestId,
            });
          }
          if (perdaNova) {
            await audit({
              action: "lead.lost",
              actorUserId: user.id,
              organizationId,
              resourceType: "crm_lead",
              resourceId: row.lead_id,
              requestId,
              metadata: {
                actor_type: "user",
                from_stage_id: row.from_stage_id,
                to_stage_id: input.params.stage_id,
                lost_reason: motivo,
                bulk: true,
              },
            });
          }
        }),
      );
      await Promise.all(
        movidos.map((row) =>
          supabase
            .rpc("emit_event", {
              p_event_type: "lead.stage_changed",
              p_entity_kind: "crm_lead",
              p_entity_id: row.lead_id,
              p_payload: {
                pipeline_id: row.pipeline_id,
                from_stage_id: row.from_stage_id,
                to_stage_id: input.params.stage_id,
              },
              p_metadata: { request_id: requestId, actor_user_id: user.id },
              p_organization_id: organizationId,
            })
            .then(({ error: emitError }) => {
              if (emitError) console.error("[lead.bulk_moved] emit_event failed", emitError.message);
            }),
        ),
      );
      break;
    }
    case "assign": {
      // 0070: o trio de posse vem do helper compartilhado. Escrever só
      // owner_user_id aqui quebrava de dois jeitos: lote com algum lead de dono
      // AGENTE estourava 23514 e derrubava a operação inteira; e lead sem dono
      // ganhava dono sem owner_kind (drift silencioso).
      const owner = resolveOwnerPatch({ owner_user_id: input.params.owner_user_id });
      if (!owner.ok || !owner.patch) {
        return fail(
          "validation_failed",
          t("Um lead tem um dono: informe owner_user_id OU owner_agent_id."),
          422,
          { requestId },
        );
      }
      const patch: Record<string, unknown> = {
        ...owner.patch,
        updated_at: nowIso,
      };
      if (owner.patch.owner_kind !== null) {
        patch.assigned_at = nowIso;
      }
      const { data, error } = await supabase
        .from("crm_leads")
        .update(patch)
        .in("id", visibleIds)
        .select("id");
      if (error) return fail("internal_error", error.message, 500, { requestId });
      updatedCount = data?.length ?? 0;
      break;
    }
    case "tag": {
      const add = input.params.add ?? [];
      const remove = new Set(input.params.remove ?? []);
      // Compute next tags per row from already-fetched `scoped`.
      for (const row of visible) {
        const current = (row.tags ?? []) as string[];
        const next = Array.from(new Set([...current.filter((t) => !remove.has(t)), ...add]));
        const tagServiceOrigin = add.some((tag) => !current.includes(tag))
          ? await observeServiceOrigin(createAdminClient(), organizationId, row.contact_id)
          : null;
        const { error } = await supabase
          .from("crm_leads")
          .update({ tags: next, updated_at: nowIso })
          .eq("id", row.id);
        if (error) return fail("internal_error", error.message, 500, { requestId });
        updatedCount += 1;

        // Per-lead lead.tag_added (only-when-added), same contract as
        // updateLeadHandler, so the automation engine fires for bulk tags too.
        const addedTags = add.filter((t) => !current.includes(t));
        if (addedTags.length) {
          await createAdminClient()
            .rpc("emit_event", {
              p_event_type: "lead.tag_added",
              p_entity_kind: "crm_lead",
              p_entity_id: row.id,
              p_payload: { added_tags: addedTags, tags: next, service_origin: tagServiceOrigin },
              p_metadata: { request_id: requestId, actor_user_id: user.id },
              p_organization_id: organizationId,
            })
            .then(({ error: emitError }) => {
              if (emitError) console.error("[lead.bulk_tagged] emit_event failed", emitError.message);
            });
        }
      }
      break;
    }
    case "delete": {
      // crm_leads has no `is_archived` column → real DELETE.
      const { data, error } = await supabase
        .from("crm_leads")
        .delete()
        .in("id", visibleIds)
        .select("id");
      if (error) return fail("internal_error", error.message, 500, { requestId });
      updatedCount = data?.length ?? 0;
      break;
    }
  }

  // Aggregate event + aggregate audit (one record per bulk call).
  const eventType =
    input.action === "move"
      ? "lead.bulk_moved"
      : input.action === "assign"
        ? "lead.bulk_assigned"
        : input.action === "tag"
          ? "lead.bulk_tagged"
          : "lead.bulk_deleted";

  await supabase
    .rpc("emit_event", {
      p_event_type: eventType,
      p_entity_kind: "crm_lead",
      p_entity_id: null,
      p_payload: {
        action: input.action,
        lead_ids: visibleIds,
        params: "params" in input ? input.params : {},
      },
      p_metadata: { request_id: requestId, actor_user_id: user.id },
      p_organization_id: organizationId,
    })
    .then(({ error }) => {
      if (error) console.error("[lead.bulk] emit_event failed", error.message);
    });

  // Assign audita com action agregada dedicada (spec 04 §6.5); as demais ações
  // mantêm o code genérico. Uma única entrada por chamada, com a contagem.
  await audit({
    action: input.action === "assign" ? "leads.bulk_assigned" : "lead.bulk_action",
    actorUserId: user.id,
    organizationId,
    resourceType: "crm_lead",
    resourceId: null,
    requestId,
    metadata: {
      action: input.action,
      lead_ids: visibleIds,
      count: updatedCount,
      updated_count: updatedCount,
      ...(input.action === "assign" ? { owner_user_id: input.params.owner_user_id } : {}),
      params: "params" in input ? input.params : {},
    },
  });

  return ok({ updated_count: updatedCount, lead_ids: visibleIds }, { requestId });
}
