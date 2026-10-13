/**
 * lgpd-redact-worker — consumes `lgpd.redact_received` events.
 *
 * Pipeline (S-08.05):
 *   1. Load lgpd_requests row (programmatic org filter).
 *   2. Status guard (skip when already completed/failed beyond cap).
 *   2b. PORTÃO: o pedido tem de provar a aprovação (ver abaixo). Sem ela,
 *       `skipped`, sem gravar nada e sem anonimizar.
 *   3. attempts++ (cap 3 → status='failed').
 *   4. Branch by scope:
 *      - 'contact': resolve contactId (req.contact_id || external_customer_id);
 *        if absent → status='pending_review' (L-03 no local footprint).
 *        Else call RPC fn_lgpd_cascade_redact_contact (atomic TX).
 *      - 'tenant' (emergency=true, store-level uninstall): batch loop of 100
 *        contacts with checkpointed offset persisted in
 *        request_payload.progress. On finish: organizations.status='redacted'
 *        + redacted_at=now().
 *   5. Mark status='completed' (or 'partial_failure' for tenant).
 *   6. Try Nuvemshop callback (stub when adapter missing).
 *   7. Emit lgpd.redact_applied (success) or lgpd.redact_failed (error).
 *   8. Audit at request-level (the per-contact dense audit row is already
 *      inserted by the RPC).
 *
 * Zero PII in logs / Sentry — only ids + sha256 of error messages.
 *
 * ─── O EVENTO NÃO É AUTORIZAÇÃO ─────────────────────────────────────────────
 *
 * Até a migration 0357 este worker anonimizava ao receber o evento, sem olhar
 * se alguém tinha aprovado. O webhook da loja emitia ao criar o pedido, e
 * qualquer outro emissor do servidor faria o mesmo com um pedido registrado à
 * mão. Anonimização não tem volta.
 *
 * Agora quem autoriza é a LINHA DO PEDIDO: `request_payload.approval`, gravada
 * pela rota de aprovação (administrador, com justificativa). A regra é uma só,
 * no banco (`fn_lgpd_recusa_do_redact`), consultada aqui antes de qualquer
 * gravação e de novo pela cascata dentro da transação do irreversível. Nada do
 * payload do evento entra na decisão.
 *
 * Pedido sem aprovação: o evento é consumido como `skipped` (o dreno não tenta
 * de novo; o motivo fica em `event_log.last_error`), o pedido fica como está,
 * à espera de aprovação, e o alarme de prazo continua contando para ele.
 *
 * ─── ORDEM EM VOLTA DO IRREVERSÍVEL ─────────────────────────────────────────
 *
 * Antes da cascata só se grava `processing` (conferido: se o banco recusar, a
 * cascata não roda). A cascata é uma transação. Depois dela, NADA devolve o
 * pedido a `received`/`failed`: se o `completed` não gravar, o desfecho é
 * `error`, o dreno repete o evento, a cascata responde "já anonimizado" e o
 * pedido conclui. Executar duas vezes é impossível (a cascata confere
 * `is_anonymized` sob a trava do contato); dizer "não feito" do que foi feito
 * deixou de ser possível aqui.
 */

import { createHash } from "node:crypto";

import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { LgpdRequestStatus } from "@/lib/lgpd/types";
import { findContactByExternalId, findLgpdRequest } from "@/lib/lgpd/repository";
import { cascadeRedactContact } from "@/lib/lgpd/redact-cascade";
import { createAdminClient } from "@/lib/supabase/admin";

const MAX_ATTEMPTS = 3;
const TENANT_BATCH_SIZE = 100;

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

interface TenantProgress {
  processed: number;
  batch_offset: number;
  failed_contacts: string[];
}

function readTenantProgress(payload: Record<string, unknown> | null | undefined): TenantProgress {
  const raw = (payload?.["progress"] ?? null) as Record<string, unknown> | null;
  return {
    processed: typeof raw?.["processed"] === "number" ? (raw["processed"] as number) : 0,
    batch_offset: typeof raw?.["batch_offset"] === "number" ? (raw["batch_offset"] as number) : 0,
    failed_contacts: Array.isArray(raw?.["failed_contacts"])
      ? ((raw["failed_contacts"] as unknown[]).filter((x) => typeof x === "string") as string[])
      : [],
  };
}

