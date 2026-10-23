import { guardServiceEffect } from "@/lib/atendimento/fronteira-server";
/**
 * Handoff humano como cidadão de 1ª classe (F4-06; blueprint 5.5 — escalação humana
 * clara e imediata é EXIGÊNCIA fiscalizada da Meta, não fallback). Dois gatilhos, uma
 * ação idempotente:
 *   1. DETERMINÍSTICO — regex PT-BR na última mensagem do lead ("falar com atendente",
 *      "quero falar com uma pessoa"…). Roda no runtime ANTES do modelo: o turno não gasta
 *      LLM. Ele AVISA o lead (texto de código, `avisarLeadDaEscalacao`) e só então silencia
 *      — nesta ordem, porque `force_human` arma o `stopGate` e mata todo envio posterior.
 *   2. TOOL request_human_handoff — o modelo aciona quando percebe o limite da automação.
 *
 * A ação (performHumanHandoff), idempotente e at-least-once — TUDO no mesmo banco agora
 * (a fusão matou o transporte MCP):
 *   (a) FONTE DA VERDADE: contacts.force_human=true — irrevogável (regra dura 2);
 *   (b) conversa: status transiciona SÓ 'ai_handling'→'pending' (CASE — nunca pisa em
 *       claimed/closed) + bot_silenced_until='infinity' + last_handoff_at/reason;
 *   (c) cancela os crons PENDENTES do lead (follow-ups agendados não disparam após handoff);
 *   (d) cria agent_inbox_items(kind='handoff') com o resumo (dedup por episódio aberto).
 *
 * tenant/lead/conversation vêm da ROW do job (closure do run), NUNCA do payload (regra dura 1).
 * O resumo vai ao inbox (é PARA o humano assumir) — mas NUNCA a log (PII fora de log, regra 8).
 */
import { z } from 'zod';
import type pg from 'pg';

import { expectativaDeAtendimento } from '@/lib/escalacao/disponibilidade';
import { ehOptOutProvavel } from '@/lib/opt-out/deteccao';
import { PROVIDERS_COM_SILENCIO_DE_ROTEAMENTO } from '@/lib/channels/capabilities';
import { emitAgentActivityForContact } from '@/lib/leads/agent-activity';

import type { Logger } from '../obs/logger';
import { cancelPendingCronsForLead } from '../cron/scheduler';
import { findForbiddenKey, zodIssuesSummary } from './lead-state';
import { renderDeclaracaoParaHumano, type DeclaracaoDoTurno } from './declaracao';

/** Postgres `infinity`: o bot nunca reassume após handoff. */
const SILENCE_INFINITY = 'infinity';

/**
 * Normaliza para a detecção determinística: minúsculas + sem acento (NFD) — os padrões
 * abaixo são escritos sem acento, então "atendente"/"consultor" casam com/sem diacrítico.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '');
}

/**
 * Padrões PT-BR CONSERVADORES de pedido explícito de atendimento humano (evita falso
 * positivo: exige o verbo de contato + o alvo humano, ou expressões inequívocas). Rodam
 * sobre o texto normalizado (sem acento).
 */
const HUMAN_HANDOFF_PATTERNS: readonly RegExp[] = [
  /\b(?:falar|conversar)\s+com\s+(?:um[a]?\s+)?(?:atendente|humano|pessoa|gente|consultor|vendedor|representante|responsavel)\b/,
  /\bme\s+(?:passa|passe|transfere|transfira|encaminha|encaminhe|manda|mande)\s+(?:pra|para|pro)\s+(?:um[a]?\s+)?(?:atendente|humano|pessoa|gente|setor|comercial)\b/,
  /\batendimento\s+humano\b/,
  /\b(?:atendente|humano|pessoa)\s+de\s+verdade\b/,
];

/** True se a mensagem do lead é um pedido explícito de atendimento humano (determinístico). */
export function detectHumanHandoffRequest(message: string): boolean {
  if (message.trim() === '') return false;
  const normalized = normalize(message);
  return HUMAN_HANDOFF_PATTERNS.some((re) => re.test(normalized));
}

