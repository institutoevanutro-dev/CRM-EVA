/**
 * Exames do WhatsApp → Prontuário: a regra do BALÃO, sem import de servidor.
 *
 * O botão "Enviar ao prontuário" aparece numa mensagem recebida com PDF, JPEG
 * ou PNG de até 10 MiB, recebida nos últimos 60 dias e já guardada no CRM.
 * WebP/HEIC aparecem na lista do Prontuário, mas ele recusa sem baixar: no
 * balão viram dica. A mesma janela vale na checagem do servidor
 * (`app/api/v1/messages/[id]/prontuario/route.ts`) e na lista que o Prontuário
 * lê (`lib/prontuario/midias.ts`).
 *
 * O formato é decidido pelo MIME normalizado, nunca pelo `type`: JPEG e HEIC
 * mandados "como documento" chegam com `type = 'document'`.
 */
import type { Message } from "@/lib/types/messaging";

/** O que o Prontuário guarda. */
export const MIMES_ACEITOS = ["application/pdf", "image/jpeg", "image/png"] as const;
/** O que o Prontuário lista mas recusa: no balão, só a dica. */
export const MIMES_SO_DICA = ["image/webp", "image/heic"] as const;
/** O corte do Prontuário (`> 10 * 1024 * 1024` recusa). */
export const LIMITE_DO_PRONTUARIO_BYTES = 10 * 1024 * 1024;
/** O teto da rota de arquivo do CRM. */
export const LIMITE_DA_ROTA_BYTES = 15 * 1024 * 1024;
/** O Prontuário lista sempre `dias=60` (decisão do dono, 04/11). Uma constante só. */
export const JANELA_DO_PRONTUARIO_DIAS = 60;
const JANELA_MS = JANELA_DO_PRONTUARIO_DIAS * 24 * 60 * 60 * 1000;

/** `image/jpeg; charset=binary` → `image/jpeg`. Mesma conta do SQL de `midias.ts`. */
export function mimeNormalizado(mime: string | null | undefined): string {
  return ((mime ?? "").split(";")[0] ?? "").trim().toLowerCase();
}

export function dentroDaJanela(sentAt: string, agora: number): boolean {
  const t = Date.parse(sentAt);
  return Number.isFinite(t) && t >= agora - JANELA_MS;
}

export type SituacaoDoExame = "botao" | "formato" | "grande" | "falhou";

export function situacaoDoExame(m: Message, agora: number): SituacaoDoExame | null {
  if (m.direction !== "inbound") return null;
  if (m.type !== "image" && m.type !== "document") return null;
  if (m.revoked_at) return null;
  if (!dentroDaJanela(m.sent_at, agora)) return null;
  const mime = mimeNormalizado(m.media_mime);
  const aceito = (MIMES_ACEITOS as readonly string[]).includes(mime);
  const dica = (MIMES_SO_DICA as readonly string[]).includes(mime);
  if (!aceito && !dica) return null;
  if (!m.media_storage_path) {
    return aceito && m.metadata?.media_status === "failed" ? "falhou" : null;
  }
  // Sem tamanho a lista do Prontuário não traz o item (mesma regra do SQL).
  if (m.media_size_bytes == null) return null;
  if (dica) return "formato";
  if (m.media_size_bytes > LIMITE_DO_PRONTUARIO_BYTES) return "grande";
  return "botao";
}

/**
 * As frases de cada desfecho do envio, em português (a chave do dicionário).
 * Moram aqui, e não na rota, porque o espanhol de cada uma é conferido em
 * `lib/prontuario/exames.test.ts` (o gate de i18n não varre `app/api`).
 * O CRM decide pelo código; nunca repassa o texto do Prontuário.
 */
export const FRASE_DO_CODIGO = {
  paciente_nao_vinculado: "Este contato ainda não está ligado a um paciente no Prontuário.",
  vinculo_nao_confirmado: "Este contato ainda não está confirmado no Prontuário. Peça para confirmar o vínculo lá.",
  midia_em_outro_paciente: "Este arquivo já está no prontuário de outro paciente. Confira o vínculo com o CRM.",
  contato_com_varios_pacientes: "Este contato está ligado a mais de um paciente no Prontuário; corrija o vínculo lá.",
  midia_nao_encontrada: "O Prontuário não encontrou este arquivo na conversa. Se ele acabou de chegar, tente em instantes.",
  midia_ainda_nao_disponivel: "O arquivo ainda está chegando. Tente em instantes.",
  formato_nao_aceito: "O Prontuário aceita só PDF, JPG ou PNG. Peça ao paciente um PDF ou foto comum.",
  grande_demais: "O arquivo passa de 10 MB, o limite do Prontuário.",
  prontuario_configuracao: "A integração com o Prontuário não está configurada. Avise o administrador.",
  prontuario_indisponivel: "O Prontuário não respondeu. Tente de novo em instantes.",
  limite_de_pedidos: "O Prontuário recebeu muitos envios agora. Tente em um minuto.",
  prontuario_sem_acesso_ao_crm: "O Prontuário não conseguiu buscar o arquivo no CRM. Tente de novo em instantes.",
  fora_do_prontuario:
    "Este arquivo não pode ir ao prontuário: só PDF ou foto de até 10 MB recebidos pelo WhatsApp nos últimos 60 dias.",
  prontuario_desligado: "O envio ao prontuário não está ligado nesta organização.",
  so_da_equipe: "O envio ao prontuário é só da equipe da clínica.",
  mensagem_indisponivel: "Mensagem indisponível.",
  falha_interna: "Não foi possível enviar agora.",
} as const;

export type ChaveDaFrase = keyof typeof FRASE_DO_CODIGO;

export const fraseDoCodigo = (c: ChaveDaFrase, t: (s: string) => string): string => t(FRASE_DO_CODIGO[c]);
