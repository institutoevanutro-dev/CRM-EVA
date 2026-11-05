/**
 * Loader do Intent Router (Fase 3 do épico harness — spec 2026-07-23,
 * migration 0085). `ai_routers`/`ai_router_members` são tabelas EDITÁVEIS
 * (não versão+ponteiro como ai_agents): mutação vem auditada por trigger.
 *
 * Contrato:
 *   - resolvido no início de CADA turno (zero cache de processo);
 *   - no máximo 1 router ativo por channel_session (índice parcial da 0085);
 *   - sem router ativo para a sessão ⇒ null (fluxo atual, sem router, segue igual);
 *   - leitura DEFENSIVA do `config` jsonb: shape errado cai no default e
 *     nunca derruba o turno.
 */
import type pg from 'pg';

import { NAO_REABRE_JANELA_DIAS_PADRAO } from '@/lib/escalacao/fala-da-equipe';

export interface RouterMember {
  agentId: string;
  intentName: string;
  intentDescription: string;
  examples: string[];
}

export interface LoadedRouter {
  id: string;
  name: string;
  /**
   * `null` = "Automático": o seam decide (painel de provedores, senão o padrão
   * da organização). NUNCA um id fixo aqui — o seam trata o modelo do call site
   * como knob de ambiente, que vence o padrão da org, e um `claude-haiku-4-5`
   * fixo ia para o endpoint da OpenAI numa org só-OpenAI: toda classificação
   * falhava com "modelo inexistente".
   */
  classifierModel: string | null;
  /**
   * Provedor do classificador, quando o roteador escolhe um diferente do da org.
   *
   * O modelo sozinho não basta: `resolveOrgLlmConfig` decide o provedor por
   * `organizations.settings.llm.provider`, então gravar só `classifier_model`
   * com um id de outro provedor manda o modelo para a casa errada. Uma
   * organização com provedor Anthropic e crédito só na OpenAI ficava sem saída
   * — o classificador falhava e TODO turno caía no fallback.
   *
   * `null` = usa o provedor da organização (o comportamento de antes).
   */
  classifierProvider: string | null;
  sticky: boolean;
  minConfidence: number;
  /**
   * Quem decide a troca de agente com a conversa em andamento.
   * `'roteador'` (padrão, o comportamento de sempre): o roteador, a cada mensagem.
   * `'agente'`: o roteador escolhe quem começa e só interrompe para os assuntos
   * de `interrompe`; fora disso a conversa fica com quem está atendendo.
   */
  permanencia: 'roteador' | 'agente';
  /**
   * Nomes de assunto que tiram a conversa de quem está atendendo no modo
   * `'agente'`. Nome que não é membro do roteador fica na lista e nunca casa: o
   * classificador só devolve nome de membro.
   */
  interrompe: string[];
  /**
   * Só no modo `'agente'`: horas sem turno atendido depois das quais a conversa
   * deixa de ter agente atual e o roteador classifica do zero. Padrão 24.
   */
  permanenciaExpiraHoras: number;
  fallbackAgentId: string | null;
  members: RouterMember[];
  /**
   * `config.nao_reabre_apos_equipe`: assuntos que a IA NUNCA reabre numa
   * conversa em que alguém da equipe já escreveu (tela, API de usuário ou
   * celular). Turno que cairia num deles vai para o fallback; se o fallback
   * também está na lista, a IA não fala (`resolve-turn-agent.ts`). Vazio = a
   * regra não existe (o padrão).
   */
  naoReabreAposEquipe?: string[];
  /**
   * `config.nao_reabre_janela_dias` (padrão `NAO_REABRE_JANELA_DIAS_PADRAO`):
   * só a fala da equipe destes últimos dias conta para `naoReabreAposEquipe`.
   * Medido no Instituto em 04/11/2026: 81% das conversas dos últimos 30 dias já
   * tinham fala da equipe, então sem janela a regra calaria a qualificação de
   * quase todo mundo que voltasse meses depois.
   */
  naoReabreJanelaDias?: number;
  /**
   * `config.so_equipe`: o classificador também conhece as intenções fixas do
   * produto (`ASSUNTOS_SO_DA_EQUIPE`, conversa de negócio e mensagem
   * automática). `true` = o turno que cai nelas passa à equipe sem resposta da
   * IA; `'observar'` = só registra (`turno_so_da_equipe_observado`) e a IA
   * atende como sempre, para medir o falso positivo antes de ligar. Desligado
   * por padrão: o prompt do roteador fica byte a byte o de sempre.
   */
  soEquipe?: boolean | 'observar';
}

/** `config.permanencia_expira_horas` ausente ou fora da forma. */
export const PERMANENCIA_EXPIRA_HORAS_PADRAO = 24;

/**
 * O fallback que declarou OUTROS números some do roteador deste número
 * (migration 0380): vira "sem fallback", e a régua 5 de `resolve-turn-agent`
 * segue para o agente da sessão. Na mesma leitura do roteador, sem ida a mais.
 */
const FALLBACK_QUE_ATENDE_NO_NUMERO = `case
       when fallback_agent_id is null
         or public.fn_agente_atende_no_numero(organization_id, fallback_agent_id, channel_session_id)
       then fallback_agent_id
     end as fallback_agent_id`;

interface RouterRow {
  id: string;
  name: string;
  config: Record<string, unknown> | null;
  fallback_agent_id: string | null;
  channel_session_id: string;
}