/**
 * ═══ A GUARDA CONTRA O MENU DO ROBÔ DO OUTRO LADO (issue 3106) ═══
 *
 * O defeito medido: a empresa abordada responde à nossa primeira mensagem com o
 * menu automático dela ("1 - Ver produtos · 4 - Falar com um atendente"), o
 * primeiro padrão casa o rótulo da QUARTA OPÇÃO, o turno avisa o robô ("Claro!
 * Já estou chamando alguém da equipe…"), marca `force_human`, joga a conversa na
 * Fila e abre demanda — e o modelo nunca vê a mensagem. Cada caso vira trabalho
 * manual, e o autor mediu dois na mesma semana.
 *
 * A FRASE continua casando: `HUMAN_HANDOFF_PATTERNS` não muda, porque um pedido
 * de verdade precisa ser reconhecido sempre. O que muda é a LEITURA do
 * casamento — antes de passar a conversa, o turno pergunta se o que casou é fala
 * de GENTE. As três marcas abaixo dizem quando NÃO é, e todas se decidem sobre o
 * que o turno JÁ tem em memória (o mesmo histórico que o modelo lê), sem
 * consulta nova e sem relógio do banco:
 *
 *   1. MENU — o texto é um menu E o pedido casado é UMA DAS OPÇÕES dele (o item
 *      numerado "4 - Falar com um atendente", ou um menu que pede "digite o
 *      número" e traz opções numeradas): o rótulo casado não é um pedido;
 *   2. MARCA DE ROBÔ — o texto se DECLARA automação ("sou o assistente
 *      virtual", "esta é uma mensagem automática"): quem escreve isso não é quem
 *      pede uma pessoa. Citar o robô não basta — quem reclama do NOSSO bot cita;
 *   3. JANELA DA ABERTURA — a mensagem chegou segundos depois da mensagem NOSSA
 *      que ABRIU a conversa (o disparo da Prospecção/campanha): é a saudação
 *      automática de quem recebeu o disparo, antes de qualquer pessoa escrever.
 *
 * O que a guarda barra NÃO é silêncio: o turno segue para o MODELO, que vê a
 * mensagem e já sabe reconhecer robô — é a decisão do desenho do autor da issue.
 * E se o robô insistir (o mesmo menu de novo e de novo), quem para o laço é o
 * disjuntor de `robo-do-outro-lado.ts`, que roda ANTES desta guarda no turno e
 * passa a conversa calado: as duas peças se completam, e esta não o substitui.
 * E ela erra para o lado de DEIXAR PASSAR: sem histórico, sem casamento ou com
 * data ilegível, a resposta é "é de gente" e a passagem acontece — `force_human`
 * é irrevogável (regra dura 2), e só marca de automação o justifica barrar.
 */

/**
 * Uma mensagem do histórico do turno, como a guarda a lê.
 *
 * ESTRUTURAL de propósito: a guarda é pura e não arrasta o edge do CRM para
 * dentro do detector determinístico. O `LeadContextMessage` que o turno carrega
 * casa por estrutura, sem adaptador — e `sent_at` é lido com defensividade
 * porque há fixture (e há turno sem relógio) que não o traz.
 */
export interface MensagemDoHistorico {
  direction: 'inbound' | 'outbound';
  body: string;
  sent_at?: string;
}

/**
 * Quantos segundos depois da NOSSA abertura a resposta ainda é a saudação
 * automática do outro lado.
 *
 * Teto CURTO de propósito: quem recebeu um disparo e responde por si costuma
 * levar minutos; um robô responde no mesmo minuto. Passado o minuto, a guarda
 * desta marca para de agir — e as marcas 1 e 2 seguem valendo para o menu.
 */
const SEGUNDOS_DA_SAUDACAO_AUTOMATICA = 60;

