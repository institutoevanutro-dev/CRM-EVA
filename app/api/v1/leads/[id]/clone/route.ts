import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads/[id]/clone — levar o negócio para OUTRO funil.
 *
 * É o caminho que a P-01 manda usar quando o alvo é outro funil: `/move` recusa
 * (422 `pipeline_immutable_use_clone`) e aponta para cá.
 *
 * A criação do clone, os vínculos (`clonado_de` / `movido_para`) e o
 * encerramento da origem são UMA transação: `fn_levar_negocio_para_funil`
 * (migration 0439), que trava a origem e reutiliza a cópia ABERTA do mesmo
 * negócio que já está no destino. Duas abas, um duplo clique ou a API repetindo
 * o pedido recebem o MESMO card (200); só a criação devolve 201.
 *
 * Portado do projeto original (DeskcommCRM PR #5268, de yunshu0909). Lá a
 * transação roda pelo cliente de serviço com as claims da sessão; aqui ela é
 * `security invoker` chamada pela SESSÃO, então as policies de `crm_leads`
 * valem como no INSERT de antes.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { ehRecusaDaVisibilidadeDoFunil } from "@/lib/leads/recusa-da-visibilidade";
import { listPipelinesHandler } from "@/app/api/v1/pipelines/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  FUNIL_DE_DESTINO_NAO_ENCONTRADO,
  escolheEtapaDeDestino,
  montaPayloadDoClone,
  recusaTrocaDeFunil,
  registroDoDestino,
  type EtapaDoFunil,
  type OrigemParaClonar,
} from "@/lib/leads/clonar-para-funil";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import {
  preparaEncerramentoDemanda,
  registraEncerramentoDemanda,
  type EncerraDemandaInput,
} from "@/lib/leads/encerramento";
import {
  motivoDaPerdaDaOrigem,
  recusaDeMotivoDaPerdaPeloBanco,
  recusaDeMotivoForaDoVocabulario,
} from "@/lib/leads/motivo-da-perda";
import { cloneLeadSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Uma etapa do funil de destino, como o seletor da tela a recebe. */
interface EtapaDeDestino {
  id: string;
  pipeline_id: string;
  name: string;
  position: number | string | null;
  is_won: boolean;
  is_lost: boolean;
}

/**
 * GET /api/v1/leads/[id]/clone — para onde este negócio pode ir: os OUTROS
 * funis, cada um com as etapas não arquivadas, na ordem do quadro. É a lista do
 * diálogo "Levar para outro funil" (porte de melgarafael/DeskcommCRM#1585 e
 * #3655). Funil e etapas vêm juntos porque a rota de etapas é `manager`+ e quem
 * leva o card é `agent`.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const supabase = await createClient();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const organizationId = authz.org.orgId;

  const { data: origem, error: selErr } = await supabase
    .from("crm_leads")
    .select("id, pipeline_id")
    .eq("id", leadId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (selErr) return fail("internal_error", selErr.message, 500, { requestId });
  if (!origem) return fail("not_found", t("Lead não encontrado."), 404, { requestId });

  const { pipelines } = await listPipelinesHandler(supabase, {
    organization_id: organizationId,
    actor: { type: "user", id: authz.user.id },
    requestId,
    idioma: authz.user.idioma,
  });
  const outros = pipelines.filter((p) => p.id !== origem.pipeline_id);

  // Funil único (instalação nova) não é erro: a tela explica que não há destino.
  const { data: etapas, error: stagesErr } =
    outros.length === 0
      ? { data: [] as EtapaDeDestino[], error: null }
      : await supabase
          .from("crm_stages")
          .select("id, pipeline_id, name, position, is_won, is_lost")
          .eq("organization_id", organizationId)
          .in("pipeline_id", outros.map((p) => p.id))
          .eq("is_archived", false)
          .order("position", { ascending: true });
  if (stagesErr) return fail("internal_error", stagesErr.message, 500, { requestId });

  const destinos = outros.map((p) => ({
    id: p.id,
    name: p.name,
    stages: ((etapas ?? []) as EtapaDeDestino[])
      .filter((e) => e.pipeline_id === p.id)
      .map(({ id, name, position, is_won, is_lost }) => ({ id, name, position, is_won, is_lost })),
  }));
  return ok({ pipelines: destinos }, { requestId });
}

type Linha = Record<string, unknown>;

interface GravacaoDoClone {
  clone: Linha;
  origem: Linha;
  criou: boolean;
  fechou: boolean;
}

// O caminho comum de criação não deve emitir `lead.created` nem auditar para
// quem apenas recebeu um card já existente da transação.
class CloneReutilizado extends Error {
  constructor(readonly gravacao: GravacaoDoClone) {
    super("clone_reutilizado");
  }
}

function respostaDoClone(gravacao: GravacaoDoClone, requestId: string) {
  // 201 só quando a rota CRIOU o recurso, como `POST /api/v1/leads`; a cópia
  // aberta reaproveitada é 200.
  return ok(
    { lead: gravacao.clone, origem: gravacao.origem },
    { requestId, status: gravacao.criou ? 201 : 200 },
  );
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const supabase = await createClient();
  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const handlerCtx: HandlerCtx = {
    organization_id: authz.org.orgId,
    actor: { type: "user", id: authz.user.id },
    requestId,
    idioma: authz.user.idioma,
  };

  try {
    const input = await validateRequest(cloneLeadSchema, req);

    // Filtro por organização explícito como defesa em profundidade: a RLS já
    // recorta o client do usuário.
    const { data: origemLida, error: selErr } = await supabase
      .from("crm_leads")
      .select("*")
      .eq("id", leadId)
      .eq("organization_id", handlerCtx.organization_id)
      .maybeSingle();

    if (selErr) {
      return fail("internal_error", selErr.message, 500, { requestId });
    }
    if (!origemLida) {
      return fail("not_found", t("Lead não encontrado."), 404, { requestId });
    }
    const origem = origemLida as OrigemParaClonar & Linha;

    const { data: pipelineDestino, error: pipeErr } = await supabase
      .from("crm_pipelines")
      .select("id, name, is_archived")
      .eq("id", input.pipeline_id)
      .eq("organization_id", handlerCtx.organization_id)
      .maybeSingle();

    if (pipeErr) {
      return fail("internal_error", pipeErr.message, 500, { requestId });
    }
    if (!pipelineDestino || (pipelineDestino as { is_archived?: boolean }).is_archived) {
      return fail("pipeline_not_found", t(FUNIL_DE_DESTINO_NAO_ENCONTRADO), 404, { requestId });
    }

    const recusa = recusaTrocaDeFunil(origem, input.pipeline_id);
    if (recusa?.code === "pipeline_unchanged") {
      return fail(recusa.code, t(recusa.texto), recusa.status, { requestId });
    }

    async function gravar(linha: Linha | null, fechamento: Linha | null, atualizadaEm: unknown) {
      const { data, error } = await supabase.rpc("fn_levar_negocio_para_funil", {
        p_org: handlerCtx.organization_id,
        p_origem: leadId,
        p_destino: input.pipeline_id,
        p_linha: linha,
        p_fechamento: fechamento,
        p_origem_atualizada_em: atualizadaEm ?? null,
      });
      if (error?.code === "PT404") {
        throw new ApiError(404, "not_found", undefined, requestId, t("Lead não encontrado."));
      }
      if (error?.code === "PT403" || ehRecusaDaVisibilidadeDoFunil(error)) {
        throw new ApiError(
          403, "forbidden", undefined, requestId,
          t("Sem permissão para salvar este negócio: pela visibilidade definida na organização, ele ficaria fora do que você pode ver."),
        );
      }
      if (error?.code === "PT409") {
        throw new ApiError(409, "state_conflict", undefined, requestId, t("O negócio mudou enquanto era encerrado."));
      }
      return { gravacao: data as GravacaoDoClone | null, error };
    }

    // Leitura sem trava: já existe cópia aberta deste negócio no destino?
    const consulta = await gravar(null, null, null);
    if (consulta.error) return fail("internal_error", consulta.error.message, 500, { requestId });
    const existente = consulta.gravacao;
    if (existente && existente.origem.status !== "open") {
      return respostaDoClone(existente, requestId);
    }
    if (!existente && recusa) {
      return fail(recusa.code, t(recusa.texto), recusa.status, { requestId });
    }

    // ── O MOTIVO DO CHAMADOR SE CONFERE ANTES DA PRIMEIRA ESCRITA ─────────────
    //
    // O vocabulário é o do funil de ORIGEM porque é a linha da origem que fecha,
    // e o trigger `fn_validate_lost_reason_required` lê `new.pipeline_id`.
    const { data: pipelineOrigem, error: origemPipeErr } = await supabase
      .from("crm_pipelines")
      .select("settings, name")
      .eq("id", origem.pipeline_id)
      .eq("organization_id", handlerCtx.organization_id)
      .maybeSingle();

    if (origemPipeErr) {
      return fail("internal_error", origemPipeErr.message, 500, { requestId });
    }
    const motivoRecusado = recusaDeMotivoForaDoVocabulario({
      motivo: input.lost_reason,
      settingsDoFunil: (pipelineOrigem as { settings?: unknown } | null)?.settings ?? null,
      idioma: authz.user.idioma,
    });
    if (motivoRecusado) {
      return fail(motivoRecusado.codigo, motivoRecusado.mensagem, 422, { requestId });
    }

    let etapaDeEntrada: EtapaDoFunil | null = null;
    if (!existente) {
      const { data: etapas, error: stagesErr } = await supabase
        .from("crm_stages")
        .select("id, pipeline_id, position, is_won, is_lost, is_archived")
        .eq("organization_id", handlerCtx.organization_id)
        .eq("pipeline_id", input.pipeline_id)
        .eq("is_archived", false)
        .order("position", { ascending: true });

      if (stagesErr) {
        return fail("internal_error", stagesErr.message, 500, { requestId });
      }

      const destino = escolheEtapaDeDestino(
        (etapas ?? []) as EtapaDoFunil[],
        input.stage_id ?? null,
      );
      if (!destino.ok) {
        return fail(destino.code, t(destino.texto), destino.status, { requestId });
      }
      etapaDeEntrada = destino.etapa;
    }

    const nomeDoFunilDeOrigem = (pipelineOrigem as { name?: string | null } | null)?.name ?? null;
    const nomeDoFunilDeDestino = (pipelineDestino as { name?: string | null }).name ?? null;
    const motivo = motivoDaPerdaDaOrigem(input.lost_reason);
    const dadosDoFecho: EncerraDemandaInput = {
      leadId,
      desfecho: "lost",
      motivo,
      razaoNaTimeline: nomeDoFunilDeDestino
        ? `Levado para o funil ${nomeDoFunilDeDestino}`
        : "Levado para outro funil",
    };
    // A ORIGEM PRECISA TER ONDE FECHAR, e isso se pergunta ANTES da primeira
    // escrita: `preparaEncerramentoDemanda` recusa com 422
    // `pipeline_no_lost_stage` sem gravar nada.
    const preparo = await preparaEncerramentoDemanda(supabase, handlerCtx, dadosDoFecho);
    const fechamento = preparo.jaEstava ? null : preparo;

    let gravacao: GravacaoDoClone;
    if (etapaDeEntrada) {
      const escrita: { gravacao?: GravacaoDoClone } = {};
      try {
        await createLeadHandler(
          supabase,
          handlerCtx,
          montaPayloadDoClone(origem, etapaDeEntrada),
          {
            persistir: async (linha) => {
              const resultado = await gravar(linha, fechamento?.patch ?? null, origem.updated_at);
              if (resultado.gravacao && !resultado.gravacao.criou) {
                throw new CloneReutilizado(resultado.gravacao);
              }
              escrita.gravacao = resultado.gravacao ?? undefined;
              return { data: resultado.gravacao?.clone ?? null, error: resultado.error };
            },
          },
        );
        if (!escrita.gravacao) {
          throw new ApiError(500, "internal_error", undefined, requestId);
        }
        gravacao = escrita.gravacao;
      } catch (erro) {
        if (!(erro instanceof CloneReutilizado)) throw erro;
        gravacao = erro.gravacao;
      }
    } else if (fechamento) {
      // A cópia aberta já existe e a origem ainda está aberta: a transferência
      // termina sobre ESSA cópia (o pedido anterior caiu antes de encerrar).
      const resultado = await gravar(null, fechamento.patch, fechamento.lead.updated_at);
      if (resultado.error) {
        const recusaDeMotivo = recusaDeMotivoDaPerdaPeloBanco(resultado.error, authz.user.idioma);
        if (recusaDeMotivo) return fail(recusaDeMotivo.codigo, recusaDeMotivo.mensagem, 422, { requestId });
      }
      if (!resultado.gravacao || resultado.error) {
        return fail("internal_error", resultado.error?.message ?? "Falha ao levar o negócio.", 500, { requestId });
      }
      gravacao = resultado.gravacao;
    } else {
      // O fecho concorrente já terminou desde a primeira leitura.
      const atual = await gravar(null, null, null);
      if (atual.error) return fail("internal_error", atual.error.message, 500, { requestId });
      if (!atual.gravacao) return fail("state_conflict", t("O negócio mudou enquanto era encerrado."), 409, { requestId });
      return respostaDoClone(atual.gravacao, requestId);
    }

    if (!gravacao.criou && !gravacao.fechou) return respostaDoClone(gravacao, requestId);
    const destination = registroDoDestino(gravacao.clone);

    // ── A TROCA NA LINHA DO TEMPO, DOS DOIS LADOS ──────────────────────────────
    //
    // `source_metadata` guarda os ponteiros, mas nenhuma tela o lê — a linha do
    // tempo do dossiê vem de `crm_lead_activities`. Só quem CRIOU o clone conta
    // a chegada; quem encerrou a origem conta a saída.
    if (gravacao.criou) {
      const atividadeDoClone = await emitLeadActivity(supabase, {
        organizationId: handlerCtx.organization_id,
        leadId: String(destination.lead_id),
        contactId: origem.contact_id ?? null,
        type: "moved_from_pipeline",
        sourceModule: "crm",
        sourceId: leadId,
        actor: handlerCtx.actor,
        reason: nomeDoFunilDeOrigem ? `Veio do funil ${nomeDoFunilDeOrigem}` : "Veio de outro funil",
        payload: {
          from_pipeline_id: origem.pipeline_id,
          from_lead_id: leadId,
        },
      });
      if (!atividadeDoClone.ok) {
        // Falha BAIXO, como em `encerraDemanda`: o clone já existe, e prender a
        // troca à timeline deixaria a operação refém do registro. Contada, nunca
        // engolida.
        await registraFalhaDeAtividade(supabase, {
          organizationId: handlerCtx.organization_id,
          leadId: String(destination.lead_id),
          tipo: "moved_from_pipeline",
          origem: "app/api/v1/leads/[id]/clone",
          erro: atividadeDoClone.error,
          requestId,
        });
      }
    }

    if (gravacao.fechou && fechamento) {
      await registraEncerramentoDemanda(supabase, handlerCtx, {
        ...dadosDoFecho,
        payloadNaTimeline: { to_pipeline_id: input.pipeline_id, to_lead_id: destination.lead_id },
      }, fechamento, gravacao.origem);
    }

    await audit({
      action: "lead.moved_to_pipeline",
      actorUserId: authz.user.id,
      organizationId: handlerCtx.organization_id,
      resourceType: "crm_lead",
      resourceId: leadId,
      requestId,
      metadata: {
        actor_type: "user",
        from_pipeline_id: origem.pipeline_id,
        to_pipeline_id: input.pipeline_id,
        to_stage_id: destination.stage_id,
        cloned_lead_id: destination.lead_id,
        lost_reason: motivo,
      },
    });

    return respostaDoClone(gravacao, requestId);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