/**
 * Grava o estado do pedido e CONFERE a resposta do banco. Devolve `null` quando
 * gravou, ou o código do erro. Só o código: `message`/`details` do Postgres
 * podem trazer a linha inteira, e a linha tem dado do titular. É o mesmo
 * contrato do `gravarEstado` do `lgpd-export-worker`.
 *
 * `soSe` restringe a gravação ao estado em que o pedido tem de estar (ou não
 * estar): zero linhas alcançadas não é erro, é "outro já gravou".
 */
async function gravarEstado(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  requestId: string,
  patch: { status: LgpdRequestStatus } & Record<string, unknown>,
  soSe?: { estado?: LgpdRequestStatus; naoEstado?: LgpdRequestStatus },
): Promise<string | null> {
  let codigo: string | null = null;
  try {
    let q = admin.from("lgpd_requests").update(patch).eq("organization_id", orgId).eq("id", requestId);
    if (soSe?.estado) q = q.eq("status", soSe.estado);
    if (soSe?.naoEstado) q = q.neq("status", soSe.naoEstado);
    const { error } = await q;
    if (error) codigo = error.code || "sem_codigo";
  } catch {
    // Rede caída ou cliente que lança: também é "não gravou".
    codigo = "sem_resposta";
  }
  if (codigo) {
    logger.error("[lgpd-redact-worker] o banco recusou a gravação de estado do pedido", {
      request_id: shortId(requestId),
      organization_id: orgId,
      status: patch.status,
      error_code: codigo,
    });
  }
  return codigo;
}

/**
 * Anonimizou e o estado final não gravou. NÃO lança: lançar cairia no `catch`
 * que devolve o pedido à fila como "não feito". O dreno repete o evento, a
 * cascata responde "já anonimizado" e o pedido conclui.
 */
function feitoSemRegistro(requestId: string, orgId: string, codigo: string): HandlerResult {
  logger.error("[lgpd-redact-worker] anonimizado, mas o estado final do pedido não gravou", {
    request_id: shortId(requestId),
    organization_id: orgId,
    error_code: codigo,
  });
  return {
    consumer_key: "lgpd-redact-worker.v1",
    status: "error",
    detail: `redacted_but_status_write_failed: ${codigo}`,
  };
}

/** Evento de domínio depois do irreversível: se não sair, registra e segue. */
async function emitirAplicado(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  requestId: string,
  payload: Record<string, unknown>,
  metadata: Record<string, unknown>,
): Promise<void> {
  let codigo: string | null = null;
  try {
    const { error } = await admin.rpc("emit_event" as never, {
      p_event_type: "lgpd.redact_applied",
      p_entity_kind: "lgpd_request",
      p_entity_id: requestId,
      p_payload: payload,
      p_metadata: metadata,
      p_organization_id: orgId,
    } as never);
    if (error) codigo = error.code || "sem_codigo";
  } catch {
    codigo = "sem_resposta";
  }
  if (codigo) {
    logger.error("[lgpd-redact-worker] lgpd.redact_applied não foi emitido", {
      request_id: shortId(requestId),
      organization_id: orgId,
      error_code: codigo,
    });
  }
}

async function tryNuvemshopCallback(
  organizationId: string,
  payload: Record<string, unknown>,
): Promise<{ called: boolean; status: string }> {
  // Best-effort: NuvemshopAdapter.redactCustomer is not yet implemented — the
  // Nuvemshop App API does not currently expose a confirmation endpoint for
  // GDPR/LGPD callbacks; receiving the webhook is the contract. We log a
  // structured warn so observability tools surface the gap and the audit log
  // marks the callback as 'not_implemented'.
  logger.warn("[lgpd-redact-worker] nuvemshop_callback_not_implemented", {
    organization_id: organizationId,
    has_store_id: typeof payload["store_id"] !== "undefined",
  });
  return { called: false, status: "not_implemented" };
}