/**
 * Onde começa um ITEM de menu: quebra de linha, ou o separador com espaço dos
 * dois lados (" / ", " | ", " • ") do menu de uma linha só — o da issue é
 * "1-Médicos / 2-Terapias / 3-Exames / 4-Falar com um atendente". O espaço é
 * exigido para que a data "12/10" não vire dois itens.
 */
const SEPARADOR_DE_ITEM = /\n|\s[/|•]\s/;

/**
 * Rótulos de OPÇÃO numerada: "1 - …", "2)", "3.", "*4*. Só no começo de um ITEM
 * (ver `SEPARADOR_DE_ITEM`), não números soltos no meio de uma frase: quem
 * escreve "chegou em 2 minutos" não está montando um menu.
 */
const OPCAO_NUMERADA = /(?:^|\n|\s[/|•]\s)\s*\*{0,2}\d{1,2}\s*[-–—.)\]]|\*\d{1,2}\*|\d\ufe0f?\u20e3/g;

/** O mesmo rótulo, perguntado a UM item já separado (sem `g`: `test` sem estado). */
const ITEM_NUMERADO = /^\s*\*{0,2}\d{1,2}\s*[-–—.)\]]|\*\d{1,2}\*|\d\ufe0f?\u20e3/;

/**
 * Como um menu PEDE a escolha. "digite o número", "responda com a opção",
 * "selecione uma opção", "menu de opções" — a moldura que transforma uma frase
 * de passagem em RÓTULO de menu.
 */
const INSTRUCOES_DE_MENU: readonly RegExp[] = [
  /\bdigite\s+(?:o\s+|a\s+)?(?:numero|opcao|palavra)\b/,
  /\b(?:responda|responde|escolha|escolhe|selecione|seleciona|aperte|toque)\s+(?:com\s+)?(?:o\s+|a\s+|um\s+|uma\s+)?(?:numero|opcao|palavra)\b/,
  /\bopcao\s+desejada\b/,
  /\bmenu\s+(?:de\s+opcoes|abaixo|acima|principal)\b/,
  /\b(?:as|nas)\s+opcoes\s+(?:abaixo|acima|ao\s+lado)\b/,
];

/**
 * Marcas em que a própria mensagem se declara AUTOMAÇÃO. Lista CURTA e
 * deliberada: só entra o que uma pessoa não escreve sobre si ao pedir uma
 * pessoa passar a conversa — por isso só AUTODECLARAÇÃO ("sou o…", "esta é
 * uma…"), nunca a menção solta. "esse assistente virtual não resolve nada",
 * "cansei de mensagem automática de vocês" e "aqui é o bot de novo?" são gente
 * reclamando do NOSSO robô, e têm de passar — como "não sou um robô", que é
 * gente provando que é gente.
 */
const MARCAS_DE_ROBO: readonly RegExp[] = [
  /(?<!\bnao\s+)\bsou\s+(?:o|a|um|uma)\s+(?:assistente\s+(?:virtual|digital)|robo|bot)\b/,
  /\best[ae]\s+(?:e\s+uma\s+(?:mensagem|resposta)\s+automatica|(?:mensagem|resposta)\s+e\s+automatica)\b/,
];

/**
 * A mensagem é um MENU de opções numeradas? (marca 1)
 *
 * Duas linhas numeradas, OU uma instrução explícita de escolha. O limiar de duas
 * é a diferença entre um menu e uma frase que cita "opção 4"; `HUMAN_HANDOFF_
 * PATTERNS` casa os dois, e é o menu que não pode virar passagem.
 */
export function ehMenuDeOpcoesNumeradas(mensagem: string): boolean {
  if (mensagem.trim() === '') return false;
  const normalizada = normalize(mensagem);
  if (INSTRUCOES_DE_MENU.some((re) => re.test(normalizada))) return true;
  const opcoes = normalizada.match(OPCAO_NUMERADA);
  return opcoes !== null && new Set(opcoes.map((o) => o.replace(/\D/gu, ''))).size >= 2;
}

