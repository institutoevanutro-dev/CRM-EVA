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
