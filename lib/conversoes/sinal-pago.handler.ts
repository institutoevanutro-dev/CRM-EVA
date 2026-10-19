/**
 * Avisar a plataforma de anúncio que o SINAL foi pago — o momento em que a
 * clínica considera o paciente fechado.
 *
 * ─── Por que uma etapa do funil, e não outro sinal ──────────────────────────
 *
 * Levantado no código, não presumido: o CRM não tem registro próprio de
 * pagamento. O comprovante chega pela conversa e quem confere é a equipe, que
 * marca o resultado MOVENDO O CARD ("Comprovante em conferência" → "Sinal
 * pago"). Os outros candidatos não servem:
 *
 *  - `calendar_appointments.status = 'confirmed'` também nasce por outro motivo
 *    (o paciente confirmou presença), e a revisão do sinal
 *    (`lib/followup/revisao-do-sinal.ts`) avisa de propósito que inferir
 *    desfecho financeiro dele é erro;
 *  - `crm_stages.blocks_followups` marca também "em conferência", antes de o
 *    sinal estar confirmado;
 *  - a integração com o Financeiro só LÊ nomes e totais de marketing; nada
 *    volta de lá dizendo "pago".
 *
 * Então quem administra escolhe QUAIS etapas querem dizer "sinal pago"
 * (`organizations.settings.conversoes.etapas_de_sinal_pago`, ids de etapa da
 * própria organização, vazio por padrão). Toda mudança de etapa — arrasto no
 * Kanban, rota, lote, MCP, IA — emite `lead.stage_changed`, que é o que este
 * handler escuta. O id, o nome da etapa e o do procedimento nunca saem.
 *
 * ─── Uma vez por negócio e plataforma ───────────────────────────────────────
 *
 * Índice único por (negócio, plataforma, evento). Sair da etapa e voltar não
 * manda de novo, e sair dela depois (desistência, reembolso) não manda nada:
 * não existe evento de volta. O horário enviado é o da entrada na etapa.
 *
 * Mesmas exclusões, mesma regra "só quem veio de anúncio" e mesmo envio do
 * aviso de agendamento (`./despacho.ts`).
 */
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { idDoEvento, telefoneE164 } from "@/lib/plataformas-de-anuncio/identificadores";
import { EVENTO_SINAL_PAGO, type ConversaoDeAgendamento } from "@/lib/plataformas-de-anuncio/types";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  COLUNAS_DO_CONTATO,
  type Contato,
  despachar,
  encerrar,
  ESPERA_DE_LEITURA_MS,
  lerLivro,
  lerOrigem,
  motivoDeExclusao,
  resultadoDe,
  texto,
} from "./despacho";
import { lerPreferencias } from "./preferencias";

export const CONSUMER_KEY = "conversoes.sinal-pago";
const EVENTO = EVENTO_SINAL_PAGO;
const resultado = resultadoDe(CONSUMER_KEY);

async function handle(row: EventRow): Promise<HandlerResult> {
  const leadId = row.entity_id;
  const etapa = texto(row.payload?.to_stage_id);
  if (!leadId || !etapa) return resultado("skipped", "sem_etapa_de_destino");
  if (texto(row.payload?.from_stage_id) === etapa) return resultado("skipped", "mesma_etapa");

  const admin = createAdminClient();
  const org = row.organization_id;
  const agora = Date.now();

  const { data: dataOrg, error: erroOrg } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org)
    .maybeSingle();
  if (erroOrg) return resultado("retry", "leitura_da_organizacao", agora + ESPERA_DE_LEITURA_MS);
  const { somenteDeAnuncio, etapasDeSinalPago } = lerPreferencias(
    (dataOrg as { settings?: unknown } | null)?.settings,
  );

  const alvo = { coluna: "lead_id", id: leadId } as const;
  const livro = await lerLivro(admin, org, alvo, EVENTO);
  if (!livro) return resultado("retry", "leitura_do_livro", agora + ESPERA_DE_LEITURA_MS);

  // A etapa deixou de valer como sinal pago enquanto o envio esperava: encerra.
  if (!etapasDeSinalPago.includes(etapa)) {
    await encerrar(admin, org, livro, "etapa_nao_e_sinal_pago");
    return resultado("skipped", "etapa_nao_e_sinal_pago");
  }

  // ⚠️ Organização junto do id em toda leitura: o client é service-role.
  const { data: dataLead, error: erroLead } = await admin
    .from("crm_leads")
    .select("id, contact_id")
    .eq("id", leadId)
    .eq("organization_id", org)
    .maybeSingle();
  if (erroLead) return resultado("retry", "leitura_do_negocio", agora + ESPERA_DE_LEITURA_MS);
  const lead = dataLead as { id: string; contact_id: string | null } | null;
  if (!lead) return resultado("skipped", "negocio_inexistente");
  if (!lead.contact_id) return resultado("skipped", "sem_contato");

  const { data: dataContato, error: erroContato } = await admin
    .from("contacts")
    .select(COLUNAS_DO_CONTATO)
    .eq("id", lead.contact_id)
    .eq("organization_id", org)
    .maybeSingle();
  if (erroContato) return resultado("retry", "leitura_do_contato", agora + ESPERA_DE_LEITURA_MS);
  if (!dataContato) return resultado("skipped", "sem_contato");
  const contato = dataContato as Contato;

  const exclusao = motivoDeExclusao(contato);
  if (exclusao) {
    await encerrar(admin, org, livro, exclusao);
    return resultado("skipped", exclusao);
  }

  const telefone = telefoneE164(contato.phone_number);
  const email = texto(contato.email);
  if (!telefone && !email) return resultado("skipped", "sem_identificador");

  const origem = lerOrigem(contato.source_metadata);
  const conversao: ConversaoDeAgendamento = {
    organizationId: org,
    alvoId: lead.id,
    evento: EVENTO,
    eventoId: idDoEvento(org, lead.id, EVENTO),
    // A hora da ENTRADA na etapa (a linha do event_log), não a do dreno.
    ocorridoEm: row.created_at ? new Date(row.created_at) : new Date(agora),
    telefone,
    email,
    cliqueMeta: origem.cliqueMeta,
    cliqueGoogle: origem.cliqueGoogle,
  };

  return despachar({
    admin,
    alvo,
    conversao,
    livro,
    somenteDeAnuncio,
    origemDoContato: origem.plataforma,
    agora,
    resultado,
  });
}

export const conversaoDeSinalPagoHandler: EventHandler = {
  key: CONSUMER_KEY,
  events: ["lead.stage_changed"],
  handle,
};