/**
 * O pedido casado é UMA OPÇÃO do menu? (marca 1, a que a guarda usa)
 *
 * Ser menu não basta: uma pessoa que numera as próprias dúvidas ("1. o preço /
 * 2. o prazo / quero falar com um atendente") escreve um "menu" e pede gente
 * numa linha sem número; e quem reclama do nosso ("não sei qual a opção
 * desejada") cita a instrução sem montar opção nenhuma. Por isso, além de ser
 * menu, exige uma das duas: o pedido cai num ITEM numerado, ou há instrução de
 * menu JUNTO com pelo menos uma opção numerada.
 */
export function pedidoEhOpcaoDoMenu(mensagem: string): boolean {
  if (!ehMenuDeOpcoesNumeradas(mensagem)) return false;
  const normalizada = normalize(mensagem);
  const numerados = normalizada.split(SEPARADOR_DE_ITEM).filter((item) => ITEM_NUMERADO.test(item));
  if (numerados.some((item) => HUMAN_HANDOFF_PATTERNS.some((re) => re.test(item)))) return true;
  return numerados.length > 0 && INSTRUCOES_DE_MENU.some((re) => re.test(normalizada));
}

/**
 * A mensagem se declara automação? (marca 2)
 *
 * `false` para vazio e para o que não casa nada — o turno pergunta isto a TODA
 * mensagem pendente, e a maioria é fala de gente.
 */
export function ehMensagemDeRobo(mensagem: string): boolean {
  if (mensagem.trim() === '') return false;
  const normalizada = normalize(mensagem);
  return MARCAS_DE_ROBO.some((re) => re.test(normalizada));
}

/**
 * A mensagem chegou na janela em que o ROBÔ do outro lado responde sozinho?
 * (marca 3)
 *
 * Exige as três coisas, porque cada uma sozinha é fraca:
 *
 *   • a PRIMEIRA mensagem do histórico é NOSSA — a conversa nasceu de um disparo
 *     nosso (Prospecção/campanha), e não de alguém que procurou a empresa;
 *   • a mensagem avaliada é a ocorrência MAIS RECENTE daquele texto no histórico
 *     (as pendentes são a cauda do histórico; sem ocorrência, não há o que medir);
 *   • a distância até a nossa abertura cabe em `SEGUNDOS_DA_SAUDACAO_AUTOMATICA`.
 *
 * Data ilegível ou ausente desliga a marca (devolve `false`): a passagem
 * continua acontecendo, que é o lado seguro.
 */
export function chegouNaJanelaDaSaudacaoAutomatica(
  mensagem: string,
  historico: readonly MensagemDoHistorico[],
): boolean {
  const abertura = historico[0];
  if (abertura === undefined || abertura.direction !== 'outbound') return false;

  const corpo = mensagem.trim();
  let avaliada: MensagemDoHistorico | null = null;
  for (let i = historico.length - 1; i >= 0; i -= 1) {
    const m = historico[i];
    if (m !== undefined && m.direction === 'inbound' && m.body.trim() === corpo) {
      avaliada = m;
      break;
    }
  }
  if (avaliada === null) return false;

  const t0 = typeof abertura.sent_at === 'string' ? Date.parse(abertura.sent_at) : NaN;
  const t1 = typeof avaliada.sent_at === 'string' ? Date.parse(avaliada.sent_at) : NaN;
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return false;

  const segundos = (t1 - t0) / 1000;
  return segundos >= 0 && segundos <= SEGUNDOS_DA_SAUDACAO_AUTOMATICA;
}

/**
 * A resposta que casou um padrão de pedido de humano é de um ROBÔ? (issue 3106)
 *
 * É a pergunta que o turno faz ANTES de passar a conversa: `true` = o casamento
 * veio de menu/automação, e o turno segue para o modelo; `false` = é fala de
 * gente (ou não há evidência em contrário), e a passagem determinística acontece
 * como sempre.
 */
