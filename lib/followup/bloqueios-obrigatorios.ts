/**
 * Bloqueios OBRIGATÓRIOS do executor de follow-up — conferidos imediatamente
 * antes de cada envio de um fluxo (migration 0263).
 *
 * ═══ POR QUE AQUI, E NÃO NA SUPERVISÃO ═══
 *
 * A supervisão pode DETECTAR que um lembrete saiu para quem já mandou
 * comprovante. Detectar depois não desfaz a mensagem. Quem impede é o executor,
 * no último instante antes do canal, e sem depender de o auditor ter rodado ou
 * de ter rodado rápido. A reatividade (`reactivity.ts`) já invalida sequências
 * quando o evento chega; esta conferência é a segunda camada, para o evento que
 * atrasou, falhou ou ainda não foi drenado.
 *
 * ═══ AS DUAS CLASSES DE BLOQUEIO ═══
 *
 * SEMPRE VALEM (corretos em qualquer nicho, sem configuração):
 *   - opt-out (`contacts.is_blocked`) e contato anonimizado;
 *   - atendimento humano pedido/em curso (`force_human` ou bot silenciado — a
 *     mesma definição de `isLeadInHandoff`; conversa apenas ATRIBUÍDA a alguém
 *     não conta, porque o roteamento atribui responsável a toda conversa);
 *   - negócio em etapa que invalida follow-up (`crm_stages.blocks_followups`,
 *     ex.: comprovante em conferência);
 *   - resposta do contato depois do último envio, quando o fluxo cancela na
 *     resposta (`trigger_config.cancel_on_reply`);
 *   - inscrição que já não está viva.
 *
 * LIGADOS POR ORGANIZAÇÃO (`organizations.settings.followups.bloqueios`),
 * porque dependem do negócio: janela de envio, etapa do gatilho ainda vigente,
 * consulta já confirmada e uma sequência por contato.
 *
 * ═══ FALHA FECHADA ═══
 *
 * Se um bloqueio obrigatório não pode ser verificado — consulta que falhou,
 * configuração ilegível —, NÃO se envia, e o impedimento fica registrado. É o
 * oposto deliberado de `janela-de-atendimento.ts` (que falha aberta para não
 * calar o atendimento): lá o custo do erro é não responder a quem escreveu;
 * aqui é mandar cobrança a quem pediu para parar.
 */
import type pg from 'pg';
import { z } from 'zod';

// ─── configuração da organização ─────────────────────────────────────────────

const HORA = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

const intervaloSchema = z
  .object({ inicio: z.string().regex(HORA), fim: z.string().regex(HORA) })
  .strict()
  .refine((i) => minutos(i.fim) > minutos(i.inicio), { message: 'fim deve ser depois do início' });

export const configDosBloqueiosSchema = z
  .object({
    janela: z
      .object({
        timezone: z.string().min(1),
        /** 0 = domingo … 6 = sábado. */
        dias: z.array(z.number().int().min(0).max(6)).min(1),
        intervalos: z.array(intervaloSchema).min(1),
      })
      .strict()
      .nullable()
      .default(null),
    exigir_etapa_do_gatilho: z.boolean().default(false),
    bloquear_com_consulta_confirmada: z.boolean().default(false),
    uma_sequencia_por_contato: z.boolean().default(false),
  })
  .strict();
export type ConfigDosBloqueios = z.infer<typeof configDosBloqueiosSchema>;

export const CONFIG_SEM_BLOQUEIOS_OPCIONAIS: ConfigDosBloqueios = {
  janela: null,
  exigir_etapa_do_gatilho: false,
  bloquear_com_consulta_confirmada: false,
  uma_sequencia_por_contato: false,
};

/**
 * `undefined` (a organização nunca configurou) = só os bloqueios que sempre
 * valem. Configuração PRESENTE e ilegível = `null`, que o chamador trata como
 * "não verificável" e não envia.
 */
export function lerConfigDosBloqueios(settings: unknown): ConfigDosBloqueios | null {
  const bruto = (settings as { followups?: { bloqueios?: unknown } } | null)?.followups?.bloqueios;
  if (bruto === undefined) return CONFIG_SEM_BLOQUEIOS_OPCIONAIS;
  const parsed = configDosBloqueiosSchema.safeParse(bruto);
  if (!parsed.success) return null;
  if (parsed.data.janela !== null && !fusoValido(parsed.data.janela.timezone)) return null;
  return parsed.data;
}

