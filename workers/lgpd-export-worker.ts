/**
 * lgpd-export-worker — consumes `lgpd.data_request_received` events.
 *
 * Pipeline (S-08.04):
 *   1. Load lgpd_requests row (programmatic org filter).
 *   2. Move status received -> processing, attempts++ (cap at 3).
 *   3. collectExportData → varredura das tabelas que a anonimização alcança (PII-safe).
 *      Sem contagem fixa aqui: esta linha dizia "8 tabelas" muito depois de serem dezenas.
 *   4. Render PDF via @react-pdf/renderer (PT-BR, Art. 18 II).
 *   5. signPdfPades — STUB when LGPD_SIGNING_KEY missing (warning, no throw).
 *   6. Upload PDF + JSON to bucket `lgpd-exports/{org}/{request}/...`.
 *   7. Create signed URL (LGPD_EXPORT_EXPIRES_HOURS, default 72h).
 *   8. Resolve delivery email: request_payload.delivery.address || contact.email.
 *   9. sendExportEmail (Resend) — sha256(email) in logs only.
 *   10. Mark status='completed', persist result metadata (paths, sha256, signed flag,
 *       delivered_to_hash, message_id, warning).
 *   11. Emit lgpd.export_generated + lgpd.export_delivered.
 *   12. Audit both with sanitized payload.
 *
 * Failure: do NOT throw out of the handler — increment attempts and surface
 * an "error" status so the dispatcher can retry. PII never appears in error
 * messages or Sentry breadcrumbs (only ids + hashes).
 */

import { createHash } from "node:crypto";

import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { collectExportData } from "@/lib/lgpd/export-collector";
import { findLgpdRequest } from "@/lib/lgpd/repository";
import type { LgpdRequestStatus } from "@/lib/lgpd/types";
// IMPORT TARDIO, e a razão é o laço rápido do `event_log`.
//
// `lib/event-log/register-handlers.ts` — cujo próprio comentário pede "keep it
// lightweight" — importa o handler da LGPD no topo, e ele importava este
// arquivo, que importava o gerador de PDF, que arrasta `@react-pdf/renderer`
// inteiro. Resultado: TODA montagem do laço carregava a pilha de PDF só para
// registrar um handler que, na esmagadora maioria das rodadas, não roda.
//
// Isso deixou de ser só desperdício em 29/08, quando `@react-pdf/hyphenate`
// passou a declarar `exports` sem a condição `require`: sob `tsx` (que é como o
// worker roda, e diferente do vitest, que resolve pelo Vite) o import falhava,
// `carregarDeps()` caía no catch, e o laço rápido MORRIA — 10 dias e três
// releases, com a guarda 6/6 verde.
//
// O patch em `patches/` conserta a dependência e continua valendo. Este import
// tardio conserta a CAUSA: o laço deixa de depender de PDF para existir. Um
// depende de o pnpm aplicar o patch em todo ambiente; o outro, não.
import { signPdfPades, isPadesConfigured } from "@/lib/lgpd/pades-signer";
import {
  EmailNotConfigured,
  EmailSendFailed,
  hashEmail,
  sendExportEmail,
} from "@/lib/lgpd/email-delivery";
import { createAdminClient } from "@/lib/supabase/admin";
import { marcaDaSaida } from "@/lib/branding/saida";

const MAX_ATTEMPTS = 3;
const BUCKET = "lgpd-exports";

/**
 * Depois disto, uma reivindicação de exportação é considerada ÓRFÃ e o próximo
 * evento pode retomá-la: a mesma janela do reaper do `event_log`
 * (`PROCESSING_STALE_MS`, `lib/event-log/drain.ts`). Processo derrubado no meio
 * do export não pode deixar o pedido preso para sempre.
 */
const EXPORT_CLAIM_STALE_MS = 10 * 60 * 1000;

