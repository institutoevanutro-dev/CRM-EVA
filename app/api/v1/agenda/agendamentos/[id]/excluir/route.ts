/**
 * `POST /api/v1/agenda/agendamentos/:id/excluir` — tira da Agenda o compromisso
 * lançado por engano ou de teste, sem apagar a linha (migration 0364).
 *
 * Piso `manager`, e não o `agent` de cancelar: cancelar conta a história ao
 * negócio; excluir a esconde de toda tela e relatório. Isso é decisão de quem
 * responde pela agenda, e o banco cobra o mesmo piso (`fn_appointment_exclude`).
 * Não há ferramenta MCP: a IA cancela, nunca exclui.
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

import { excluirAgendamentoHandler } from "../../_handler";

const excluirSchema = z.object({
  /** Obrigatório: é o que a auditoria responde quando alguém procura o horário. */
  reason: z.string().trim().min(3).max(500),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "agenda" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("not_found", t("Agendamento não encontrado."), 404, { requestId });
  }
  const parsed = excluirSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Informe o motivo da exclusão."), 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  try {
    const resultado = await excluirAgendamentoHandler(
      await createClient(),
      // A organização vem do COOKIE VALIDADO, nunca do corpo.
      { organization_id: authz.org.orgId, actor: { type: "user", id: authz.user.id }, requestId },
      { id, reason: parsed.data.reason },
    );
    return ok(resultado, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, t(err.message), err.status, { requestId });
    }
    throw err;
  }
}