function minutos(hhmm: string): number {
  const m = HORA.exec(hhmm)!;
  return Number(m[1]) * 60 + Number(m[2]);
}

function fusoValido(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ─── janela semanal ──────────────────────────────────────────────────────────

function partesLocais(agora: Date, tz: string): { dia: number; minuto: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const partes = Object.fromEntries(fmt.formatToParts(agora).map((p) => [p.type, p.value]));
  const dias: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dia: dias[partes.weekday!]!, minuto: Number(partes.hour) * 60 + Number(partes.minute) };
}

export function dentroDaJanela(janela: NonNullable<ConfigDosBloqueios['janela']>, agora: Date): boolean {
  const { dia, minuto } = partesLocais(agora, janela.timezone);
  if (!janela.dias.includes(dia)) return false;
  // Fim EXCLUSIVO: "até 12h" não envia às 12:00.
  return janela.intervalos.some((i) => minuto >= minutos(i.inicio) && minuto < minutos(i.fim));
}

/**
 * Próxima abertura da janela, com precisão de minuto. Varre até 8 dias à frente
 * (uma semana inteira mais folga): janela válida sempre tem uma abertura nesse
 * horizonte, e a varredura por minuto evita aritmética de fuso/horário de verão.
 */
export function proximaAbertura(janela: NonNullable<ConfigDosBloqueios['janela']>, agora: Date): Date | null {
  const inicio = new Date(Math.ceil(agora.getTime() / 60_000) * 60_000);
  for (let passo = 0; passo <= 8 * 24 * 60; passo += 1) {
    const t = new Date(inicio.getTime() + passo * 60_000);
    if (dentroDaJanela(janela, t)) return t;
  }
  return null;
}

// ─── a decisão ───────────────────────────────────────────────────────────────

export interface FatosDoEnvio {
  enrollment: { id: string; status: string; started_at: string; pointer_id: string };
  /** `trigger_config` cru do pointer. */
  trigger_config: unknown;
  contato: { is_blocked: boolean; force_human: boolean; is_anonymized: boolean };
  conversa: { bot_silenciado: boolean };
  /** Negócios ABERTOS do contato, com a etapa atual. */
  negocios_abertos: Array<{ stage_id: string; stage_blocks_followups: boolean }>;
  /** Última mensagem recebida do contato e último envio desta inscrição. */
  ultima_recebida_em: string | null;
  ultimo_envio_da_inscricao_em: string | null;
  /** Consultas futuras confirmadas. */
  consultas_confirmadas_futuras: number;
  /** Outras inscrições vivas do contato, com início. */
  outras_inscricoes_vivas: Array<{ id: string; started_at: string }>;
}

export type MotivoDoBloqueio =
  | 'nao_verificavel'
  | 'configuracao_invalida'
  | 'inscricao_encerrada'
  | 'opt_out'
  | 'contato_anonimizado'
  | 'atendimento_humano'
  | 'etapa_bloqueia_followup'
  | 'resposta_do_contato'
  | 'fora_da_etapa_do_gatilho'
  | 'consulta_confirmada'
  | 'sequencia_concorrente'
  | 'fora_da_janela';

export type DecisaoDoEnvio =
  | { envia: true }
  /** Não envia AGORA e reagenda para a abertura da janela. */
  | { envia: false; motivo: 'fora_da_janela'; adiarPara: Date }
  /**
   * Não envia. `invalida`: a sequência não tem mais razão de seguir e é
   * cancelada com o motivo. Sem `invalida` (atendimento humano), o envio é
   * pulado e a política de handoff do fluxo decide o resto.
   */
  | { envia: false; motivo: Exclude<MotivoDoBloqueio, 'fora_da_janela'>; invalida: boolean };

function cancelaNaResposta(triggerConfig: unknown): boolean {
  return (
    typeof triggerConfig === 'object' &&
    triggerConfig !== null &&
    (triggerConfig as { cancel_on_reply?: unknown }).cancel_on_reply === true
  );
}

function etapaDoGatilho(triggerConfig: unknown): string | null {
  if (typeof triggerConfig !== 'object' || triggerConfig === null) return null;
  const t = triggerConfig as { kind?: unknown; params?: { stage_id?: unknown } };
  return t.kind === 'stage_change' && typeof t.params?.stage_id === 'string' ? t.params.stage_id : null;
}

