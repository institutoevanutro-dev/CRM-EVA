/**
 * O registro do envio de exame ao Prontuário (`prontuario_exames_enviados`,
 * migration 0402) e o selo na lista de mensagens.
 *
 * A tabela é deny-all: só a service role lê e grava. O cliente admin é criado
 * AQUI DENTRO (não recebido por parâmetro) para o gate
 * `admin-client-exige-filtro-de-tenant` medir este arquivo: toda chamada
 * carrega `organization_id`, vindo da sessão.
 *
 * O `exam_id` fica só no banco: nunca sai daqui para o navegador (D19).
 */
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Message, SeloDoProntuario } from "@/lib/types/messaging";

export type RegistroDoEnvio = {
  message_id: string;
  ja_existia: boolean;
  enviado_em: string;
  enviado_por_user_id: string | null;
};

type Linha = { message_id: string; ja_existia: boolean; enviado_por_user_id: string | null; created_at: string };

const COLUNAS = "message_id, ja_existia, enviado_por_user_id, created_at";

const paraRegistro = (l: Linha): RegistroDoEnvio => ({
  message_id: l.message_id,
  ja_existia: l.ja_existia,
  enviado_em: l.created_at,
  enviado_por_user_id: l.enviado_por_user_id,
});

export async function lerExameEnviado(org: string, messageId: string): Promise<RegistroDoEnvio | null> {
  const { data, error } = await createAdminClient()
    .from("prontuario_exames_enviados")
    .select(COLUNAS)
    .eq("organization_id", org)
    .eq("message_id", messageId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? paraRegistro(data as Linha) : null;
}

/**
 * Grava o envio confirmado. `23505` (já gravado por outro clique) devolve o
 * existente com `novo: false`.
 */
export async function registrarExameEnviado(r: {
  organizationId: string;
  messageId: string;
  examId: string;
  jaExistia: boolean;
  userId: string;
}): Promise<{ registro: RegistroDoEnvio; novo: boolean } | null> {
  const { data, error } = await createAdminClient()
    .from("prontuario_exames_enviados")
    .insert({
      organization_id: r.organizationId,
      message_id: r.messageId,
      exam_id: r.examId,
      ja_existia: r.jaExistia,
      enviado_por_user_id: r.userId,
    })
    .select(COLUNAS)
    .single();
  if (error?.code === "23505") {
    const existente = await lerExameEnviado(r.organizationId, r.messageId);
    return existente ? { registro: existente, novo: false } : null;
  }
  if (error) throw new Error(error.message);
  return { registro: paraRegistro(data as Linha), novo: true };
}

/**
 * Toca `messages.updated_at`: o UPDATE chega pelo Realtime que a conversa
 * aberta já assina, e o colega relê a página com o selo. Falha só vai a log.
 */
export async function tocarMensagem(org: string, messageId: string): Promise<void> {
  const { error } = await createAdminClient()
    .from("messages")
    .update({ updated_at: new Date().toISOString() })
    .eq("organization_id", org)
    .eq("id", messageId);
  if (error) logger.warn("prontuario.exames.tocar_mensagem_falhou", { message_id: messageId });
}

/**
 * Põe `prontuario_exame` nas mensagens da página que têm registro. Só consulta
 * quando a página tem anexo inbound guardado; falha nunca derruba a lista.
 */
export async function juntarExamesEnviados<M extends Pick<Message, "id" | "direction" | "type" | "media_storage_path">>(
  org: string,
  mensagens: M[],
): Promise<Array<M & { prontuario_exame?: SeloDoProntuario }>> {
  const ids = mensagens
    .filter((m) => m.direction === "inbound" && (m.type === "image" || m.type === "document") && m.media_storage_path)
    .map((m) => m.id);
  if (ids.length === 0) return mensagens;
  const { data, error } = await createAdminClient()
    .from("prontuario_exames_enviados")
    .select(COLUNAS)
    .eq("organization_id", org)
    .in("message_id", ids);
  if (error || !data) {
    logger.warn("prontuario.exames.selo_falhou", { quantidade: ids.length });
    return mensagens;
  }
  const porMensagem = new Map((data as Linha[]).map((l) => [l.message_id, l]));
  return mensagens.map((m) => {
    const l = porMensagem.get(m.id);
    return l
      ? { ...m, prontuario_exame: { ja_existia: l.ja_existia, enviado_em: l.created_at, enviado_por_user_id: l.enviado_por_user_id } }
      : m;
  });
}