export function ehRespostaDeRobo(
  mensagem: string,
  historico: readonly MensagemDoHistorico[] = [],
): boolean {
  if (mensagem.trim() === '') return false;
  if (pedidoEhOpcaoDoMenu(mensagem)) return true;
  if (ehMensagemDeRobo(mensagem)) return true;
  return chegouNaJanelaDaSaudacaoAutomatica(mensagem, historico);
}


/**
 * True se a última mensagem do lead SUGERE opt-out. A regra mora em
 * `lib/opt-out/deteccao.ts` — a MESMA que a ingestão usa para gravar o bloqueio,
 * e é o ponto: enquanto eram duas, o runtime era o lado calibrado e a ingestão
 * bloqueava paciente que só perguntou como parar a dor.
 *
 * Aqui vale o nível PROVÁVEL (inequívoco + ambíguo), e não o inequívoco: este
 * sinal só para de responder e escala à inbox — não silencia ninguém para
 * sempre. Quem tem esse poder é a pessoa que confirma o bloqueio no CRM.
 */
export function detectAmbiguousOptOut(message: string): boolean {
  return ehOptOutProvavel(message);
}

/**
 * NO-OP de runs futuros (acceptance 2): o lead está em handoff quando force_human está
 * setado no contato OU alguma conversa dele ainda está silenciada (bot_silenced_until no
 * futuro — 'infinity' sempre vale). Lido no INÍCIO do turno, antes de qualquer chamada
 * de modelo. Só o humano (via CRM) libera.
 */
export async function isLeadInHandoff(
  db: pg.Pool,
  tenantId: string,
  leadId: string,
  /**
   * `ignorarTravaDoContato`: só o silêncio conta, não o `force_human`. Para o
   * passo fixo de fluxo e para a "pessoa no comando" do turno de fluxo: a marca
   * "sempre atendimento humano" cala a IA, não é uma pessoa assumindo.
   */
  opcoes: { ignorarTravaDoContato?: boolean } = {},
): Promise<boolean> {
  // Conversa em canal sem IA (Instagram) nasce com bot_silenced_until =
  // 'infinity' para cair na Fila: é ROTEAMENTO, não uma pessoa que assumiu.
  // Esta varredura é do CONTATO inteiro; sem a exclusão, um contato unificado
  // (Instagram + WhatsApp) calava a IA também no WhatsApp. A própria conversa
  // do Instagram segue barrada pela elegibilidade (o silêncio dela conta lá) e
  // pela recusa do servidor.
  const { rows } = await db.query<{ handoff: boolean }>(
    `select (
       ${opcoes.ignorarTravaDoContato === true ? 'false' : 'c.force_human'}
       or exists (
         select 1 from conversations v
         where v.organization_id = $1 and v.contact_id = c.id
           and v.bot_silenced_until is not null and v.bot_silenced_until > now()
           and not exists (
             select 1 from channel_sessions s
             where s.organization_id = $1 and s.id = v.channel_session_id and s.provider = any($3::text[])
           )
       )
     ) as handoff
     from contacts c
     where c.organization_id = $1 and c.id = $2`,
    [tenantId, leadId, PROVIDERS_COM_SILENCIO_DE_ROTEAMENTO],
  );
  return rows[0]?.handoff === true;
}

export interface HandoffIds {
  tenantId: string;
  leadId: string;
  /** conversations.id — a conversa que transiciona para a fila humana. */
  conversationId: string;
}

/**
 * Executa o handoff (idempotente, at-least-once) — tudo no banco do CRM, sem transporte.
 * Re-executar no mesmo episódio é no-op semântico: force_human/silêncio já setados, o
 * CASE do status não pisa em estado humano (claimed/closed) e o inbox deduplica.
 */