interface MemberRow {
  agent_id: string;
  intent_name: string;
  intent_description: string;
  examples: string[] | null;
}

export async function loadActiveRouter(
  db: pg.Pool,
  organizationId: string,
  channelSessionId: string,
): Promise<LoadedRouter | null> {
  const { rows: routerRows } = await db.query<RouterRow>(
    `select id, name, config, channel_session_id, ${FALLBACK_QUE_ATENDE_NO_NUMERO}
     from ai_routers
     where organization_id = $1
       and channel_session_id = $2
       and is_active`,
    [organizationId, channelSessionId],
  );
  const router = routerRows[0];
  if (router === undefined) return null;
  return montar(db, organizationId, router);
}

/**
 * O roteador pelo id, ATIVO OU NÃO — para a tela de teste, que precisa
 * classificar antes de alguém ligar o roteador no canal. O turno de produção
 * nunca usa esta porta: ele resolve por canal e exige `is_active`
 * (`loadActiveRouter`). Roteador de outra organização devolve `null`.
 */
export async function loadRouterById(
  db: pg.Pool,
  organizationId: string,
  routerId: string,
): Promise<LoadedRouter | null> {
  const { rows: routerRows } = await db.query<RouterRow>(
    `select id, name, config, channel_session_id, ${FALLBACK_QUE_ATENDE_NO_NUMERO}
     from ai_routers
     where organization_id = $1
       and id = $2`,
    [organizationId, routerId],
  );
  const router = routerRows[0];
  if (router === undefined) return null;
  return montar(db, organizationId, router);
}

async function montar(
  db: pg.Pool,
  organizationId: string,
  router: RouterRow,
): Promise<LoadedRouter> {
  // O membro que declarou OUTROS números não é oferecido neste roteador
  // (migration 0380): o classificador nem vê o assunto dele, e a conversa não
  // gruda nele. O fallback segue a mesma régua (`FALLBACK_QUE_ATENDE_NO_NUMERO`).
  const { rows: memberRows } = await db.query<MemberRow>(
    `select agent_id, intent_name, intent_description, examples
     from ai_router_members
     where router_id = $1
       and organization_id = $2
       and public.fn_agente_atende_no_numero(organization_id, agent_id, $3)
     order by position asc, intent_name asc`,
    [router.id, organizationId, router.channel_session_id],
  );

  const cfg = (router.config ?? {}) as {
    classifier_model?: unknown;
    classifier_provider?: unknown;
    sticky?: unknown;
    min_confidence?: unknown;
    permanencia?: unknown;
    permanencia_expira_horas?: unknown;
    interrompe?: unknown;
    nao_reabre_apos_equipe?: unknown;
    nao_reabre_janela_dias?: unknown;
    so_equipe?: unknown;
  };
  const classifierModel =
    typeof cfg.classifier_model === 'string' && cfg.classifier_model.trim() !== ''
      ? cfg.classifier_model
      : null;
  const classifierProvider =
    typeof cfg.classifier_provider === 'string' && cfg.classifier_provider.trim() !== ''
      ? cfg.classifier_provider
      : null;
  const minConfidence =
    typeof cfg.min_confidence === 'number' && cfg.min_confidence >= 0 && cfg.min_confidence <= 1
      ? cfg.min_confidence
      : 0.6;
  // Só o valor exato liga o modo novo: qualquer outra coisa é o roteador de sempre.
  const permanencia = cfg.permanencia === 'agente' ? 'agente' : 'roteador';
  // No modo novo a permanência não é opção: sem ela o roteador reclassifica do
  // zero a cada mensagem e desfaz, na mensagem seguinte, a passagem que o agente
  // acabou de fazer (`transfer_to_subject`).
  const sticky = permanencia === 'agente' || (typeof cfg.sticky === 'boolean' ? cfg.sticky : true);
  const expira = cfg.permanencia_expira_horas;
  const permanenciaExpiraHoras =
    typeof expira === 'number' && Number.isFinite(expira) && expira > 0 ? expira : PERMANENCIA_EXPIRA_HORAS_PADRAO;
  // Aparado: 'queixa_clinica ' digitado com espaço tem de casar com o membro.
  const listaDeAssuntos = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .filter((i): i is string => typeof i === 'string')
          .map((i) => i.trim())
          .filter((i) => i !== '')
      : [];
  const interrompe = listaDeAssuntos(cfg.interrompe);
  const naoReabreAposEquipe = listaDeAssuntos(cfg.nao_reabre_apos_equipe);
  const janela = cfg.nao_reabre_janela_dias;
  const naoReabreJanelaDias =
    typeof janela === 'number' && Number.isFinite(janela) && janela > 0 ? janela : NAO_REABRE_JANELA_DIAS_PADRAO;

  return {
    id: router.id,
    name: router.name,
    classifierModel,
    classifierProvider,
    sticky,
    minConfidence,
    permanencia,
    interrompe,
    permanenciaExpiraHoras,
    fallbackAgentId: router.fallback_agent_id,
    naoReabreAposEquipe,
    naoReabreJanelaDias,
    // Só o booleano exato ou "observar": "sim", 1 e afins ficam desligados.
    soEquipe: cfg.so_equipe === true ? true : cfg.so_equipe === 'observar' ? 'observar' : false,
    members: memberRows.map((m) => ({
      agentId: m.agent_id,
      intentName: m.intent_name,
      intentDescription: m.intent_description,
      examples: m.examples ?? [],
    })),
  };
}