export async function processLgpdRedact(event: EventRow): Promise<HandlerResult> {
  const orgId = event.organization_id;
  const requestId =
    (event.payload?.["request_id"] as string | undefined) ?? event.entity_id ?? null;
  const scopeFromEvent = (event.payload?.["scope"] as string | undefined) ?? "contact";
  const emergency = event.payload?.["emergency"] === true;

  if (!requestId) {
    logger.warn("[lgpd-redact-worker] missing request_id in event", { event_id: event.id });
    return {
      consumer_key: "lgpd-redact-worker.v1",
      status: "skipped",
      detail: "missing_request_id",
    };
  }

  const admin = createAdminClient();

  // 1. Load request row (programmatic org filter).
  const req = await findLgpdRequest(orgId, requestId).catch((err: unknown) => {
    logger.error("[lgpd-redact-worker] findLgpdRequest threw", {
      request_id: shortId(requestId),
      error_hash: sha256(err instanceof Error ? err.message : String(err)),
    });
    return null;
  });

  if (!req) {
    return {
      consumer_key: "lgpd-redact-worker.v1",
      status: "skipped",
      detail: "request_not_found",
    };
  }

  if (req.status === "completed") {
    return {
      consumer_key: "lgpd-redact-worker.v1",
      status: "skipped",
      detail: "already_completed",
    };
  }

  if (req.status === "failed") {
    return {
      consumer_key: "lgpd-redact-worker.v1",
      status: "skipped",
      detail: "already_failed",
    };
  }

  const wrongType = !(
    req.request_type === "redact" || req.request_type === "store_redact"
  );
  if (wrongType) {
    return {
      consumer_key: "lgpd-redact-worker.v1",
      status: "skipped",
      detail: "wrong_request_type",
    };
  }

  // 2b. PORTÃO. A pergunta vai com a organização do evento e o id do pedido; a
  // resposta sai da linha do pedido. Antes de QUALQUER gravação.
  let recusa: string | null;
  {
    let codigo: string | null = null;
    let resposta: unknown = null;
    try {
      const { data, error } = await admin.rpc("fn_lgpd_recusa_do_redact" as never, {
        p_organization_id: orgId,
        p_request_id: requestId,
        p_contact_id: null,
      } as never);
      if (error) codigo = error.code || "sem_codigo";
      resposta = data;
    } catch {
      codigo = "sem_resposta";
    }
    if (codigo) {
      // Sem resposta não se anonimiza e não se descarta: o dreno tenta de novo.
      logger.error("[lgpd-redact-worker] não foi possível conferir a aprovação do pedido", {
        request_id: shortId(requestId),
        organization_id: orgId,
        error_code: codigo,
      });
      return {
        consumer_key: "lgpd-redact-worker.v1",
        status: "error",
        detail: `approval_check_failed: ${codigo}`,
      };
    }
    recusa = typeof resposta === "string" && resposta.length > 0 ? resposta : null;
  }

  if (recusa) {
    logger.warn("[lgpd-redact-worker] pedido sem aprovação provada, nada foi anonimizado", {
      event_id: event.id,
      request_id: shortId(requestId),
      organization_id: orgId,
      request_status: req.status,
      reason: recusa,
    });
    // Pedido em `processing` com aprovação que não vale (quem aprovou deixou de
    // ser administrador, ou a prova foi alterada): volta a `received`, que é o
    // único estado que a tela deixa aprovar. `received` fica como está.
    if (req.status === "processing") {
      await gravarEstado(
        admin,
        orgId,
        requestId,
        { status: "received", error_message: `approval_not_proven: ${recusa}` },
        { estado: "processing" },
      );
    }
    return {
      consumer_key: "lgpd-redact-worker.v1",
      status: "skipped",
      detail: `not_approved:${recusa}`,
    };
  }

  // 2. attempts cap + transition to processing.
  const nextAttempts = req.attempts + 1;
  if (nextAttempts > MAX_ATTEMPTS) {
    // O teto é para quem NÃO conseguiu anonimizar. Contato já anonimizado e
    // pedido ainda aberto é o caso "feito, mas o estado final não gravou":
    // marcar `failed` seria dizer que não foi feito. Segue, e a cascata
    // (que responde "já anonimizado") fecha o pedido.
    let jaAnonimizado = false;
    if (req.scope === "contact" && req.contact_id) {
      const { data } = await admin
        .from("contacts")
        .select("is_anonymized")
        .eq("organization_id", orgId)
        .eq("id", req.contact_id)
        .maybeSingle();
      jaAnonimizado = (data as { is_anonymized?: boolean } | null)?.is_anonymized === true;
    }
    if (!jaAnonimizado) {
      const erroAoDesistir = await gravarEstado(admin, orgId, requestId, {
        status: "failed",
        error_message: "max_attempts_exceeded",
      });

      await audit({
        action: "lgpd.redact_failed",
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
        consumer_key: "lgpd-redact-worker.v1",
        status: "error",
        detail: erroAoDesistir
          ? `max_attempts_exceeded; status_write_failed: ${erroAoDesistir}`
          : "max_attempts_exceeded",
      };
    }
  }

  // Se `processing` não gravar, a cascata não roda: nada irreversível acontece
  // sem o pedido dizer que está em andamento. O dreno tenta de novo.
  const erroAoIniciar = await gravarEstado(admin, orgId, requestId, {
    status: "processing",
    attempts: nextAttempts,
  });
  if (erroAoIniciar) {
    return {
      consumer_key: "lgpd-redact-worker.v1",
      status: "error",
      detail: `status_write_failed: ${erroAoIniciar}`,
    };
  }

  const scope = req.scope ?? scopeFromEvent;

  try {
    // ---------------------------------------------------------------------
    // CONTACT scope
    // ---------------------------------------------------------------------
    if (scope === "contact") {
      let contactId = req.contact_id;

      if (!contactId && req.external_customer_id) {
        const found = await findContactByExternalId(orgId, req.external_customer_id, null);
        contactId = found?.id ?? null;
      }

      if (!contactId) {
        // L-03: no local footprint — request stays as record but nothing to anonymise.
        // Nada foi anonimizado até aqui: se o banco recusar, lança e o `catch`
        // devolve o pedido à fila, sem auditar um desfecho que não houve.
        const erroSemPegada = await gravarEstado(admin, orgId, requestId, {
          status: "pending_review",
          error_message: "no_local_footprint",
          result: { reason: "no_local_footprint" },
        });
        if (erroSemPegada) throw new Error(`pending_review_update_failed: ${erroSemPegada}`);

        await audit({
          action: "lgpd.redact_no_local_footprint",
          organizationId: orgId,
          resourceType: "lgpd_request",
          resourceId: requestId,
          metadata: { external_customer_id_present: Boolean(req.external_customer_id) },
          bypassedRls: true,
        });

        return {
          consumer_key: "lgpd-redact-worker.v1",
          status: "ok",
          detail: "pending_review_no_local_footprint",
        };
      }

      const cascade = await cascadeRedactContact({
        organizationId: orgId,
        contactId,
        requestId,
      });

      // ─── DAQUI PARA BAIXO O CONTATO JÁ ESTÁ ANONIMIZADO ─────────────────────
      // Nada abaixo pode lançar para o `catch`, que devolve o pedido a "não feito".

      if (cascade.alreadyAnonymized) {
        // `naoEstado`: se outra execução do mesmo pedido já gravou `completed`
        // com os números da cascata, esta não passa por cima.
        const erroJaFeito = await gravarEstado(
          admin,
          orgId,
          requestId,
          {
            status: "completed",
            completed_at: new Date().toISOString(),
            result: { already_anonymized: true, contact_id: contactId },
            error_message: null,
            cascaded_to: {},
          },
          { naoEstado: "completed" },
        );
        if (erroJaFeito) return feitoSemRegistro(requestId, orgId, erroJaFeito);

        await audit({
          action: "lgpd.redact_skipped_already_anonymized",
          organizationId: orgId,
          resourceType: "lgpd_request",
          resourceId: requestId,
          metadata: { contact_id: contactId },
          bypassedRls: true,
        });

        return {
          consumer_key: "lgpd-redact-worker.v1",
          status: "ok",
          detail: "already_anonymized",
        };
      }

      // Best-effort callback to upstream platform.
      const callback = await tryNuvemshopCallback(orgId, req.request_payload ?? {});

      const erroAoConcluir = await gravarEstado(admin, orgId, requestId, {
        status: "completed",
        completed_at: new Date().toISOString(),
        result: {
          contact_id: contactId,
          cascaded_to: cascade.counts,
          media_queued: cascade.mediaPaths.length,
          callback_status: callback.status,
        },
        cascaded_to: cascade.counts,
        error_message: null,
      });
      if (erroAoConcluir) return feitoSemRegistro(requestId, orgId, erroAoConcluir);

      // Domain event — applied (consumed by SLA monitor / dashboards).
      await emitirAplicado(
        admin,
        orgId,
        requestId,
        {
          request_id: requestId,
          contact_id: contactId,
          cascaded_to: cascade.counts,
          media_queued: cascade.mediaPaths.length,
        },
        { source: "lgpd-redact-worker" },
      );

      // Request-level audit (cascade RPC already wrote per-contact lgpd.redact_executed).
      await audit({
        action: "lgpd.redact_completed",
        organizationId: orgId,
        resourceType: "lgpd_request",
        resourceId: requestId,
        metadata: {
          contact_id: contactId,
          cascaded_to: cascade.counts,
          media_queued: cascade.mediaPaths.length,
          callback_status: callback.status,
          attempts: nextAttempts,
        },
        bypassedRls: true,
      });

      logger.info("[lgpd-redact-worker] contact redacted", {
        request_id: shortId(requestId),
        organization_id: orgId,
        cascaded_to: cascade.counts,
      });

      return { consumer_key: "lgpd-redact-worker.v1", status: "ok", detail: "completed" };
    }

    // ---------------------------------------------------------------------
    // TENANT scope (store-level uninstall)
    // ---------------------------------------------------------------------
    if (scope === "tenant") {
      const progress = readTenantProgress(req.request_payload);
      const aggregate = { contacts: 0, conversations: 0, messages: 0 };

      // Loop until empty batch — each iteration checkpoints progress.
      // Uses keyset-style ordering by id with offset (small batches, full table
      // is bounded by tenant size).
      while (true) {
        const { data: batch, error: batchErr } = await admin
          .from("contacts")
          .select("id")
          .eq("organization_id", orgId)
          .eq("is_anonymized", false)
          .order("id", { ascending: true })
          .range(progress.batch_offset, progress.batch_offset + TENANT_BATCH_SIZE - 1);

        if (batchErr) {
          throw new Error(`tenant_batch_select_failed: ${batchErr.message}`);
        }

        const rows = (batch ?? []) as Array<{ id: string }>;
        if (rows.length === 0) break;

        for (const row of rows) {
          try {
            const cascade = await cascadeRedactContact({
              organizationId: orgId,
              contactId: row.id,
              requestId,
            });
            if (!cascade.alreadyAnonymized) {
              aggregate.contacts += cascade.counts["contacts"] ?? 0;
              aggregate.conversations += cascade.counts["conversations"] ?? 0;
              aggregate.messages += cascade.counts["messages"] ?? 0;
            }
            progress.processed++;
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            progress.failed_contacts.push(row.id);
            logger.warn("[lgpd-redact-worker] tenant cascade single contact failed", {
              request_id: shortId(requestId),
              organization_id: orgId,
              contact_id_short: shortId(row.id),
              error_hash: sha256(detail),
            });
          }
        }

        progress.batch_offset += rows.length;

        // Persist checkpoint.
        const updatedPayload = {
          ...(req.request_payload as Record<string, unknown>),
          progress,
        };
        // O ponto de retomada é conveniência: se não gravar, a retomada relê os
        // contatos ainda não anonimizados. Registra e segue, sem lançar (já há
        // contato anonimizado neste ponto).
        const { error: erroDoPonto } = await admin
          .from("lgpd_requests")
          .update({ request_payload: updatedPayload })
          .eq("organization_id", orgId)
          .eq("id", requestId);
        if (erroDoPonto) {
          logger.error("[lgpd-redact-worker] ponto de retomada não gravou", {
            request_id: shortId(requestId),
            organization_id: orgId,
            error_code: erroDoPonto.code || "sem_codigo",
          });
        }

        // If the page was short-read we're done.
        if (rows.length < TENANT_BATCH_SIZE) break;
      }

      // Tenant fully processed → flip organizations.status='redacted'.
      const { error: orgUpdateErr } = await admin
        .from("organizations")
        .update({ status: "redacted", redacted_at: new Date().toISOString() })
        .eq("id", orgId);

      if (orgUpdateErr) {
        logger.warn("[lgpd-redact-worker] organizations status update failed", {
          organization_id: orgId,
          error_hash: sha256(orgUpdateErr.message),
        });
      }

      const callback = await tryNuvemshopCallback(orgId, req.request_payload ?? {});

      const failedCount = progress.failed_contacts.length;
      const finalStatus = failedCount > 0 ? "pending_review" : "completed";

      const erroAoFechar = await gravarEstado(admin, orgId, requestId, {
        status: finalStatus,
        completed_at: new Date().toISOString(),
        result: {
          scope: "tenant",
          processed: progress.processed,
          failed_contacts_count: failedCount,
          aggregate_counts: aggregate,
          callback_status: callback.status,
          organization_status: "redacted",
        },
        cascaded_to: aggregate,
        error_message: failedCount > 0 ? "partial_failure" : null,
      });
      // Contatos já anonimizados: mesmo tratamento do pedido de contato.
      if (erroAoFechar) return feitoSemRegistro(requestId, orgId, erroAoFechar);

      await emitirAplicado(
        admin,
        orgId,
        requestId,
        {
          request_id: requestId,
          scope: "tenant",
          processed: progress.processed,
          failed_count: failedCount,
          aggregate_counts: aggregate,
        },
        { source: "lgpd-redact-worker", emergency },
      );

      await audit({
        action: "lgpd.tenant_redacted",
        organizationId: orgId,
        resourceType: "lgpd_request",
        resourceId: requestId,
        metadata: {
          processed: progress.processed,
          failed_count: failedCount,
          aggregate_counts: aggregate,
          callback_status: callback.status,
          attempts: nextAttempts,
          partial_failure: failedCount > 0,
        },
        bypassedRls: true,
      });

      logger.info("[lgpd-redact-worker] tenant redacted", {
        request_id: shortId(requestId),
        organization_id: orgId,
        processed: progress.processed,
        failed_count: failedCount,
      });

      return {
        consumer_key: "lgpd-redact-worker.v1",
        status: failedCount > 0 ? "error" : "ok",
        detail: failedCount > 0 ? "partial_failure" : "tenant_completed",
      };
    }

    // Unknown scope.
    return {
      consumer_key: "lgpd-redact-worker.v1",
      status: "skipped",
      detail: `unknown_scope:${scope}`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[lgpd-redact-worker] cascade failed", {
      request_id: shortId(requestId),
      organization_id: orgId,
      error_hash: sha256(detail),
      attempts: nextAttempts,
    });

    // Só chega aqui o que falhou ANTES de anonimizar (pedido de contato) ou a
    // leitura do lote (pedido da organização): devolver à fila é verdade.
    const erroAoDevolver = await gravarEstado(admin, orgId, requestId, {
      status: nextAttempts >= MAX_ATTEMPTS ? "failed" : "received",
      error_message: detail.slice(0, 500),
    });

    try {
      await admin.rpc("emit_event" as never, {
        p_event_type: "lgpd.redact_failed",
        p_entity_kind: "lgpd_request",
        p_entity_id: requestId,
        p_payload: {
          request_id: requestId,
          scope,
          attempts: nextAttempts,
          terminal: nextAttempts >= MAX_ATTEMPTS,
        },
        p_metadata: { source: "lgpd-redact-worker" },
        p_organization_id: orgId,
      } as never);
    } catch {
      // best-effort
    }

    await audit({
      action: "lgpd.redact_failed",
      organizationId: orgId,
      resourceType: "lgpd_request",
      resourceId: requestId,
      metadata: {
        attempts: nextAttempts,
        error_hash: sha256(detail),
        terminal: nextAttempts >= MAX_ATTEMPTS,
        scope,
        ...(erroAoDevolver ? { status_write_failed: erroAoDevolver } : {}),
      },
      bypassedRls: true,
    });

    const desfecho = nextAttempts >= MAX_ATTEMPTS ? "redact_failed_terminal" : "redact_failed_will_retry";
    return {
      consumer_key: "lgpd-redact-worker.v1",
      status: "error",
      detail: erroAoDevolver ? `${desfecho}; status_write_failed: ${erroAoDevolver}` : desfecho,
    };
  }
}