/**
 * A ordem é de gravidade, e a primeira que casar decide: irrevogáveis (opt-out,
 * anonimizado) antes de tudo; a janela por último, porque só ela adia em vez de
 * impedir — adiar um envio que outra regra proíbe só empurraria o veto.
 */
export function decidirEnvio(
  fatos: FatosDoEnvio,
  config: ConfigDosBloqueios | null,
  agora: Date,
): DecisaoDoEnvio {
  if (config === null) return { envia: false, motivo: 'configuracao_invalida', invalida: false };
  if (fatos.enrollment.status !== 'active' && fatos.enrollment.status !== 'waiting_reply') {
    return { envia: false, motivo: 'inscricao_encerrada', invalida: false };
  }
  if (fatos.contato.is_anonymized) return { envia: false, motivo: 'contato_anonimizado', invalida: true };
  if (fatos.contato.is_blocked) return { envia: false, motivo: 'opt_out', invalida: true };
  if (fatos.contato.force_human || fatos.conversa.bot_silenciado) {
    return { envia: false, motivo: 'atendimento_humano', invalida: false };
  }
  if (fatos.negocios_abertos.some((n) => n.stage_blocks_followups)) {
    return { envia: false, motivo: 'etapa_bloqueia_followup', invalida: true };
  }
  if (cancelaNaResposta(fatos.trigger_config) && fatos.ultima_recebida_em !== null) {
    const referencia = fatos.ultimo_envio_da_inscricao_em ?? fatos.enrollment.started_at;
    if (Date.parse(fatos.ultima_recebida_em) > Date.parse(referencia)) {
      return { envia: false, motivo: 'resposta_do_contato', invalida: true };
    }
  }
  if (config.exigir_etapa_do_gatilho) {
    const etapa = etapaDoGatilho(fatos.trigger_config);
    if (etapa !== null && !fatos.negocios_abertos.some((n) => n.stage_id === etapa)) {
      return { envia: false, motivo: 'fora_da_etapa_do_gatilho', invalida: true };
    }
  }
  if (config.bloquear_com_consulta_confirmada && fatos.consultas_confirmadas_futuras > 0) {
    return { envia: false, motivo: 'consulta_confirmada', invalida: true };
  }
  if (config.uma_sequencia_por_contato) {
    // A MAIS ANTIGA segue; as posteriores param. Empate de instante: menor id.
    const minha = Date.parse(fatos.enrollment.started_at);
    const anterior = fatos.outras_inscricoes_vivas.some((o) => {
      const t = Date.parse(o.started_at);
      return t < minha || (t === minha && o.id < fatos.enrollment.id);
    });
    if (anterior) return { envia: false, motivo: 'sequencia_concorrente', invalida: true };
  }
  if (config.janela !== null && !dentroDaJanela(config.janela, agora)) {
    const abre = proximaAbertura(config.janela, agora);
    if (abre === null) return { envia: false, motivo: 'configuracao_invalida', invalida: false };
    return { envia: false, motivo: 'fora_da_janela', adiarPara: abre };
  }
  return { envia: true };
}

/** O texto que vai ao `cancel_reason` e ao evento da inscrição. Sem jargão. */
export const TEXTO_DO_BLOQUEIO: Record<MotivoDoBloqueio, string> = {
  nao_verificavel: 'Envio não feito: não foi possível conferir as regras obrigatórias antes do envio.',
  configuracao_invalida: 'Envio não feito: a configuração de bloqueios de follow-up da organização está inválida.',
  inscricao_encerrada: 'Envio não feito: a sequência já tinha sido encerrada.',
  opt_out: 'Sequência encerrada: o contato pediu para não receber mensagens.',
  contato_anonimizado: 'Sequência encerrada: o contato foi anonimizado.',
  atendimento_humano: 'Envio não feito: há atendimento humano pedido ou em curso.',
  etapa_bloqueia_followup: 'Sequência encerrada: o negócio está numa etapa que interrompe follow-ups.',
  resposta_do_contato: 'Sequência encerrada: o contato respondeu.',
  fora_da_etapa_do_gatilho: 'Sequência encerrada: o negócio saiu da etapa que iniciou o fluxo.',
  consulta_confirmada: 'Sequência encerrada: o contato já tem consulta confirmada.',
  sequencia_concorrente: 'Sequência encerrada: outra sequência já está em andamento para este contato.',
  fora_da_janela: 'Envio adiado para a próxima janela permitida.',
};

