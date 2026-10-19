/**
 * Avisar a plataforma de anúncio que um paciente AGENDOU — e só isso.
 *
 * ─── O que entra, o que sai ─────────────────────────────────────────────────
 *
 * Escuta `appointment.created` e `appointment.confirmed`, que a rota da Agenda
 * emite por `emit_event` (tela e IA passam pela mesma rota). O payload é DICA e o
 * banco é VERDADE: o handler re-lê o compromisso, o contato e a organização.
 *
 * Do contato saem só o telefone (E.164) e o e-mail, quando houver, que cada
 * transporte normaliza e hasheia, e o identificador do clique, quando houver.
 * O payload do evento traz o nome do tipo de consulta: ele NÃO é lido.
 *
 * ─── Quando não sai nada ────────────────────────────────────────────────────
 *
 *  - o compromisso não está `pending`/`confirmed` (cancelado, excluído, já
 *    aconteceu) ou foi importado (sync do Google, importação de histórico);
 *  - o contato está bloqueado, marcado "sempre atendimento humano", oculto,
 *    anonimizado ou fundido em outro;
 *  - a organização deixou "só quem veio de anúncio" ligado (o padrão) e o
 *    contato não veio de anúncio DAQUELA plataforma;
 *  - a conexão da plataforma não existe, está incompleta ou desligada.
 *
 * Cancelar ou desligar depois NÃO manda nada novo: só encerra o que ainda não
 * saiu. O que já saiu fica como está.
 *
 * O envio por plataforma (livro-razão, uma vez por agendamento e plataforma,
 * tentativas e aviso na Central) é o mesmo do sinal pago: `./despacho.ts`.
 */
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { idDoEvento, telefoneE164 } from "@/lib/plataformas-de-anuncio/identificadores";
import { EVENTO_AGENDOU, type ConversaoDeAgendamento } from "@/lib/plataformas-de-anuncio/types";
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

export { esperaDaTentativa, lerOrigem, MAX_TENTATIVAS, motivoDeExclusao } from "./despacho";

export const CONSUMER_KEY = "conversoes.agendamento";
const EVENTO = EVENTO_AGENDOU;

const STATUS_DE_AGENDADO = new Set(["pending", "confirmed"]);
const ORIGENS_IMPORTADAS = new Set(["google_sync", "historical_import"]);

interface Compromisso {
  id: string;
  status: string;
  contact_id: string | null;
  created_at: string;
  source: string | null;
  history_import_key: string | null;
  excluded_at: string | null;
}

const resultado = resultadoDe(CONSUMER_KEY);

async function handle(row: EventRow): Promise<HandlerResult> {
  if (!row.entity_id) return resultado("skipped", "sem_entidade");
  const admin = createAdminClient();
  const org = row.organization_id;
  const agora = Date.now();

  // ⚠️ Organização junto do id em toda leitura: o client é service-role.
  const { data: dataCompromisso, error: erroCompromisso } = await admin
    .from("calendar_appointments")
    .select("id, status, contact_id, created_at, source, history_import_key, excluded_at")
    .eq("id", row.entity_id)
    .eq("organization_id", org)
    .maybeSingle();
  if (erroCompromisso) return resultado("retry", "leitura_do_compromisso", agora + ESPERA_DE_LEITURA_MS);
  if (!dataCompromisso) return resultado("skipped", "compromisso_inexistente");
  const compromisso = dataCompromisso as Compromisso;

  const alvo = { coluna: "appointment_id", id: compromisso.id } as const;
  const livro = await lerLivro(admin, org, alvo, EVENTO);
  if (!livro) return resultado("retry", "leitura_do_livro", agora + ESPERA_DE_LEITURA_MS);

  if (!STATUS_DE_AGENDADO.has(compromisso.status) || compromisso.excluded_at) {
    await encerrar(admin, org, livro, "agendamento_cancelado");
    return resultado("skipped", "nao_esta_agendado");
  }
  if (ORIGENS_IMPORTADAS.has(compromisso.source ?? "") || compromisso.history_import_key) {
    return resultado("skipped", "importado");
  }
  if (!compromisso.contact_id) return resultado("skipped", "sem_contato");

  const [{ data: dataOrg }, { data: dataContato, error: erroContato }] = await Promise.all([
    admin.from("organizations").select("settings").eq("id", org).maybeSingle(),
    admin
      .from("contacts")
      .select(COLUNAS_DO_CONTATO)
      .eq("id", compromisso.contact_id)
      .eq("organization_id", org)
      .maybeSingle(),
  ]);
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

  const { somenteDeAnuncio } = lerPreferencias((dataOrg as { settings?: unknown } | null)?.settings);
  const origem = lerOrigem(contato.source_metadata);

  const conversao: ConversaoDeAgendamento = {
    organizationId: org,
    alvoId: compromisso.id,
    evento: EVENTO,
    eventoId: idDoEvento(org, compromisso.id, EVENTO),
    ocorridoEm: new Date(compromisso.created_at),
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

export const conversaoDeAgendamentoHandler: EventHandler = {
  key: CONSUMER_KEY,
  events: ["appointment.created", "appointment.confirmed"],
  handle,
};