function expiresHours(): number {
  const raw = process.env.LGPD_EXPORT_EXPIRES_HOURS ?? env.LGPD_EXPORT_EXPIRES_HOURS;
  const n = Number.parseInt(String(raw ?? "72"), 10);
  return Number.isFinite(n) && n > 0 ? n : 72;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * TODA gravação de estado do pedido passa por aqui, e o erro é LIDO.
 *
 * Até a migration 0356 o banco recusava `pending_review` (23514) e nenhum dos
 * updates deste arquivo conferia a resposta: o worker auditava "exportado",
 * devolvia `ok` ao dreno, e o pedido do titular ficava em "Processando" para
 * sempre. Pedido de LGPD perdido em silêncio é problema legal, então a recusa
 * vira log de erro aqui e desfecho `error` em quem chamou.
 *
 * Devolve o CÓDIGO do erro, ou `null` quando gravou. Só o código: a mensagem e
 * o detalhe do Postgres trazem a linha recusada, e a linha traz o e-mail do
 * titular. `status` tipado por `LgpdRequestStatus` é o que prende este arquivo
 * ao vocabulário que o banco aceita (o par está no invariante de vocabulário).
 */
async function gravarEstado(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  requestId: string,
  patch: { status: LgpdRequestStatus } & Record<string, unknown>,
): Promise<string | null> {
  let codigo: string | null = null;
  try {
    const { error } = await admin
      .from("lgpd_requests")
      .update(patch)
      .eq("organization_id", orgId)
      .eq("id", requestId);
    if (error) codigo = error.code || "sem_codigo";
  } catch {
    // Rede caída ou cliente que lança: também é "não gravou".
    codigo = "sem_resposta";
  }
  if (codigo) {
    logger.error("[lgpd-export-worker] o banco recusou a gravação de estado do pedido", {
      request_id: shortId(requestId),
      organization_id: orgId,
      status: patch.status,
      error_code: codigo,
    });
  }
  return codigo;
}

export async function processLgpdExport(event: EventRow): Promise<HandlerResult> {
  const orgId = event.organization_id;
  const requestId =
    (event.payload?.["request_id"] as string | undefined) ?? event.entity_id ?? null;

  if (!requestId) {
    logger.warn("[lgpd-export-worker] missing request_id in event", {
      event_id: event.id,
    });
    return {
      consumer_key: "lgpd-export-worker.v1",
      status: "skipped",
      detail: "missing_request_id",
    };
  }

  const admin = createAdminClient();

  // 1. Load request.
  const req = await findLgpdRequest(orgId, requestId).catch((err: unknown) => {
    logger.error("[lgpd-export-worker] findLgpdRequest threw", {
      request_id: shortId(requestId),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });

  if (!req) {
    return {
      consumer_key: "lgpd-export-worker.v1",
      status: "skipped",
      detail: "request_not_found",
    };
  }

  if (req.status === "completed") {
    return {
      consumer_key: "lgpd-export-worker.v1",
      status: "skipped",
      detail: "already_completed",
    };
  }

  if (req.request_type !== "data_request") {
    return {
      consumer_key: "lgpd-export-worker.v1",
      status: "skipped",
      detail: "wrong_request_type",
    };
  }

  // 2. attempts cap + transition to processing.
  const nextAttempts = req.attempts + 1;
  if (nextAttempts > MAX_ATTEMPTS) {
    const erroAoDesistir = await gravarEstado(admin, orgId, requestId, {
      status: "failed",
      error_message: "max_attempts_exceeded",
    });
    await audit({
      action: "lgpd.export_failed",
      organizationId: orgId,
      resourceType: "lgpd_request",
      resourceId: requestId,
      metadata: {
        reason: "max_attempts_exceeded",
        attempts: req.attempts,
        ...(erroAoDesistir ? { status_write_failed: erroAoDesistir } : {}),
      },
      bypassedRls: true,
    });
    return {
      consumer_key: "lgpd-export-worker.v1",
      status: "error",
      detail: erroAoDesistir
        ? `max_attempts_exceeded; status_write_failed: ${erroAoDesistir}`
        : "max_attempts_exceeded",
    };
  }

  // ─── REIVINDICAÇÃO ATÔMICA ─────────────────────────────────────────────────
  // Portado do projeto original (DeskcommCRM PR 2752 de @Tong-bit-art, issue 2751 lá).
  //
  // Dois eventos do MESMO pedido (o webhook e a aprovação emitem
  // `lgpd.data_request_received` cada um, e o reaper devolve à fila um evento
  // preso) podem rodar em paralelo nos dois drenos. Os dois leem o pedido fora
  // de `completed` e, antes desta reivindicação, os dois exportavam
  // (`attempts=2`, dois `lgpd.export_generated`, e-mail em dobro). Quem exporta
  // é quem CONSEGUE gravar `export_claimed_at`: o UPDATE é a trava, e o
  // predicado é reavaliado contra a linha já comitada por quem chegou primeiro.
  //
  // O marcador é do WORKER, não do fluxo: a aprovação também grava `processing`
  // (é o estado que a tela mostra), e `status` sozinho não distingue "aprovado,
  // ainda na fila" de "exportando agora". Reivindicação vencida é órfã (processo
  // derrubado) e o próximo evento retoma.
  const limiteDaReivindicacao = new Date(Date.now() - EXPORT_CLAIM_STALE_MS).toISOString();
  const { data: reivindicado, error: erroDaReivindicacao } = await admin
    .from("lgpd_requests")
    .update({
      status: "processing",
      attempts: nextAttempts,
      export_claimed_at: new Date().toISOString(),
    })
    .eq("organization_id", orgId)
    .eq("id", requestId)
    .neq("status", "completed")
    .or(`export_claimed_at.is.null,export_claimed_at.lt.${limiteDaReivindicacao}`)
    .select("id");

  if (erroDaReivindicacao) {
    // O banco não respondeu à trava: não sabemos se reivindicou. Lido como
    // "outro está exportando", o dreno consumiria o evento e o pedido ficaria
    // sem exportação nem nova tentativa. `error` faz o dreno contar a tentativa
    // e reagendar. Só o código: a mensagem do Postgres pode trazer a linha.
    return {
      consumer_key: "lgpd-export-worker.v1",
      status: "error",
      detail: `claim_failed: ${erroDaReivindicacao.code}`,
    };
  }

  if (!reivindicado?.length) {
    // Não reivindicou: outro evento está exportando agora, ou concluiu entre a
    // leitura e a reivindicação. O motivo fica no `detail` (o dreno o grava em
    // `last_error`) e o evento é consumido como sucesso: o trabalho não é dele.
    const atual = await findLgpdRequest(orgId, requestId).catch(() => null);
    return {
      consumer_key: "lgpd-export-worker.v1",
      status: "skipped",
      detail: atual?.status === "completed" ? "already_completed" : "already_in_flight",
    };
  }

  try {
    // 3. Collect data.
    const data = await collectExportData({
      organizationId: orgId,
      requestId,
      contactId: req.contact_id,
      externalCustomerId: req.external_customer_id,
    });

    // 4. Render PDF (with warning banner when unsigned).
    const padesConfigured = isPadesConfigured();
    const { renderLgpdPdf } = await import("@/lib/lgpd/pdf-renderer");
    const pdfBuffer = await renderLgpdPdf(data, { unsignedWarning: !padesConfigured });

    // 5. Sign (stubbed when key missing).
    const signResult = await signPdfPades(pdfBuffer);

    // 6. Upload artifacts.
    const jsonPath = `${orgId}/${requestId}/data.json`;
    const pdfPath = `${orgId}/${requestId}/report.pdf`;

    const jsonBytes = Buffer.from(JSON.stringify(data, null, 2), "utf-8");

    const { error: jsonUploadErr } = await admin.storage
      .from(BUCKET)
      .upload(jsonPath, jsonBytes, {
        contentType: "application/json",
        upsert: true,
      });
    if (jsonUploadErr) {
      throw new Error(`json_upload_failed: ${jsonUploadErr.message}`);
    }

    const { error: pdfUploadErr } = await admin.storage
      .from(BUCKET)
      .upload(pdfPath, signResult.signed, {
        contentType: "application/pdf",
        upsert: true,
      });
    if (pdfUploadErr) {
      throw new Error(`pdf_upload_failed: ${pdfUploadErr.message}`);
    }

    // 7. Signed URL.
    const expiresInSec = expiresHours() * 60 * 60;
    const expiresAt = new Date(Date.now() + expiresInSec * 1000);

    const { data: signed, error: signedErr } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(pdfPath, expiresInSec);
    if (signedErr || !signed) {
      throw new Error(`signed_url_failed: ${signedErr?.message ?? "no_url"}`);
    }

    // 8. Resolve delivery email.
    const deliveryFromPayload = (req.request_payload as Record<string, unknown>)?.delivery as
      | Record<string, unknown>
      | undefined;
    const deliveryEmail =
      (typeof deliveryFromPayload?.address === "string"
        ? (deliveryFromPayload.address as string)
        : null) ?? data.contact?.email ?? null;

    if (!deliveryEmail) {
      // Mark as pending_review — operator must contact manually.
      // Se o banco recusar, lança: cai no catch do handler, que devolve o pedido
      // à fila (ou a `failed` no teto) com o código em `error_message`, e o
      // `lgpd.export_generated` abaixo não é escrito para um desfecho que não houve.
      const erroSemEndereco = await gravarEstado(admin, orgId, requestId, {
        status: "pending_review",
        error_message: "no_delivery_email",
        result: {
          pdf_path: pdfPath,
          json_path: jsonPath,
          sha256: signResult.sha256,
          signed_pades: signResult.signed_pades,
          warning: signResult.warning ?? null,
        },
      });
      if (erroSemEndereco) throw new Error(`pending_review_update_failed: ${erroSemEndereco}`);
      await audit({
        action: "lgpd.export_generated",
        organizationId: orgId,
        resourceType: "lgpd_request",
        resourceId: requestId,
        metadata: {
          sha256: signResult.sha256,
          signed_pades: signResult.signed_pades,
          warning: signResult.warning ?? null,
          delivery: "pending_review_no_email",
        },
        bypassedRls: true,
      });
      return {
        consumer_key: "lgpd-export-worker.v1",
        status: "ok",
        detail: "pending_review_no_email",
      };
    }

    const deliveredHash = hashEmail(deliveryEmail);

    // 9. Send email (Resend). Failure here is retriable.
    let messageId: string | null = null;
    try {
      // Classe A: há organização, então o e-mail diz quem PROCESSOU — a marca
      // resolvida da org, e não a nossa. O PDF em anexo continua nomeando o
      // controlador legal, de propósito (ver `lib/lgpd/pdf-renderer.tsx`).
      const sent = await sendExportEmail({
        to: deliveryEmail,
        requestId,
        signedUrl: signed.signedUrl,
        expiresAt,
        marca: await marcaDaSaida(orgId),
      });
      messageId = sent.messageId;
    } catch (err) {
      if (err instanceof EmailNotConfigured) {
        // Operator gap — mark pending_review (no retry helps). Erro lido, como acima.
        const erroSemTransporte = await gravarEstado(admin, orgId, requestId, {
          status: "pending_review",
          error_message: "email_not_configured",
          result: {
            pdf_path: pdfPath,
            json_path: jsonPath,
            sha256: signResult.sha256,
            signed_pades: signResult.signed_pades,
            warning: signResult.warning ?? null,
            delivered_to_hash: deliveredHash,
          },
        });
        if (erroSemTransporte) throw new Error(`pending_review_update_failed: ${erroSemTransporte}`);
        await audit({
          action: "lgpd.export_generated",
          organizationId: orgId,
          resourceType: "lgpd_request",
          resourceId: requestId,
          metadata: {
            sha256: signResult.sha256,
            signed_pades: signResult.signed_pades,
            warning: "email_not_configured",
            delivered_to_hash: deliveredHash,
          },
          bypassedRls: true,
        });
        return {
          consumer_key: "lgpd-export-worker.v1",
          status: "ok",
          detail: "email_not_configured",
        };
      }
      // Generic Resend failure — set status back so cron retries.
      const detail = err instanceof EmailSendFailed ? err.message : String(err);
      logger.warn("[lgpd-export-worker] email send failed", {
        request_id: shortId(requestId),
        error_hash: sha256(detail),
      });
      // Se nem esta gravação entrar, o pedido fica em `processing` com a
      // reivindicação de pé: o dreno repete o evento (o desfecho é `error`) e,
      // vencida a janela de órfã, a próxima tentativa retoma.
      const erroAoDevolver = await gravarEstado(admin, orgId, requestId, {
        status: "received",
        error_message: "email_send_failed",
        // A falha devolve o pedido à fila: limpa a reivindicação para o retry
        // imediato não esperar a janela de órfã.
        export_claimed_at: null,
      });
      return {
        consumer_key: "lgpd-export-worker.v1",
        status: "error",
        detail: erroAoDevolver
          ? `email_send_failed; status_write_failed: ${erroAoDevolver}`
          : "email_send_failed",
      };
    }

    // 10. Mark completed.
    const result = {
      pdf_path: pdfPath,
      json_path: jsonPath,
      sha256: signResult.sha256,
      signed_pades: signResult.signed_pades,
      warning: signResult.warning ?? null,
      delivered_to_hash: deliveredHash,
      message_id: messageId,
      expires_at: expiresAt.toISOString(),
    };

    // O e-mail JÁ SAIU. Lançar aqui levaria ao catch, que devolve o pedido à
    // fila e manda o relatório ao titular de novo. Então: tenta gravar duas
    // vezes; se o banco seguir recusando, marca `failed` com o motivo (para a
    // tela não mostrar "Processando" num pedido entregue), audita e devolve
    // `error`, sem reenviar nada.
    const concluido = {
      status: "completed" as const,
      completed_at: new Date().toISOString(),
      result,
      error_message: null,
    };
    const erroAoConcluir =
      (await gravarEstado(admin, orgId, requestId, concluido)) &&
      (await gravarEstado(admin, orgId, requestId, concluido));
    if (erroAoConcluir) {
      await gravarEstado(admin, orgId, requestId, {
        status: "failed",
        error_message: `entregue_mas_conclusao_nao_gravada: ${erroAoConcluir}`,
        result,
      });
      await audit({
        action: "lgpd.export_failed",
        organizationId: orgId,
        resourceType: "lgpd_request",
        resourceId: requestId,
        metadata: {
          reason: "completed_update_failed",
          status_write_failed: erroAoConcluir,
          delivered: true,
          delivered_to_hash: deliveredHash,
          message_id: messageId,
          attempts: nextAttempts,
        },
        bypassedRls: true,
      });
      return {
        consumer_key: "lgpd-export-worker.v1",
        status: "error",
        detail: `completed_update_failed: ${erroAoConcluir}`,
      };
    }

    // 11. Domain events.
    await admin.rpc("emit_event" as never, {
      p_event_type: "lgpd.export_generated",
      p_entity_kind: "lgpd_request",
      p_entity_id: requestId,
      p_payload: {
        request_id: requestId,
        sha256: signResult.sha256,
        signed_pades: signResult.signed_pades,
        warning: signResult.warning ?? null,
      },
      p_metadata: { source: "lgpd-export-worker" },
      p_organization_id: orgId,
    } as never);

    await admin.rpc("emit_event" as never, {
      p_event_type: "lgpd.export_delivered",
      p_entity_kind: "lgpd_request",
      p_entity_id: requestId,
      p_payload: {
        request_id: requestId,
        delivered_to_hash: deliveredHash,
        message_id: messageId,
        expires_at: expiresAt.toISOString(),
      },
      p_metadata: { source: "lgpd-export-worker" },
      p_organization_id: orgId,
    } as never);

    // 12. Audit (sanitized — no plaintext email anywhere).
    await audit({
      action: "lgpd.export_generated",
      organizationId: orgId,
      resourceType: "lgpd_request",
      resourceId: requestId,
      metadata: {
        sha256: signResult.sha256,
        signed_pades: signResult.signed_pades,
        warning: signResult.warning ?? null,
        contact_id: req.contact_id,
        attempts: nextAttempts,
      },
      bypassedRls: true,
    });
    await audit({
      action: "lgpd.export_delivered",
      organizationId: orgId,
      resourceType: "lgpd_request",
      resourceId: requestId,
      metadata: {
        delivered_to_hash: deliveredHash,
        message_id: messageId,
        expires_at: expiresAt.toISOString(),
        delivery: "ok",
      },
      bypassedRls: true,
    });

    logger.info("[lgpd-export-worker] export completed", {
      request_id: shortId(requestId),
      organization_id: orgId,
      sha256: signResult.sha256,
      signed_pades: signResult.signed_pades,
      delivered_to_hash: deliveredHash,
    });

    return {
      consumer_key: "lgpd-export-worker.v1",
      status: "ok",
      detail: signResult.signed_pades ? "completed_signed" : "completed_unsigned",
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // PII-safe: log error_hash, never the raw message.
    logger.error("[lgpd-export-worker] export failed", {
      request_id: shortId(requestId),
      organization_id: orgId,
      error_hash: sha256(detail),
      attempts: nextAttempts,
    });

    const erroAoRegistrarFalha = await gravarEstado(admin, orgId, requestId, {
      status: nextAttempts >= MAX_ATTEMPTS ? "failed" : "received",
      error_message: detail.slice(0, 500),
      // Sem reivindicação pendurada: o retry (received) reclama na hora, e o
      // desistido (failed) não deixa marcador para trás.
      export_claimed_at: null,
    });

    await audit({
      action: "lgpd.export_failed",
      organizationId: orgId,
      resourceType: "lgpd_request",
      resourceId: requestId,
      metadata: {
        attempts: nextAttempts,
        error_hash: sha256(detail),
        ...(erroAoRegistrarFalha ? { status_write_failed: erroAoRegistrarFalha } : {}),
      },
      bypassedRls: true,
    });

    return {
      consumer_key: "lgpd-export-worker.v1",
      status: "error",
      detail: erroAoRegistrarFalha
        ? `export_failed_will_retry; status_write_failed: ${erroAoRegistrarFalha}`
        : "export_failed_will_retry",
    };
  }
}
