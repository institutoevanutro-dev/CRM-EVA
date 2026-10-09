import {sendWithLedger,supabaseSendLedger} from "@/lib/agent-engine/edge/crm/send-ledger";
import { randomUUID } from "node:crypto";
import { assertAgendaEffectSupabase } from "@/lib/agenda/efeito";
import { AgendaDeferredError } from "@/lib/agenda/protecao-followup";
import { parseServiceBoundary, StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { assertServiceBoundarySupabase } from "@/lib/atendimento/origem";
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import { createSupabaseAdminClient, type FollowupJobRequest } from "@/lib/followup/engine";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import { completeTurnForEnrollment, type TurnBridgeAdminClient } from "@/lib/followup/turn-bridge";
import { logger } from "@/lib/logger";
import { automaticoPodeEnviar } from "@/lib/channels/janela";
import { ERRO_FORA_DAS_24H } from "@/lib/agent-engine/edge/crm/send-ledger";
import {
  MOTIVO_TEXTO_VAZIO_SEM_NOME,
  OUTCOME_DO_BLOQUEIO,
  TEXTO_DO_BLOQUEIO,
  conferirAntesDoEnvio,
} from "@/lib/followup/bloqueios-obrigatorios";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { adiarAteAJanelaAbrir } from "@/lib/automation/janela-do-canal";
import { espacarEnvio } from "@/lib/automation/throttle";
import { interpolateTemplate } from "@/lib/inbox/template-vars";

const TEM_VARIAVEL_DO_NOME = /\{\{\s*(nome|primeiro_nome)\s*\}\}/i;

function ponteSupabase(admin: SupabaseClient): TurnBridgeAdminClient {
  const base = createSupabaseAdminClient(admin);
  return {
    ...base,
    async assertFollowupJob(orgId,jobId,enrollmentId,nodeId,claim){
      if(!claim)throw new StaleServiceBoundaryError();
      const held=await admin.rpc("fn_followup_claim_current",{p_org:orgId,p_job:jobId,p_worker:claim.worker_id,p_acquired_at:claim.acquired_at});
      if(held.error)throw held.error;if(!held.data)throw new StaleServiceBoundaryError();
      const {data,error}=await admin.rpc("fn_followup_job_current",{p_org:orgId,p_job:jobId,p_enrollment:enrollmentId,p_node:nodeId});
      if(error) throw error;
      if(!data) throw new StaleServiceBoundaryError();
    },
    async loadEnrollmentById(orgId, id) {
      const { data, error } = await admin
        .from("followup_enrollments")
        .select("*")
        .eq("id", id)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      return data as EnrollmentRow;
    },
  };
}

/**
 * Envia o texto fixo do fluxo neste request — sem cron e sem agent-worker.
 *
 * Disputa o mesmo job com o worker, então decide o envio com a MESMA função
 * (`conferirAntesDoEnvio`: janela da organização, resposta com cancel_on_reply,
 * humano ativo, liberação do número (gate do canal), etapa que bloqueia,
 * anonimizado…) e respeita a janela anti-ban
 * do canal e o ritmo da automação. O resto da cadeia `runBeforeSend` (caps,
 * repetição, LGPD, promessas) continua só no worker.
 */
export async function enviarTextoFixoPendente(
  admin: SupabaseClient,
  somenteContactIds?: string[],
): Promise<number> {
  const { data: jobs, error } = await admin
    .from("job_queue")
    .select("id, organization_id, contact_id, payload, attempts, max_attempts")
    .eq("kind", "followup_turn")
    .eq("status", "pending")
    .lte("run_after",new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(5);
  if (error) throw new Error(error.message);

  const workerId=`inline-followup:${randomUUID()}`;
  // `adiarPara`: o job volta a `pending` na abertura da janela, sem gastar tentativa.
  async function settle(org:string,id:string,acquiredAt:string,done:boolean,error?:string,deferred?:AgendaDeferredError,adiarPara?:string){
    const {data:held,error:failure}=await admin.rpc("fn_followup_inline_settle",{p_org:org,p_id:id,p_worker:workerId,p_acquired_at:acquiredAt,p_done:done,p_error:error??null,p_retry_at:adiarPara??deferred?.protection.reavaliar_em??null,p_hold:!!adiarPara||(!!deferred&&deferred.protection.motivo!=="leitura_indisponivel")});
    if(failure) throw failure;
    if(!held) throw new StaleServiceBoundaryError();
  }
  let enviados = 0;
  const ponte = ponteSupabase(admin);
  for (const job of jobs ?? []) {
    const payload = (job.payload ?? {}) as FollowupJobRequest["payload"];
    const body = payload.fixed_body;
    const enrollmentId = payload.followup_enrollment_id;
    const nodeId = payload.node_id;
    const contactId = job.contact_id as string | null;
    // ponytail: só texto fixo é drenado aqui; passo de mídia (`media_id`, sem fixed_body)
    // fica com o agent-worker, presente em toda instalação self-host. Drenar mídia aqui
    // exige o envio com `media_library_item_id` e o tratamento da 422 de mídia recusada.
    if (typeof body !== "string" || !body || !enrollmentId || !nodeId || !contactId) continue;
    if (somenteContactIds && !somenteContactIds.includes(contactId)) continue;

    const { data: claimed, error: claimErr } = await admin
      .from("job_queue")
      .update({ status: "running",attempts:Number(job.attempts??0)+1,locked_by:workerId,locked_at:new Date().toISOString() })
      .eq("id", job.id)
      .eq("organization_id",job.organization_id)
      .eq("status", "pending")
      .lte("run_after",new Date().toISOString())
      .select("id,locked_by,locked_at")
      .maybeSingle();
    if (claimErr) throw new Error(claimErr.message);
    if (!claimed) continue;
    const jobClaim={worker_id:claimed.locked_by as string,acquired_at:claimed.locked_at as string};

    try {
      const { data: enr } = await admin
        .from("followup_enrollments")
        .select("current_node_id,status,revision")
        .eq("id", enrollmentId)
        .eq("organization_id", job.organization_id as string)
        .maybeSingle();
      if (!enr || enr.current_node_id !== nodeId || !["active","waiting_reply"].includes(enr.status)) {
        await settle(job.organization_id,job.id,jobClaim.acquired_at,true);
        continue;
      }
      const boundary = parseServiceBoundary((job.payload as Record<string, unknown>).service_boundary);
      await assertServiceBoundarySupabase(admin, boundary);
      const conversationId = boundary!.conversation_id;

      // A MESMA decisão do worker (`runFlowDrivenTurn`), com a mesma tradução.
      const decisao = await conferirAntesDoEnvio(
        getRequestPool(),
        { organizationId: job.organization_id as string, contactId, conversationId, enrollmentId },
        new Date(),
      );
      if (!decisao.envia) {
        logger.info("[followup] texto fixo barrado por bloqueio obrigatório", {
          organization_id: job.organization_id,
          enrollment_id: enrollmentId,
          motivo: decisao.motivo,
        });
        if (decisao.motivo === "fora_das_24h_do_instagram") {
          await completeTurnForEnrollment(ponte, job.organization_id, enrollmentId, nodeId, {
            kind: "pulado", reason: TEXTO_DO_BLOQUEIO.fora_das_24h_do_instagram,
          },undefined,job.id,jobClaim);
          await settle(job.organization_id,job.id,jobClaim.acquired_at,true);
          continue;
        }
        if (decisao.motivo === "fora_da_janela") {
          // O adiamento volta para o enrollment ANTES do settle (que solta o
          // job): sem isto o motor lia a espera como worker morto e marcava `dead`.
          await completeTurnForEnrollment(ponte, job.organization_id, enrollmentId, nodeId, {
            kind: "deferred", until: decisao.adiarPara, reason: "fora_da_janela",
          },undefined,job.id,jobClaim);
          await settle(job.organization_id,job.id,jobClaim.acquired_at,false,TEXTO_DO_BLOQUEIO.fora_da_janela,undefined,decisao.adiarPara.toISOString());
          continue;
        }
        if (decisao.invalida) {
          const outcome = OUTCOME_DO_BLOQUEIO[decisao.motivo];
          await completeTurnForEnrollment(ponte, job.organization_id, enrollmentId, nodeId, {
            kind: "skipped", reason: TEXTO_DO_BLOQUEIO[decisao.motivo], ...(outcome ? { outcome } : {}),
          },undefined,job.id,jobClaim);
          await settle(job.organization_id,job.id,jobClaim.acquired_at,true);
          continue;
        }
        if (decisao.motivo === "inscricao_encerrada") {
          await settle(job.organization_id,job.id,jobClaim.acquired_at,true);
          continue;
        }
        // Não verificável / configuração inválida: falha fechada, como o throw do worker.
        throw new Error(TEXTO_DO_BLOQUEIO[decisao.motivo]);
      }
      // Fora das 24h do Instagram o passo é PULADO e o fluxo segue: nem
      // cancela, nem reagenda, nem reenvia. Mesma porta da recusa do servidor.
      const pular = async () => {
        await completeTurnForEnrollment(ponte, job.organization_id, enrollmentId, nodeId, {
          kind: "pulado", reason: TEXTO_DO_BLOQUEIO.fora_das_24h_do_instagram,
        },undefined,job.id,jobClaim);
        await settle(job.organization_id,job.id,jobClaim.acquired_at,true);
      };
      const { data: canal, error: canalErr } = await admin
        .from("conversations")
        .select("last_inbound_at, channel_session_id, channel_sessions:channel_session_id(provider)")
        .eq("organization_id", job.organization_id as string)
        .eq("id", conversationId)
        .maybeSingle();
      if (canalErr) throw new Error(canalErr.message);
      const linha = canal as { last_inbound_at: string | null; channel_session_id: string | null; channel_sessions: { provider: string | null } | null } | null;
      if (!linha?.channel_session_id) throw new Error("followup_conversa_sem_canal");
      if (!automaticoPodeEnviar(linha.channel_sessions?.provider, linha.last_inbound_at ?? null, new Date())) {
        await pular();
        continue;
      }
      // Janela anti-ban DO NÚMERO (Conexões → `channel_knobs`; 7h–22h por padrão).
      const abreEm = await adiarAteAJanelaAbrir(admin, job.organization_id as string, linha.channel_session_id);
      if (abreEm !== null) {
        await completeTurnForEnrollment(ponte, job.organization_id, enrollmentId, nodeId, {
          kind: "deferred", until: new Date(abreEm), reason: "outside_window",
        },undefined,job.id,jobClaim);
        await settle(job.organization_id,job.id,jobClaim.acquired_at,false,"Envio adiado: fora da janela de envio do número.",undefined,abreEm);
        continue;
      }

      const proactiveContext={organizationId:job.organization_id as string,contactId,enrollmentId,nodeId,jobId:job.id,jobClaim};
      await assertAgendaEffectSupabase(admin,proactiveContext);
      await espacarEnvio(linha.channel_session_id);
      // {{nome}}/{{primeiro_nome}} com o contato de AGORA, a mesma regra do
      // worker (`resolveFlowSendBody`). O ledger guarda o texto que saiu.
      let texto = body;
      if (TEM_VARIAVEL_DO_NOME.test(body)) {
        const { data: pessoa, error: pessoaErr } = await admin
          .from("contacts")
          .select("name, display_name")
          .eq("organization_id", job.organization_id as string)
          .eq("id", contactId)
          .maybeSingle();
        if (pessoaErr) throw new Error(pessoaErr.message);
        texto = interpolateTemplate(body, pessoa ?? {}, { semValor: "remover" });
      }
      if (texto === "") {
        await completeTurnForEnrollment(ponte, job.organization_id, enrollmentId, nodeId, {
          kind: "pulado", reason: MOTIVO_TEXTO_VAZIO_SEM_NOME,
        },undefined,job.id,jobClaim);
        await settle(job.organization_id,job.id,jobClaim.acquired_at,true);
        continue;
      }
      let erroDoServidor: string | null = null;
      const resultado=await sendWithLedger(supabaseSendLedger(admin),{tenantId:job.organization_id,leadId:contactId,jobId:job.id,seq:1,body:texto},async(key,messageId)=>{
        const m=await sendMessageHandler(
          admin,
          {organization_id:job.organization_id,actor:{type:"webhook_source",id:enrollmentId},serviceBoundary:boundary,proactiveContext,origemDoEnvio:"followup",internalMessageId:messageId,requestId:key},
          {conversation_id:conversationId,type:"text",body:texto,metadata:{idempotency_key:key}},
        );
        erroDoServidor=(m as { error_code?: string | null }).error_code ?? null;
        return m;
      });
      if(resultado.kind==="failed" && erroDoServidor===ERRO_FORA_DAS_24H){ await pular(); continue; }
      if(resultado.kind!=="sent" && resultado.kind!=="already_sent") throw new Error(`message_${resultado.kind}`);
      enviados++;
      await completeTurnForEnrollment(ponte, job.organization_id, enrollmentId, nodeId, {
        kind: "sent",
      },undefined,job.id,jobClaim);
      await settle(job.organization_id,job.id,jobClaim.acquired_at,true);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      logger.warn("[dev.pipeline] envio inline falhou", { error: message });
      await settle(job.organization_id,job.id,jobClaim.acquired_at,err instanceof StaleServiceBoundaryError,message,err instanceof AgendaDeferredError?err:undefined);
    }
  }
  return enviados;
}
