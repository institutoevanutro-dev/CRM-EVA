import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ApprovedReplyReceiptPersistenceError,
  recordApprovedReplyReceiptSupabase,
} from "@/lib/ai/replies/delivery";
import { sendWithLedger } from "@/lib/agent-engine/edge/crm/send-ledger";

it.each(["returned", "rejected"])(
  "resposta RPC perdida (%s) preserva accepted e replay não envia novamente",
  async (mode) => {
    let accepted = false;
    const rpc = vi.fn(async () => {
      // The transaction committed its message and ledger before the response disappeared.
      accepted = true;
      if (mode === "rejected") throw new Error("connection reset");
      return { data: null, error: { message: "response lost" } };
    });
    const db = { rpc } as unknown as SupabaseClient;
    const store: Parameters<typeof sendWithLedger>[0] = {
      create: vi.fn(async () => {
        throw { code: "23505" };
      }),
      find: vi.fn(async () => ({
        id: "ledger",
        status: accepted ? ("accepted" as const) : ("requested" as const),
        crm_message_id: accepted ? "message" : null,
      })),
      rotate: vi.fn(async () => "rotated"),
      message: vi.fn(async () => null),
      update: vi.fn(async () => {}),
    };
    const intent = { tenantId: "org", leadId: "contact", jobId: "job", seq: 1, body: "Approved" };
    const send = vi.fn(async () => {
      await recordApprovedReplyReceiptSupabase(
        db,
        {
          organizationId: "org",
          jobId: "job",
          jobClaim: { worker_id: "worker", acquired_at: "2026-09-06T12:00:00Z" },
        },
        "message",
        "external",
        [],
      );
      return { id: "message", status: "sent" };
    });
    await expect(sendWithLedger(store, intent, send)).rejects.toBeInstanceOf(
      ApprovedReplyReceiptPersistenceError,
    );
    expect(store.update).not.toHaveBeenCalled();
    expect(await sendWithLedger(store, intent, send)).toMatchObject({
      kind: "already_sent",
      crmMessageId: "message",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.rotate).not.toHaveBeenCalled();
  },
);

/**
 * O ECO QUE ENTRA ENTRE O DELETE E O UPDATE DE `fn_reply_record_receipt`.
 *
 * Desde que o eco do WhatsApp por QR grava o id na forma curta (bare), a mesma
 * do envio (porte do DeskcommCRM 53f3b1b70), o eco que o webhook commita entre
 * o `delete` e o `update` da função ocupa o id primeiro, e o unique
 * `(organization_id, external_id)` recusa o carimbo com 23505. A função inteira
 * volta (uma transação só), a linha fica `queued` e o ledger `requested` — e a
 * próxima rodada REENVIARIA a resposta ao paciente. Chamar de novo é seguro (o
 * que falhou foi desfeito) e a segunda chamada já enxerga o eco para apagar. É
 * o espelho, neste caminho, do que o handler faz no envio comum (DeskcommCRM
 * 098aef895) e do `markRedriveSent` do watchdog.
 */
it("23505 no carimbo da resposta aprovada: tenta de novo uma vez e grava o recibo", async () => {
  const rpc = vi
    .fn()
    .mockResolvedValueOnce({ data: null, error: { code: "23505", message: "duplicate key" } })
    .mockResolvedValueOnce({ data: { id: "message", status: "sent" }, error: null });
  const db = { rpc } as unknown as SupabaseClient;
  const ctx = {
    organizationId: "org",
    jobId: "job",
    jobClaim: { worker_id: "worker", acquired_at: "2026-09-06T12:00:00Z" },
  };

  await expect(
    recordApprovedReplyReceiptSupabase(db, ctx, "message", "3EB0BARE", ["3EB0BARE"]),
  ).resolves.toMatchObject({ id: "message", status: "sent" });
  expect(rpc).toHaveBeenCalledTimes(2);
});

it("23505 repetido continua sendo erro de persistência — nada de laço", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "23505", message: "duplicate key" } });
  const db = { rpc } as unknown as SupabaseClient;
  const ctx = {
    organizationId: "org",
    jobId: "job",
    jobClaim: { worker_id: "worker", acquired_at: "2026-09-06T12:00:00Z" },
  };

  await expect(
    recordApprovedReplyReceiptSupabase(db, ctx, "message", "3EB0BARE", ["3EB0BARE"]),
  ).rejects.toBeInstanceOf(ApprovedReplyReceiptPersistenceError);
  expect(rpc).toHaveBeenCalledTimes(2);
});
