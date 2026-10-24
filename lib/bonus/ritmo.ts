/**
 * O RITMO da fila de leads antigos: entre dois disparos frios pelo mesmo número,
 * no mínimo `protecao.intervalo_minimo_s` segundos, e só dentro da janela do
 * número. Vale para o PRIMEIRO envio de pessoa do dia a um contato da fila
 * `lead_antigo` de hoje; a conversa que já começou passa livre.
 *
 * Falha ABERTA: qualquer erro de leitura devolve `pode` e vai ao log. Este gate
 * fica na frente do envio do Inbox inteiro, e calar o atendimento é pior do que
 * deixar passar um disparo cedo.
 *
 * ponytail: sem trava atômica, dois cliques simultâneos podem passar juntos. Se
 * isso aparecer na prática, trocar por `SET NX PX` no Redis por número.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { janelaDeEnvioAberta } from "@/lib/agent-engine/pacing/engine";
import { diaLocalISO } from "@/lib/agenda/fuso";
import { knobsDoCanal } from "@/lib/automation/janela-do-canal";
import { logger } from "@/lib/logger";

import { inicioDoDia } from "./calendario";
import { lerPrograma } from "./fatos";

export type DecisaoDoRitmo =
  | { tipo: "pode" }
  | { tipo: "aguarde"; segundos: number }
  | { tipo: "fora_da_janela"; inicio?: number; fim?: number };

export function decidirRitmo(e: {
  agora: Date;
  ultimoEnvioDaFila: Date | null;
  intervaloMinimoS: number;
  janelaAberta: boolean;
}): DecisaoDoRitmo {
  if (!e.janelaAberta) return { tipo: "fora_da_janela" };
  if (e.intervaloMinimoS === 0 || !e.ultimoEnvioDaFila) return { tipo: "pode" };
  const intervalo = e.intervaloMinimoS * 1000;
  const decorrido = Math.max(0, e.agora.getTime() - e.ultimoEnvioDaFila.getTime());
  if (decorrido < intervalo) return { tipo: "aguarde", segundos: Math.ceil((intervalo - decorrido) / 1000) };
  return { tipo: "pode" };
}

const PODE: DecisaoDoRitmo = { tipo: "pode" };

function erroDeLeitura(passo: string, organizationId: string, causa: string): DecisaoDoRitmo {
  logger.warn("[bonus.ritmo] leitura falhou, o envio segue sem ritmo", { organization_id: organizationId, passo, causa });
  return PODE;
}

export async function ritmoDaFila(
  admin: SupabaseClient,
  organizationId: string,
  conversationId: string,
  agora: Date = new Date(),
): Promise<DecisaoDoRitmo> {
  try {
    const conversa = await admin
      .from("conversations")
      .select("contact_id, channel_session_id")
      .eq("id", conversationId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (conversa.error) return erroDeLeitura("conversations", organizationId, conversa.error.message);
    const conv = conversa.data as { contact_id: string; channel_session_id: string } | null;
    if (!conv) return PODE;

    const lido = await lerPrograma(admin, organizationId);
    if (lido.status === "erro") return erroDeLeitura("bonus_programas", organizationId, lido.motivo);
    if (lido.status === "ausente" || !lido.programa.ativo) return PODE;
    const { fuso, regras } = lido.programa;

    const hoje = diaLocalISO(agora, fuso);
    const fila = await admin
      .from("bonus_fila_itens")
      .select("contact_id")
      .eq("organization_id", organizationId)
      .eq("dia", hoje)
      .eq("tipo", "lead_antigo");
    if (fila.error) return erroDeLeitura("bonus_fila_itens", organizationId, fila.error.message);
    const contatosDaFila = ((fila.data ?? []) as { contact_id: string }[]).map((l) => l.contact_id);
    if (!contatosDaFila.includes(conv.contact_id)) return PODE;

    const desde = inicioDoDia(hoje, fuso).toISOString();
    const enviosDePessoaHoje = () =>
      admin
        .from("messages")
        .select("created_at")
        .eq("organization_id", organizationId)
        .eq("direction", "outbound")
        .eq("sent_via", "user")
        .neq("status", "failed")
        .gte("created_at", desde);

    const jaFalou = await enviosDePessoaHoje().eq("contact_id", conv.contact_id).limit(1);
    if (jaFalou.error) return erroDeLeitura("messages", organizationId, jaFalou.error.message);
    if ((jaFalou.data ?? []).length > 0) return PODE;

    // `created_at`, não `sent_at`: a linha nasce antes de o canal responder, e o
    // ritmo conta desde o clique.
    const ultimo = await enviosDePessoaHoje()
      .eq("channel_session_id", conv.channel_session_id)
      .in("contact_id", contatosDaFila)
      .order("created_at", { ascending: false })
      .limit(1);
    if (ultimo.error) return erroDeLeitura("messages", organizationId, ultimo.error.message);
    const linha = (ultimo.data ?? [])[0] as { created_at: string } | undefined;

    const knobs = await knobsDoCanal(admin, organizationId, conv.channel_session_id);
    const decisao = decidirRitmo({
      agora,
      ultimoEnvioDaFila: linha ? new Date(linha.created_at) : null,
      intervaloMinimoS: regras.protecao.intervalo_minimo_s,
      janelaAberta: janelaDeEnvioAberta(agora, knobs),
    });
    if (decisao.tipo === "fora_da_janela") return { ...decisao, inicio: knobs.windowStartHour, fim: knobs.windowEndHour };
    return decisao;
  } catch (err) {
    return erroDeLeitura("excecao", organizationId, err instanceof Error ? err.message : String(err));
  }
}