// ─── leitura (pg) ────────────────────────────────────────────────────────────

export type LeituraDosBloqueios =
  | { ok: true; fatos: FatosDoEnvio; config: ConfigDosBloqueios | null }
  | { ok: false };

/**
 * Lê TUDO que a decisão precisa, filtrando `organization_id` em cada consulta.
 * Qualquer falha devolve `{ ok: false }` — nunca fatos parciais.
 */
export async function lerFatosDoEnvio(
  pool: Pick<pg.Pool, 'query'>,
  input: { organizationId: string; contactId: string; conversationId: string; enrollmentId: string },
): Promise<LeituraDosBloqueios> {
  const { organizationId: org, contactId, conversationId, enrollmentId } = input;
  try {
    const [insc, contato, conversa, negocios, recebida, enviada, consultas, outras, organizacao] = await Promise.all([
      pool.query<{ id: string; status: string; started_at: Date; pointer_id: string; trigger_config: unknown }>(
        `select e.id, e.status, e.started_at, e.pointer_id, p.trigger_config
           from followup_enrollments e
           join followup_flow_pointers p on p.id = e.pointer_id and p.organization_id = e.organization_id
          where e.organization_id = $1 and e.id = $2 and e.contact_id = $3`,
        [org, enrollmentId, contactId],
      ),
      pool.query<{ is_blocked: boolean; force_human: boolean; is_anonymized: boolean }>(
        `select is_blocked, force_human, is_anonymized from contacts where organization_id = $1 and id = $2`,
        [org, contactId],
      ),
      pool.query<{ bot_silenciado: boolean }>(
        `select (bot_silenced_until is not null and bot_silenced_until > now()) as bot_silenciado
           from conversations where organization_id = $1 and id = $2 and contact_id = $3`,
        [org, conversationId, contactId],
      ),
      pool.query<{ stage_id: string; stage_blocks_followups: boolean }>(
        `select l.stage_id, coalesce(s.blocks_followups, false) as stage_blocks_followups
           from crm_leads l
           join crm_stages s on s.id = l.stage_id and s.organization_id = l.organization_id
          where l.organization_id = $1 and l.contact_id = $2 and l.status = 'open'`,
        [org, contactId],
      ),
      pool.query<{ em: Date | null }>(
        `select max(created_at) as em from messages
          where organization_id = $1 and contact_id = $2 and direction = 'inbound'`,
        [org, contactId],
      ),
      pool.query<{ em: Date | null }>(
        `select max(created_at) as em from followup_enrollment_events
          where organization_id = $1 and enrollment_id = $2 and event_type = 'action_sent'`,
        [org, enrollmentId],
      ),
      pool.query<{ n: string }>(
        `select count(*)::text as n from calendar_appointments
          where organization_id = $1 and contact_id = $2 and status = 'confirmed' and starts_at > now()`,
        [org, contactId],
      ),
      pool.query<{ id: string; started_at: Date }>(
        `select id, started_at from followup_enrollments
          where organization_id = $1 and contact_id = $2 and id <> $3
            and status in ('active', 'waiting_reply', 'paused_handoff')`,
        [org, contactId, enrollmentId],
      ),
      pool.query<{ settings: unknown }>(`select settings from organizations where id = $1`, [org]),
    ]);
    const e = insc.rows[0];
    const c = contato.rows[0];
    const v = conversa.rows[0];
    const o = organizacao.rows[0];
    if (e === undefined || c === undefined || v === undefined || o === undefined) return { ok: false };
    const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
    return {
      ok: true,
      config: lerConfigDosBloqueios(o.settings),
      fatos: {
        enrollment: { id: e.id, status: e.status, started_at: iso(e.started_at)!, pointer_id: e.pointer_id },
        trigger_config: e.trigger_config,
        contato: c,
        conversa: v,
        negocios_abertos: negocios.rows,
        ultima_recebida_em: iso(recebida.rows[0]?.em),
        ultimo_envio_da_inscricao_em: iso(enviada.rows[0]?.em),
        consultas_confirmadas_futuras: Number(consultas.rows[0]?.n ?? '0'),
        outras_inscricoes_vivas: outras.rows.map((r) => ({ id: r.id, started_at: iso(r.started_at)! })),
      },
    };
  } catch {
    return { ok: false };
  }
}
