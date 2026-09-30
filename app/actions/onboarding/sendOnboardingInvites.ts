"use server";

/**
 * Server Action: bulk-invite teammates from the onboarding wizard.
 *
 * Reuses the canonical invite emitter (`emitirConvite`, same as
 * /api/v1/team/invite) so the invite gets a `team_invites` row — listed in
 * Equipe and revocable. Failures to send email do NOT block onboarding.
 */
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitirConvite } from "@/lib/team/convites";
import { inviteOnboardingSchema } from "@/lib/schemas/onboarding";
import { requireOnboardingCtx, patchOnboardingState, OnboardingError } from "./_shared";

type PapelHumano = "viewer" | "provider" | "agent" | "manager" | "admin";

export type SendInvitesResult =
  | {
      ok: true;
      sent: number;
      failed: number;
      /** Convites cujo email NÃO saiu (ex.: Resend não configurado) — o link
       * de aceite é devolvido para o admin enviar manualmente. */
      undelivered?: { email: string; accept_url: string }[];
    }
  | { ok: false; error: "auth_required" | "no_active_org" | "invalid_input"; details?: unknown };

interface InvitePayload {
  // Convite é para PESSOA: só papel humano. `ai_operator` não entra aqui de
  // propósito — é papel de token de agente, ninguém o recebe por e-mail.
  invitations: { email: string; role: PapelHumano }[];
  skip?: boolean;
}

export async function sendOnboardingInvites(payload: InvitePayload): Promise<SendInvitesResult> {
  let ctx;
  try {
    ctx = await requireOnboardingCtx();
  } catch (err) {
    if (err instanceof OnboardingError) return { ok: false, error: err.code as never };
    throw err;
  }

  if (payload.skip) {
    await patchOnboardingState(ctx.orgId, { team: { invites_sent: 0, skipped: true } });
    await audit({
      action: "onboarding.team_invited",
      actorUserId: ctx.userId,
      organizationId: ctx.orgId,
      metadata: { skipped: true, count: 0 },
    });
    redirect("/onboarding");
  }

  let input;
  try {
    input = inviteOnboardingSchema.parse(payload);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, error: "invalid_input", details: err.flatten() };
    }
    throw err;
  }

  const inviterName = ctx.fullName ?? ctx.email ?? "Um colega";
  const admin = createAdminClient();
  const requestId = randomUUID();

  let sent = 0;
  let failed = 0;
  const undelivered: { email: string; accept_url: string }[] = [];
  for (const inv of input.invitations) {
    const email = inv.email.trim().toLowerCase();
    // O MESMO emissor de `/api/v1/team/invite`: assina o token, envia o e-mail,
    // audita `member.invited` e grava a linha em `team_invites` — sem ela o
    // convite não aparecia em Equipe e não podia ser revogado.
    const { accept_url, email_dispatched } = await emitirConvite(admin, {
      email,
      role: inv.role,
      organizationId: ctx.orgId,
      orgName: ctx.orgName,
      inviterId: ctx.userId,
      inviterName,
      requestId,
    });
    if (email_dispatched) sent += 1;
    else {
      failed += 1;
      undelivered.push({ email, accept_url });
    }
  }

  await patchOnboardingState(ctx.orgId, {
    team: { invites_sent: sent + failed, skipped: false },
  });
  await audit({
    action: "onboarding.team_invited",
    actorUserId: ctx.userId,
    organizationId: ctx.orgId,
    metadata: { count: sent + failed, sent, failed },
  });

  // Email falhou (ex.: VPS sem RESEND_API_KEY): NÃO redireciona em silêncio —
  // devolve os links de aceite pro admin enviar manualmente (mesmo contrato do
  // fallback de /app/team/invite). Redirect só no caminho 100% entregue.
  if (failed > 0) {
    return { ok: true, sent, failed, undelivered };
  }

  redirect("/onboarding");
}