export async function performHumanHandoff(
  db: pg.Pool,
  ids: HandoffIds,
  opts: {
    reason: string;
    conversationSummary: string;
    inboxTitle?: string;
    /**
     * O desfecho do aviso que o chamador mandou ao lead ANTES desta passagem
     * (`avisarLeadDaEscalacao`). Opcional porque nem todo chamador é o motor de
     * conversa — o "Assumir eu" de um caso é acionado por uma pessoa que já está
     * na conversa e fala por si.
     *
     * Quando presente, ele vira LINHA no aviso da Central. A pergunta que o
     * atendente faz ao abrir a conversa é "essa pessoa sabe que estou vindo?", e
     * a resposta muda a primeira frase que ele digita. Falhar fechado na ação,
     * aberto na informação.
     */
    avisoAoLead?: { avisado: boolean; porque?: string };
    log: Logger;
  },
): Promise<void> {
  // (a) FONTE DA VERDADE: force_human no contato — irrevogável pelo agente (regra dura 2).
  await guardServiceEffect();
  await db.query(`update contacts set force_human = true where organization_id = $1 and id = $2`, [
    ids.tenantId,
    ids.leadId,
  ]);

  // (b) Conversa: silencia o bot para sempre e devolve à fila humana. O status SÓ
  // transiciona 'ai_handling'→'pending' — conversa já claimed/closed/pending fica como
  // está (nunca rouba do humano nem reabre encerrada). Fase 3: junto, zera a aderência
  // ao agente do router — se o bot for reativado, o router decide de novo (não reassume
  // o mesmo agente por inércia).
  await guardServiceEffect();
  await db.query(
    `update conversations
        set status = case when status = 'ai_handling' then 'pending' else status end,
            bot_silenced_until = $3,
            last_handoff_at = now(),
            last_handoff_reason = $4,
            active_ai_agent_id = null,
            active_intent = null,
            active_agent_set_at = null
      where organization_id = $1 and id = $2`,
    [ids.tenantId, ids.conversationId, SILENCE_INFINITY, opts.reason],
  );

  // (c) Cancela os crons PENDENTES do lead (follow-ups agendados — F3-01/02). Idempotente,
  // via o cancel compartilhado (mesma garantia que o opt-out irrevogável usa — F4-07).
  await guardServiceEffect();
  await cancelPendingCronsForLead(db, ids.tenantId, ids.leadId);

  // (d) inbox de escalação com o resumo da conversa. Dedup por episódio ABERTO (mesmo padrão
  // do escalateJailbreakPromise): 2× no mesmo handoff aberto → 1 item.
  await guardServiceEffect();
  await db.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
     select $1, 'handoff', 'critical', $2, $3, 'contact', $4
     where not exists (
       select 1 from agent_inbox_items
       where organization_id = $1 and kind = 'handoff' and ref_kind = 'contact' and ref_id = $4 and status = 'open'
     )`,
    [
      ids.tenantId,
      opts.inboxTitle ?? 'Handoff humano solicitado — assumir a conversa',
      `Motivo: ${opts.reason}. ${linhaDoAviso(opts.avisoAoLead)}Resumo da conversa até aqui:\n${opts.conversationSummary}`,
      ids.leadId,
    ],
  );

  // (e) A IDA na linha do tempo do NEGÓCIO. `triggerHandoff` (o caminho do CRM)
  // já gravava `handoff_triggered`; este caminho — o do harness e o do "Assumir
  // eu" dos casos — não gravava nada. Metade das passagens era invisível no
  // dossiê do cliente, e quem lesse a timeline veria a volta sem a ida.
  //
  // O `reason` é FIXO de propósito: `opts.reason` pode ser o texto livre que o
  // atendente escreveu ao escalar, e esta linha aparece na tela e no export de
  // LGPD (regra do activity-emitter: o porquê é legível, sem PII).
  //
  // Try/catch porque a timeline não pode derrubar a operação que ela descreve —
  // mesma disciplina fire-and-forget do emissor da API.
  try {
    const roteou = await emitAgentActivityForContact({
      pool: db,
      organizationId: ids.tenantId,
      contactId: ids.leadId,
      type: 'handoff_triggered',
      sourceModule: 'human-handoff',
      sourceId: ids.conversationId,
      reason: 'Atendimento passado para uma pessoa',
      payload: { conversation_id: ids.conversationId },
    });
    if (!roteou.routed) {
      opts.log.warn('handoff: atividade não roteada para um negócio', { reason: roteou.reason });
    }
  } catch (err) {
    opts.log.warn('handoff: atividade da passagem não foi gravada', {
      error: err instanceof Error ? err.message.slice(0, 200) : 'erro desconhecido',
    });
  }

  // PII fora do log: só ids/motivo — nunca o resumo da conversa (regra dura 8).
  opts.log.info('handoff humano aplicado (force_human + silêncio + crons cancelados + inbox)', {
    reason: opts.reason,
  });
}

/**
 * A linha do aviso da Central que responde "essa pessoa sabe que estou vindo?".
 *
 * Ausente = o chamador não mandou aviso nenhum (caminho acionado por uma pessoa),
 * e aí o silêncio é honesto: nada a afirmar. Presente e falso = o cliente está
 * esperando SEM SABER, e o atendente precisa abrir a conversa se apresentando.
 */
function linhaDoAviso(aviso: { avisado: boolean; porque?: string } | undefined): string {
  if (aviso === undefined) return '';
  if (aviso.avisado) return 'O cliente JÁ FOI avisado de que uma pessoa vai assumir. ';
  return `⚠️ O cliente NÃO foi avisado (${aviso.porque ?? 'motivo desconhecido'}) — ele está esperando sem saber. `;
}

/** Whitelist EXATA do payload da tool (mesmo padrão .strict() da F2-10/F3-02). */
export const requestHumanHandoffInputSchema = z.strictObject({
  motivo_codigo: z.enum(['requested_human', 'critical_stage']).optional(),
  reason: z.string().min(1).max(500).optional(),
});

const PAYLOAD_TEACHING =
  'Campos aceitos: motivo_codigo (requested_human para pedido de uma pessoa; critical_stage para ' +
  'uma etapa do atendimento que exige finalização humana) e reason (por que passar ao humano), ' +
  'ambos opcionais, nada além. Lead, organização e conversa vêm do runtime, nunca do payload da tool.';

export type RequestHumanHandoffResult =
  | { ok: true; status: 'handoff_solicitado'; message: string }
  | { ok: false; error: { code: 'invalid_payload'; message: string } };

/**
 * Wrapper da tool request_human_handoff exposta ao modelo. Valida o payload e delega a
 * performHumanHandoff. Erros de DB (ex.: lead sumiu) sobem — o tool wrapper do run os
 * captura e ensina o modelo a encerrar (padrão F2-09).
 */
export async function applyRequestHumanHandoff(
  db: pg.Pool,
  ids: HandoffIds,
  opts: {
    conversationSummary: string;
    /** Ver `performHumanHandoff` — o desfecho do aviso vira linha no aviso da Central. */
    avisoAoLead?: { avisado: boolean; porque?: string };
    log: Logger;
  },
  rawInput: unknown,
): Promise<RequestHumanHandoffResult> {
  const forbidden = findForbiddenKey(rawInput);
  if (forbidden !== null) {
    return { ok: false, error: { code: 'invalid_payload', message: `campos não reconhecidos: ${forbidden}. ${PAYLOAD_TEACHING}` } };
  }
  const parsed = requestHumanHandoffInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: { code: 'invalid_payload', message: `payload inválido em request_human_handoff (${zodIssuesSummary(parsed.error)}). ${PAYLOAD_TEACHING}` } };
  }

  // Ausente = comportamento legado (`requested_human`). O código só classifica
  // a passagem quando a IA não escreveu o motivo: não escolhe destino nem muda
  // as condições do handoff. Portado do projeto original (DeskcommCRM, PR #3068
  // de @vitor-licassali), sem o briefing da passagem, que este fork não tem.
  const motivoCodigo = parsed.data.motivo_codigo ?? 'requested_human';
  await performHumanHandoff(db, ids, {
    reason: parsed.data.reason ?? motivoCodigo,
    conversationSummary: opts.conversationSummary,
    ...(opts.avisoAoLead !== undefined ? { avisoAoLead: opts.avisoAoLead } : {}),
    log: opts.log,
  });

  // ACH-03: a expectativa vai JUNTO com a confirmação. Antes, a mensagem afirmava
  // que "um atendente vai assumir" sem que ninguém tivesse olhado se havia
  // alguém — e o agente repassava essa promessa ao cliente. Agora a resposta
  // carrega o estado real da equipe, e o modelo não precisa lembrar de perguntar.
  const { frase } = await expectativaDeAtendimento(db, ids.tenantId, new Date());

  // ⚠️ A frase anterior era "encerre o turno AGORA, sem enviar mais mensagens ao
  // lead além do aviso" — e prometia uma saída que a PRIMEIRA linha de
  // `performHumanHandoff` acabou de fechar: `force_human = true` arma o
  // `stopGate`, que veta todo envio seguinte. O modelo que obedecesse ao "além
  // do aviso" mandaria uma mensagem que morre no gate, e o lead ficaria mudo.
  // Agora a mensagem AFIRMA o que é verdade: o aviso ou já foi dele, antes da
  // chamada, ou foi do sistema — em nenhum dos casos há uma fala a mais.
  const jaAvisado =
    opts.avisoAoLead === undefined || opts.avisoAoLead.avisado
      ? 'O lead JÁ foi avisado de que uma pessoa vai assumir.'
      : 'ATENÇÃO: não foi possível avisar o lead (o canal recusou a mensagem); a equipe foi alertada disso.';

  return {
    ok: true,
    status: 'handoff_solicitado',
    message:
      `Handoff humano acionado; a conversa saiu do atendimento automático. ${jaAvisado} ${frase} ` +
      'Encerre o turno AGORA — você não consegue mais enviar mensagens a este lead.',
  };
}

/**
 * Resumo curto da conversa para o inbox de escalação — a partir do checkpoint durável
 * (compromissos/objeções/próxima ação/resumo). Vai ao inbox (PARA o humano), nunca a log.
 */
export function buildHandoffSummary(
  previous: {
    commitments: string[];
    objections: string[];
    next_action: string | null;
    rolling_summary: string;
    /**
     * A declaração do último turno (spec 16 §5). Opcional na assinatura porque
     * chamador antigo (e checkpoint gravado antes da coluna existir) não a tem —
     * ausência degrada para o resumo de hoje, nunca quebra o handoff.
     */
    declaracao?: DeclaracaoDoTurno | null;
  } | null,
): string {
  if (previous === null) {
    return 'Sem resumo acumulado ainda (conversa recente) — abra a conversa no CRM para o contexto completo.';
  }
  const parts: string[] = [];
  if (previous.rolling_summary.trim() !== '') parts.push(previous.rolling_summary.trim());
  // A declaração vem ANTES dos campos antigos de propósito: quem assume uma
  // conversa no meio precisa primeiro do que a pessoa quer e do que foi
  // prometido a ela — é o que decide a próxima frase que ele vai digitar.
  // Compromissos e objeções acumulados são contexto, não ação imediata.
  const declarado = renderDeclaracaoParaHumano(previous.declaracao ?? null);
  if (declarado !== '') parts.push(declarado);
  if (previous.commitments.length > 0) parts.push(`Compromissos: ${previous.commitments.join('; ')}`);
  if (previous.objections.length > 0) parts.push(`Objeções: ${previous.objections.join('; ')}`);
  if (previous.next_action) parts.push(`Próxima ação: ${previous.next_action}`);
  return parts.length === 0
    ? 'Sem resumo acumulado ainda (conversa recente) — abra a conversa no CRM para o contexto completo.'
    : parts.join('\n');
}
