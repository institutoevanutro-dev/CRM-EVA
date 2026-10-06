import { contatoDoNegocio } from "@/lib/operacao/modelos-de-mensagem";
import type { McpContext } from "./types";

/**
 * A recusa ÚNICA das ferramentas do catálogo durante um turno de conversa,
 * quando o pedido alcança dado de OUTRO paciente.
 *
 * Mesma forma da recusa de escrita da ponte (`{ permitido: false, motivo,
 * mensagem }`): o modelo lê por que foi recusado e segue a conversa, e
 * `lib/ai/runtime/tools.ts` audita a resposta como recusa
 * (`contato_da_conversa:fora_da_conversa`), não como acerto.
 *
 * Registro inexistente, de outra organização e de outro paciente recebem a
 * MESMA resposta: um uuid não vira oráculo de existência.
 */
export function foraDaConversa(oQue: string) {
  return {
    permitido: false,
    motivo: "fora_da_conversa",
    mensagem: `esta conversa é com outra pessoa — ${oQue}; siga a conversa com quem está falando.`,
  } as const;
}

/**
 * O alvo pedido por uma LEITURA (contato e/ou negócio) é de outro paciente?
 *
 * `contact_id` diferente do contato do turno, ou `lead_id` cujo dono não é ele
 * — negócio inexistente e negócio sem contato inclusive (`contatoDoNegocio`
 * devolve o mesmo `null` para os dois). Ausente não conta: sem alvo, quem
 * chama usa o contato do turno.
 */
export async function foraDoContatoDoTurno(
  ctx: McpContext,
  doTurno: string,
  contactId: string | null | undefined,
  leadId: string | null | undefined,
): Promise<boolean> {
  if (contactId != null && contactId !== doTurno) return true;
  if (leadId == null) return false;
  const dono = await contatoDoNegocio(
    { supabase: ctx.supabase, organizationId: ctx.organizationId, actor: ctx.actor, requestId: ctx.requestId },
    leadId,
  );
  return dono !== doTurno;
}
