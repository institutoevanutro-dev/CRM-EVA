/**
 * POR QUAL NÚMERO O LEMBRETE DO COMPROMISSO SAI, QUANDO A ORGANIZAÇÃO ESCOLHE.
 *
 * Um ajuste por organização, em `organizations.settings.agenda_lembrete
 * .channel_session_id` (uuid de `channel_sessions`, ou nulo). Lido pelo
 * cron `app/api/v1/cron/agenda-reminder` e passado a `escolherCanalDoLembrete`
 * como `canalFixo`: quando o número escolhido pode enviar agora, ele vence a
 * conversa da reserva e a conversa mais recente.
 *
 * Ausente ou nulo = automático, a regra de sempre. Quem não mexe (e todo clone
 * antigo, que não tem a chave) continua exatamente como estava.
 *
 * Por que existe: numa organização com dois números (a clínica e o número
 * profissional do médico), a marcação pela tela não tem conversa de reserva, e
 * o paciente que só conversou pelo número do médico receberia o lembrete por
 * ele. A escolha de um número fixo é do dono da organização.
 *
 * ⚠️ NÃO mora em `settings.agenda`, e a vizinhança é de propósito. Aquele
 * objeto é dos prazos: `agendaSettingsSchema` (`lib/schemas/settings.ts`) o lê
 * com `strictObject(...).catch(padrões)`, então uma chave a mais faria TODA
 * leitura devolver os prazos padrão, em silêncio; e `fn_agenda_settings`
 * regrava o objeto inteiro, então salvar os prazos apagaria o número escolhido.
 *
 * O resolvedor NUNCA lança: roda no cron, e um jsonb torto não pode derrubar a
 * varredura. Valor torto = automático.
 *
 * Módulo sem dependência de servidor de propósito: a tela importa o schema.
 */
import { z } from "zod";

export const canalDoLembreteSchema = z.uuid();

/** O canal fixo em vigor para estes `settings`, ou `null` = automático. */
export function lerCanalDoLembrete(settings: unknown): string | null {
  const bruto = (settings as { agenda_lembrete?: { channel_session_id?: unknown } } | null | undefined)
    ?.agenda_lembrete?.channel_session_id;
  const r = canalDoLembreteSchema.safeParse(bruto);
  return r.success ? r.data : null;
}

function objetoSimples(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Os `settings` com `agenda_lembrete.channel_session_id` trocado, e SÓ ele: o resto do jsonb sobrevive. */
export function settingsComCanalDoLembrete(settings: unknown, canalId: string | null): Record<string, unknown> {
  // Só objeto simples é espalhado: espalhar uma string ou um array gravaria
  // chaves "0", "1"... no jsonb.
  const atual = objetoSimples(settings);
  const lembrete = objetoSimples(atual.agenda_lembrete);
  return { ...atual, agenda_lembrete: { ...lembrete, channel_session_id: canalId } };
}
