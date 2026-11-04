/**
 * POST /api/v1/messages/{id}/prontuario — o botão "Enviar ao prontuário".
 *
 * Só `agent`, `manager` e `admin` da clínica (sessão de acompanhamento nunca,
 * nem em modo `full`: o nome de quem envia vai ao prontuário do paciente).
 * A elegibilidade é a MESMA da lista que o Prontuário lê
 * (`lib/prontuario/midias.ts`); a configuração tem três estados
 * (`lib/integrations/prontuario/cliente.ts`).
 *
 * Ao navegador, o desfecho do Prontuário nunca sai como 429/503: o `apiClient`
 * repetiria o POST sozinho. Negócio sai 409/422; falha do Prontuário, 502.
 * Toda tentativa que chamou o Prontuário (ou esbarrou em configuração
 * inválida) e não deu certo vira `prontuario.exam_send_failed`. O `exam_id`
 * nunca sai daqui: nem na resposta, nem na auditoria.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { enviarExameAoProntuario, estadoDosExames, type CodigoDoEnvio } from "@/lib/integrations/prontuario/cliente";
import { logger } from "@/lib/logger";
import {
  dentroDaJanela,
  fraseDoCodigo,
  LIMITE_DO_PRONTUARIO_BYTES,
  MIMES_ACEITOS,
  type ChaveDaFrase,
} from "@/lib/prontuario/exames";
import { lerExameEnviado, registrarExameEnviado, tocarMensagem, type RegistroDoEnvio } from "@/lib/prontuario/exames-enviados";
import { buscarMidia } from "@/lib/prontuario/midias";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

const TETO_POR_PESSOA = 30;
const JANELA_SEGUNDOS = 60;

const STATUS_DO_CODIGO: Record<CodigoDoEnvio, number> = {
  paciente_nao_vinculado: 409,
  vinculo_nao_confirmado: 409,
  contato_com_varios_pacientes: 409,
  midia_ainda_nao_disponivel: 409,
  midia_nao_encontrada: 422,
  formato_nao_aceito: 422,
  grande_demais: 422,
  prontuario_configuracao: 502,
  prontuario_indisponivel: 502,
  prontuario_sem_acesso_ao_crm: 502,
};

export async function POST(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "messages" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const frase = (c: ChaveDaFrase) => fraseDoCodigo(c, t);
  if (authz.user.support) return fail("forbidden", frase("so_da_equipe"), 403, { requestId });

  const org = authz.org.orgId;
  const userId = authz.user.id;

  const id = z.uuid().safeParse((await ctx.params).id);
  if (!id.success) return fail("validation_failed", t("Dados inválidos."), 422, { requestId });

  const falhou = (contactId: string | null, messageId: string, m: Record<string, unknown>) =>
    audit({
      action: "prontuario.exam_send_failed",
      actorUserId: userId,
      organizationId: org,
      resourceType: "message",
      resourceId: messageId,
      requestId,
      metadata: { contact_id: contactId, ...m },
    });

  const cfg = estadoDosExames(org);
  if (cfg.estado === "desligada") return fail("prontuario_desligado", frase("prontuario_desligado"), 409, { requestId });
  if (cfg.estado === "invalida") {
    logger.error("prontuario.exames.config_invalida", { motivo: cfg.motivo, request_id: requestId });
    await falhou(null, id.data.toLowerCase(), {
      codigo: `config_${cfg.motivo}`,
      status_do_prontuario: null,
      codigo_do_prontuario: null,
      tentativas: 0,
    });
    return fail("prontuario_configuracao", frase("prontuario_configuracao"), 502, { requestId });
  }

  const teto = await checkRateLimit(`prontuario-exame:${org}:${userId}`, TETO_POR_PESSOA, JANELA_SEGUNDOS);
  if (!teto.allowed) {
    return fail("rate_limited", t("Muitas tentativas seguidas. Tente em um minuto."), 429, {
      requestId,
      headers: {
        "Retry-After": String(JANELA_SEGUNDOS),
        "X-RateLimit-Limit": String(teto.limit),
        "X-RateLimit-Remaining": String(Math.max(0, teto.limit - teto.count)),
      },
    });
  }

  // Visibilidade pela SESSÃO (RLS): quem não vê a conversa não envia a mensagem dela.
  const supabase = await createClient();
  const { data: visivel } = await supabase
    .from("messages")
    .select("id")
    .eq("id", id.data)
    .eq("organization_id", org)
    .maybeSingle();
  if (!visivel) return fail("not_found", frase("mensagem_indisponivel"), 404, { requestId });

  let midia;
  try {
    const existente = await lerExameEnviado(org, id.data.toLowerCase());
    if (existente) return ok(existente, { status: 200, requestId });
    midia = await buscarMidia(getRequestPool(), { organizationId: org, messageId: id.data.toLowerCase() });
  } catch (error) {
    logger.error("prontuario.exames.checagem_falhou", { request_id: requestId, error: (error as Error).message });
    return fail("internal_error", frase("falha_interna"), 500, { requestId });
  }
  if (!midia || !dentroDaJanela(new Date(midia.sent_at).toISOString(), Date.now()))
    return fail("fora_do_prontuario", frase("fora_do_prontuario"), 422, { requestId });
  if (midia.pendente) return fail("midia_ainda_nao_disponivel", frase("midia_ainda_nao_disponivel"), 409, { requestId });
  if (!(MIMES_ACEITOS as readonly string[]).includes(midia.mime))
    return fail("formato_nao_aceito", frase("formato_nao_aceito"), 422, { requestId });
  if (Number(midia.size_bytes) > LIMITE_DO_PRONTUARIO_BYTES) return fail("grande_demais", frase("grande_demais"), 422, { requestId });

  // O id do BANCO (minúsculas): o Prontuário compara por igualdade de texto.
  const messageId = midia.message_id;
  const contactId = midia.contact_id;
  const enviadoPor = (authz.user.full_name ?? "").trim().slice(0, 120).trim() || "Equipe da clínica";

  const desfecho = await enviarExameAoProntuario(
    cfg,
    { contact_id: contactId, message_id: messageId, enviado_por: enviadoPor },
    { requestId },
  );

  if (!desfecho.ok) {
    await falhou(contactId, messageId, {
      codigo: desfecho.statusDoProntuario === null ? "sem_resposta" : desfecho.codigo,
      status_do_prontuario: desfecho.statusDoProntuario,
      codigo_do_prontuario: desfecho.codigoDoProntuario,
      tentativas: desfecho.tentativas,
    });
    const chave: ChaveDaFrase = desfecho.codigoDoProntuario === "limite_de_pedidos" ? "limite_de_pedidos" : desfecho.codigo;
    return fail(desfecho.codigo, frase(chave), STATUS_DO_CODIGO[desfecho.codigo], { requestId });
  }

  let registro: RegistroDoEnvio = {
    message_id: messageId,
    ja_existia: desfecho.jaExistia,
    enviado_em: new Date().toISOString(),
    enviado_por_user_id: userId,
  };
  // 23505 = outro clique gravou antes: responde 200 com o que está gravado.
  let novo = true;
  try {
    const gravado = await registrarExameEnviado({
      organizationId: org,
      messageId,
      examId: desfecho.examId,
      jaExistia: desfecho.jaExistia,
      userId,
    });
    if (gravado) ({ registro, novo } = gravado);
  } catch (error) {
    logger.error("prontuario.exames.registro_falhou", { request_id: requestId, message_id: messageId, error: (error as Error).message });
  }
  await tocarMensagem(org, messageId);
  await audit({
    action: "prontuario.exam_sent",
    actorUserId: userId,
    organizationId: org,
    resourceType: "message",
    resourceId: messageId,
    requestId,
    metadata: { contact_id: contactId, ja_existia: registro.ja_existia },
  });
  return ok(registro, { status: novo && !registro.ja_existia ? 201 : 200, requestId });
}
