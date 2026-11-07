/**
 * Resolvedor do turno do Intent Router (Fase 3 — Task 4): decide QUAL agente
 * atende o turno — sticky → classificação → fallback → genérico. Task 5
 * (inbound-turn) consome `TurnAgentResolution` no lugar da chamada direta a
 * `loadPublishedAgentConfig` por channel_session.
 *
 * Regra de decisão (spec 2026-07-23, decisões do Rafael 2026-07-26):
 *   1. sem router ativo pra sessão ⇒ fluxo atual intacto (config por sessão).
 *   2. sticky ativo (router.sticky + stickyAgentId ainda membro do router):
 *      classifica MESMO ASSIM (barato, é o que detecta troca de assunto) —
 *      só troca se a intenção vier DIFERENTE da sticky E confiança >= min;
 *      senão mantém o agente sticky.
 *      2b. roteador com `permanencia: 'agente'` (`ai_routers.config`): além
 *      disso, só troca se a intenção nova estiver em `interrompe`. Fora dessa
 *      lista a conversa fica com quem está atendendo, por mais confiante que
 *      o classificador esteja: uma resposta curta ("Quarta") não tem assunto
 *      próprio, e trocar de agente por causa dela é perder o fio. A regra é
 *      `mudouDeAssunto`; sem agente atual (regra 3) nada muda.
 *      Nesse modo, e só nele, o classificador recebe também a conversa
 *      recente do atendimento e o nome do assunto atual.
 *      Atalho: se nenhum assunto de `interrompe` é membro do roteador e
 *      diferente do assunto atual, nada que o classificador diga troca o
 *      agente. O turno devolve 'sticky' sem ler fatos nem conversa e sem
 *      chamar o modelo.
 *      2c. ainda no modo `'agente'`, a permanência VENCE: se o último turno
 *      atendido (`conversations.active_agent_set_at`) é mais velho que
 *      `permanenciaExpiraHoras` (padrão 24), a conversa é tratada como sem
 *      agente atual e cai na regra 3. Sem isso, quem marcou consulta em março
 *      e escreve "estou com dor" em abril caía no agente de agenda sem o
 *      classificador ser chamado. Só com mensagem para classificar: o
 *      follow-up (regra 6) continua com o agente da conversa. No modo
 *      `'roteador'` não existe prazo: lá o classificador roda a cada mensagem.
 *   3. sem sticky: classifica; intenção não-nula + confiança >= min ⇒ agente
 *      do membro.
 *   4. classificador falhou (null) COM sticky elegível ⇒ mantém o sticky
 *      (outcome 'sticky') — um `null` do classificador é informação MAIS
 *      pobre que "sem sinal" (regra 6), nunca deve derrubar a stickiness.
 *      Sem sticky ⇒ fallback se houver, outcome sempre 'classifier_failed'
 *      (categoria própria, distinta de "classificou e não bateu" — ver
 *      task-4-report.md, review T4 finding 1).
 *   5. sem match / confiança baixa ⇒ fallback se houver (outcome 'fallback'),
 *      senão o agente PUBLICADO DA SESSÃO — o mesmo que responderia se o router
 *      não existisse. Só quando nem esse existe é que sai config:null e o turno
 *      responde com o agente GENÉRICO (decisão do Rafael — não é silêncio).
 *
 *      ⚠️ ESTE DEGRAU DO MEIO NASCEU DE UM DEFEITO MEDIDO (2026-08-18). Antes,
 *      "sem fallback" pulava direto para o genérico — e um router ATIVO com
 *      ZERO membros e sem fallback (estado que a tela deixa criar em dois
 *      cliques, e que classifica nada por construção) sequestrava a sessão
 *      inteira: o agente publicado, com prompt, ferramentas e chave próprios,
 *      deixava de atender TODA mensagem daquele número. Na instalação onde isso
 *      foi medido o genérico caía em `organizations.settings.llm` (provider
 *      'anthropic', sem credencial), então cada turno morria em
 *      `LlmNotConfiguredError`, esgotava as 5 tentativas e virava job morto —
 *      silêncio total, com a tela dizendo "IA atendendo". Um router vazio agora
 *      é inócuo: não casa nada e o número segue atendido por quem estava
 *      publicado.
 *   6. signal null (follow-up, sem mensagem inbound) ⇒ nunca classifica:
 *      sticky se houver, senão fallback, senão genérico.
 *   7. o agente casado (sticky, classificado ou fallback) pode não ter
 *      versão publicada (`loadPublishedAgentConfigById` devolve null) — isso
 *      NUNCA vira outcome de sucesso com config:null (mentira de telemetria,
 *      review T4 finding 4): cai no fallback do router com log.warn, com o
 *      outcome reclassificado honestamente ('fallback'/'no_match'). Se o
 *      PRÓPRIO fallback também não tiver versão publicada, config:null é o
 *      fim legítimo da linha — outcome permanece o que já descrevia a causa.
 *   8. `config.nao_reabre_apos_equipe` (decisão do dono do Instituto, 04/11/2026):
 *      numa conversa em que alguém da equipe escreveu desde o último "Devolver
 *      ao automático" MANUAL, o assunto da lista não é reaberto pela IA. A
 *      devolução manual libera tudo de novo; a automática (fim do dia seguinte,
 *      prazo do handoff) não libera. Só conta a fala dos últimos
 *      `nao_reabre_janela_dias` (padrão 7). Vale também para o agente da
 *      CAMPANHA (degrau 0): se ele é de um assunto da lista, a conversa segue
 *      pela régua normal; e o assunto da lista sai de `assuntos`, então
 *      `transfer_to_subject` não o oferece. O
 *      turno que cairia nele (sticky, classificado, reclassificado) vai para o
 *      fallback, com outcome 'fallback'; o follow-up desse assunto (sem
 *      mensagem) não troca de agente e cala. Se o fallback também está na lista,
 *      sai `bloqueado_apos_equipe` com config null: a IA não fala, e o turno
 *      de entrada passa a conversa à equipe com aviso (`inbound-turn.ts`).
 *   9. `config.so_equipe`: o classificador conhece duas intenções fixas do
 *      produto (conversa de negócio com a empresa e mensagem automática). Com
 *      uma delas, confiança ≥ 0,9 e contato sem nada na agenda, sai
 *      `so_equipe` com config null: a IA não escreve nada e o turno de entrada
 *      passa a conversa à equipe com aviso. A mensagem que ABRE a conversa e se
 *      declara robô, ou é menu de robô (instrução de escolha E duas opções
 *      numeradas), dá o mesmo desfecho sem modelo.
 *      Abaixo do corte, a intenção fixa vale como "nenhuma".
 *      Com `so_equipe: "observar"` a mesma decisão só vai ao log
 *      (`turno_so_da_equipe_observado`, com o motivo) e o turno segue como se
 *      a flag estivesse desligada: nenhum aviso, nada passa à equipe.
 *
 * Robustez: qualquer erro inesperado no branch do router (DB fora do ar,
 * shape quebrado) NUNCA derruba o turno — cai no `loadPublishedAgentConfig`
 * de hoje (sem router) com outcome 'classifier_failed' + log.warn. Um lead
 * real está esperando resposta; o router é estritamente aditivo.
 *
 * ⚠️ "silêncio não é desfecho possível" (regra 5) vale para os turnos que
 * CHEGAM aqui. O gate de elegibilidade (migration 0203, canal com
 * `metadata.ai_gate = 'allowlist'`) barra ANTES — no drain e no início do turno,
 * via `decidirElegibilidadeDaConversa` — quando o contato não veio de uma origem
 * elegível. Ali o silêncio É o desfecho, e de propósito.
 */
import type pg from 'pg';

import type { Logger } from '../obs/logger';
import type { LlmEdgeConfig } from '../edge/llm/run-model-call';
import { agenteDaCampanhaDaConversa } from './agente-da-campanha';
import { loadActiveRouter, type LoadedRouter } from './router-config';
import {
  loadPublishedAgentConfig,
  loadPublishedAgentConfigById,
  type PublishedAgentConfig,
} from './agent-config';
import { classifyIntent, type IntentVerdict } from './intent-classifier';
import { ehAssuntoFixoSoDaEquipe } from './assuntos-so-da-equipe';
import { SEM_ATENDIMENTOS_NA_AGENDA, buildFatosDoContato } from './fatos-do-contato';
import { ehMenuDeRoboComOpcoes, ehMensagemDeRobo } from './human-handoff';
import { historicoRecente, renderHistoricoRecente } from './historico-recente';
import { corpoDaMensagem, type CorpoDaMensagemRow } from '../edge/crm/get-lead-context';
import {
  CHAVE_DA_DEVOLUCAO_MANUAL,
  NAO_REABRE_JANELA_DIAS_PADRAO,
  SQL_FALA_DA_EQUIPE,
} from '@/lib/escalacao/fala-da-equipe';

/**
 * Teto de tempo da leitura dos fatos. Mesmo motivo e mesmo valor do `TETO_MS` de
 * `agente-da-campanha.ts`: um `await` sem limite no caminho quente seguraria o
 * turno inteiro por causa de um enfeite de roteamento. O teto mora aqui e não em
 * `buildFatosDoContato`, que a tela de teste do roteador pode esperar.
 *
 * No modo `permanencia: 'agente'` a conversa recente é lida JUNTO, contra o
 * mesmo relógio: são 500 ms no total, e cada leitura é medida sozinha. A que
 * voltou a tempo vale, mesmo com a vizinha presa.
 */
const TETO_DOS_FATOS_MS = 500;

export interface TurnAgentResolution {
  config: PublishedAgentConfig | null; // null ⇒ turno segue no genérico (comportamento atual)
  routerId: string | null;
  intentName: string | null;
  confidence: number | null;
  outcome:
    | 'no_router'
    | 'classified'
    | 'sticky'
    | 'reclassified'
    | 'fallback'
    | 'no_match'
    | 'classifier_failed'
    /** A conversa nasceu de uma campanha que declarou agente (migration 0267). */
    | 'campanha'
    /**
     * Ninguém resolveu, e foi a declaração de números (migration 0380) que tirou
     * deste número TODO agente que o atenderia. O turno não cai no agente
     * genérico: a declaração disse que aqui a IA não fala. Ver
     * `resolveConversationTurn`.
     */
    | 'numero_recusado'
    /**
     * A equipe já escreveu nesta conversa e o assunto escolhido (e o fallback)
     * está em `nao_reabre_apos_equipe`: a IA não reabre. `config` é null e o
     * turno NÃO cai no genérico — ver `inbound-turn.ts`.
     */
    | 'bloqueado_apos_equipe'
    /**
     * `config.so_equipe`: conversa de negócio ou mensagem automática, de
     * contato sem nada na agenda. `config` é null; o turno de entrada passa a
     * conversa à equipe calado (`turno-da-equipe.ts`). Regra 9.
     */
    | 'so_equipe';
  /**
   * Todos os membros do roteador e o modo dele, sempre que a decisão veio de um
   * roteador (`routerId !== null`). É o que o turno precisa para oferecer
   * `transfer_to_subject` (`passagem-de-assunto.ts`) sem reler o roteador.
   */
  assuntos?: Array<{ intentName: string; description: string; agentId: string }>;
  permanencia?: 'roteador' | 'agente';
}

export interface ResolveTurnAgentDeps {
  log: Logger;
  /** Injetável para o teste não precisar de banco. */
  agenteDaCampanha?: typeof agenteDaCampanhaDaConversa;
  loadActiveRouter?: typeof loadActiveRouter;
  loadPublishedAgentConfigById?: typeof loadPublishedAgentConfigById;
  loadPublishedAgentConfig?: typeof loadPublishedAgentConfig;
  classifyIntent?: typeof classifyIntent;
  buildFatosDoContato?: typeof buildFatosDoContato;
  historicoRecente?: typeof historicoRecente;
  /** Relógio injetável: é o que separa atendimento anterior de compromisso futuro. */
  agora?: () => Date;
}

/** Regra única de troca com conversa em andamento. A rota de teste usa a mesma. */
export function mudouDeAssunto(
  router: Pick<LoadedRouter, 'permanencia' | 'interrompe' | 'minConfidence'>,
  assuntoAtual: string | null,
  verdict: IntentVerdict,
): boolean {
  return (
    verdict.intentName !== null &&
    verdict.intentName !== assuntoAtual &&
    verdict.confidence >= router.minConfidence &&
    // `!== 'agente'` e não `=== 'roteador'`: só o valor exato liga o modo novo,
    // a mesma leitura de `router-config.ts`.
    (router.permanencia !== 'agente' || router.interrompe.includes(verdict.intentName))
  );
}

/**
 * Confiança mínima para calar a IA por conversa de negócio ou mensagem
 * automática, acima do mínimo do roteador quando ele é menor. O erro aqui é
 * calar um cliente real, então o corte é alto.
 */
export const CONFIANCA_MINIMA_SO_EQUIPE = 0.9;

/** O contato não tem nada na agenda. Fatos ilegíveis (`null`) NÃO contam como vazios. */
function semNadaNaAgenda(fatos: string | null): boolean {
  return fatos !== null && fatos.includes(SEM_ATENDIMENTOS_NA_AGENDA);
}

/**
 * Regra 9: o veredito manda o turno à equipe? Só com `config.so_equipe`,
 * intenção fixa do produto, confiança ≥ `CONFIANCA_MINIMA_SO_EQUIPE` e contato
 * sem nada na agenda. A rota de teste do roteador usa a mesma.
 */
export function ehTurnoSoDaEquipe(
  router: Pick<LoadedRouter, 'soEquipe' | 'minConfidence'>,
  verdict: IntentVerdict | null,
  fatos: string | null,
): boolean {
  return (
    (router.soEquipe === true || router.soEquipe === 'observar') &&
    verdict !== null &&
    ehAssuntoFixoSoDaEquipe(verdict.intentName) &&
    verdict.confidence >= Math.max(router.minConfidence, CONFIANCA_MINIMA_SO_EQUIPE) &&
    semNadaNaAgenda(fatos)
  );
}

/**
 * Regra 8: os assuntos de `nao_reabre_apos_equipe` em vigor neste turno. Só a
 * fala da equipe dos últimos `naoReabreJanelaDias` conta (o marco da devolução
 * manual já foi aplicado por quem leu a fala): vale o início mais recente.
 */
function assuntosBloqueados(router: LoadedRouter, falaDaEquipeEm: Date | null | undefined, agoraMs: number): string[] {
  const janelaMs = (router.naoReabreJanelaDias ?? NAO_REABRE_JANELA_DIAS_PADRAO) * 86_400_000;
  const falou = falaDaEquipeEm != null && falaDaEquipeEm.getTime() > agoraMs - janelaMs;
  return falou ? (router.naoReabreAposEquipe ?? []) : [];
}

export async function resolveTurnAgent(
  db: pg.Pool,
  llmCfg: LlmEdgeConfig,
  input: {
    tenantId: string;
    leadId: string;
    jobId: string;
    channelSessionId: string;
    conversationId: string;
    signal: string | null;
    stickyAgentId: string | null;
    stickyIntent: string | null;
    /** `conversations.active_agent_set_at`: o último turno atendido. Ver a regra 2c. */
    stickySetAt?: Date | null;
    /**
     * A última fala da equipe DEPOIS da última devolução manual (`null` = não
     * houve). Conta para a regra 8 só dentro de `naoReabreJanelaDias`.
     */
    falaDaEquipeEm?: Date | null;
    /** Nenhuma saída nossa na conversa ainda (a mensagem abre a conversa). Ver a regra 9. */
    semSaida?: boolean;
  },
  deps: ResolveTurnAgentDeps,
): Promise<TurnAgentResolution> {
  const _loadActiveRouter = deps.loadActiveRouter ?? loadActiveRouter;
  const _loadAgentById = deps.loadPublishedAgentConfigById ?? loadPublishedAgentConfigById;
  const _loadAgentBySession = deps.loadPublishedAgentConfig ?? loadPublishedAgentConfig;
  const _classifyIntent = deps.classifyIntent ?? classifyIntent;
  const _buildFatos = deps.buildFatosDoContato ?? buildFatosDoContato;
  const _historicoRecente = deps.historicoRecente ?? historicoRecente;

  try {
    // ─── Degrau 0: a campanha que criou esta conversa ───
    //
    // ACIMA do roteador de propósito. O roteador é do NÚMERO e classifica
    // assunto; a campanha é a razão de a conversa existir, e ela sabe algo que
    // o classificador não tem como inferir: que esta pessoa está respondendo a
    // uma abordagem, e que quem aborda segue outro roteiro.
    //
    // Falha ABERTA: agente da campanha sem versão publicada devolve `null` em
    // `_loadAgentById`, e o turno segue pela régua normal em vez de calar.
    const agoraMs = (deps.agora ?? (() => new Date()))().getTime();
    // Uma leitura do roteador por turno: a campanha só a pede quando a equipe
    // falou (regra 8), e a régua do número reaproveita a mesma.
    let roteadorLido: Promise<LoadedRouter | null> | undefined;
    const lerRoteador = () => (roteadorLido ??= _loadActiveRouter(db, input.tenantId, input.channelSessionId));
    const _agenteDaCampanha = deps.agenteDaCampanha ?? agenteDaCampanhaDaConversa;
    const idDaCampanha = await _agenteDaCampanha(db, input.tenantId, input.conversationId);
    // Regra 8 vale também para a campanha: com a equipe tendo falado, o agente
    // da campanha que é de um assunto da lista não reabre a conversa. O turno
    // segue pela régua normal, que bloqueia ou passa à equipe.
    let campanhaBloqueada = false;
    if (idDaCampanha !== null && input.falaDaEquipeEm != null) {
      const r = await lerRoteador();
      const bloqueados = r === null ? [] : assuntosBloqueados(r, input.falaDaEquipeEm, agoraMs);
      campanhaBloqueada = r !== null && r.members.some((m) => m.agentId === idDaCampanha && bloqueados.includes(m.intentName));
      if (campanhaBloqueada) {
        deps.log.info('qualificacao_bloqueada_apos_equipe', { routerId: r!.id, alvo: 'campanha' });
      }
    }
    if (idDaCampanha !== null && !campanhaBloqueada) {
      // Com o número: o agente da campanha que declarou OUTROS números não
      // fala neste (migration 0380) — volta null e segue a régua do número.
      const config = await _loadAgentById(db, input.tenantId, idDaCampanha, input.channelSessionId);
      if (config !== null) {
        return { config, routerId: null, intentName: null, confidence: null, outcome: 'campanha' };
      }
      deps.log.warn('agente da campanha sem versão publicada; seguindo pela régua do número', {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
      });
    }

    const router = await lerRoteador();
    if (router === null) {
      return {
        config: await _loadAgentBySession(db, input.tenantId, input.channelSessionId),
        routerId: null,
        intentName: null,
        confidence: null,
        outcome: 'no_router',
      };
    }

    // Regra 8: a equipe já falou nesta conversa e o assunto está na lista
    // `nao_reabre_apos_equipe`. O assunto de um agente é o do membro dele.
    const bloqueados = assuntosBloqueados(router, input.falaDaEquipeEm, agoraMs);
    const assuntoBloqueado = (intentName: string | null, agentId: string): string | null => {
      if (bloqueados.length === 0) return null;
      const assuntos = [intentName, ...router.members.filter((m) => m.agentId === agentId).map((m) => m.intentName)];
      return assuntos.find((a): a is string => a !== null && bloqueados.includes(a)) ?? null;
    };

    // Vai em toda resolução que sai DESTE roteador (`TurnAgentResolution.assuntos`).
    // Sem os assuntos bloqueados pela regra 8: é desta lista que sai o destino
    // de `transfer_to_subject`, e a passagem não pode reabrir o que o roteador
    // não reabre.
    const doRoteador = {
      assuntos: router.members
        .filter((m) => assuntoBloqueado(m.intentName, m.agentId) === null)
        .map((m) => ({
          intentName: m.intentName,
          description: m.intentDescription,
          agentId: m.agentId,
        })),
      permanencia: router.permanencia,
    };

    // fallback do router ou genérico — usado pelas regras 4, 5, 6, 7 e 8.
    const resolveFallback = async (
      outcome: 'no_match' | 'classifier_failed',
      confidence: number | null,
    ): Promise<TurnAgentResolution> => {
      if (router.fallbackAgentId !== null) {
        const assunto = assuntoBloqueado(null, router.fallbackAgentId);
        if (assunto !== null) {
          deps.log.info('qualificacao_bloqueada_apos_equipe', { routerId: router.id, assunto, alvo: 'fallback' });
          return { config: null, routerId: router.id, intentName: null, confidence, outcome: 'bloqueado_apos_equipe', ...doRoteador };
        }
      }
      if (router.fallbackAgentId === null) {
        // Regra 5: sem fallback declarado, quem atende é o agente publicado da
        // SESSÃO — o comportamento de antes do router existir. `null` aqui
        // (nenhum publicado) segue caindo no genérico, como sempre.
        const daSessao = await _loadAgentBySession(db, input.tenantId, input.channelSessionId);
        if (daSessao === null) {
          deps.log.warn('resolve-turn-agent: router sem fallback e sessão sem agente publicado — turno cai no genérico', {
            routerId: router.id,
            outcome,
          });
        }
        return { config: daSessao, routerId: router.id, intentName: null, confidence, outcome, ...doRoteador };
      }
      const config = await _loadAgentById(db, input.tenantId, router.fallbackAgentId);
      if (config === null) {
        // regra 7: fallback também sem versão publicada — fim legítimo da
        // linha, mas o outcome que já explicava a causa (classifier_failed)
        // não vira 'no_match' por engano; só rebaixa quando o motivo era
        // genuinamente "sem match", pra não mentir sobre o que aconteceu.
        deps.log.warn('resolve-turn-agent: fallbackAgentId sem versão publicada — turno cai no genérico', {
          routerId: router.id,
          fallbackAgentId: router.fallbackAgentId,
        });
      }
      return {
        config,
        routerId: router.id,
        intentName: null,
        confidence,
        outcome: outcome === 'classifier_failed' ? 'classifier_failed' : config === null ? 'no_match' : 'fallback',
        ...doRoteador,
      };
    };

    // carrega o agente casado (sticky/classificado/reclassificado); se ele não
    // tiver versão publicada, NUNCA devolve outcome de sucesso com config:null
    // (mentiria pra telemetria — review T4 finding 4) — cai no fallback do
    // router com log.warn, honesto sobre a causa real.
    const loadMatchedOrFallback = async (
      outcome: 'sticky' | 'classified' | 'reclassified',
      agentId: string,
      intentName: string | null,
      confidence: number | null,
    ): Promise<TurnAgentResolution> => {
      const assunto = assuntoBloqueado(intentName, agentId);
      if (assunto !== null) {
        deps.log.info('qualificacao_bloqueada_apos_equipe', { routerId: router.id, assunto, alvo: outcome });
        // Follow-up (sem mensagem) do assunto bloqueado não muda de agente: cala.
        if (input.signal === null) {
          return { config: null, routerId: router.id, intentName: null, confidence, outcome: 'bloqueado_apos_equipe', ...doRoteador };
        }
        return resolveFallback('no_match', confidence);
      }
      const config = await _loadAgentById(db, input.tenantId, agentId);
      if (config === null) {
        deps.log.warn('resolve-turn-agent: agente casado sem versão publicada — tentando fallback do router', {
          routerId: router.id,
          matchedOutcome: outcome,
          agentId,
        });
        return resolveFallback('no_match', confidence);
      }
      return { config, routerId: router.id, intentName, confidence, outcome, ...doRoteador };
    };

    // sticky elegível: config liga sticky E o agente ainda é membro do router
    // (membro removido ⇒ trata como sem sticky, decisão segura — ver report).
    // Regra 2c. Sem data gravada não há o que medir, e a permanência vale.
    const venceu =
      router.permanencia === 'agente' &&
      input.signal !== null &&
      input.stickySetAt != null &&
      (deps.agora ?? (() => new Date()))().getTime() - new Date(input.stickySetAt).getTime() >
        router.permanenciaExpiraHoras * 3_600_000;
    const stickyMember =
      router.sticky && input.stickyAgentId !== null && !venceu
        ? router.members.find((m) => m.agentId === input.stickyAgentId)
        : undefined;

    // regra 6: sem mensagem inbound (follow-up) — nunca classifica.
    if (input.signal === null) {
      if (stickyMember !== undefined) {
        return loadMatchedOrFallback('sticky', stickyMember.agentId, input.stickyIntent, null);
      }
      return resolveFallback('no_match', null);
    }

    const comContexto = router.permanencia === 'agente';
    // O assunto de quem está atendendo. Conversa com agente e sem assunto
    // gravado: vale o assunto do próprio membro, senão o classificador repetir
    // esse assunto contaria como troca.
    const assuntoAtual = stickyMember !== undefined ? (input.stickyIntent ?? stickyMember.intentName) : null;

    // Regra 2b, atalho: sem assunto que possa interromper, o veredito não muda
    // nada. Nem lê nem classifica.
    if (
      comContexto &&
      stickyMember !== undefined &&
      !router.interrompe.some((i) => i !== assuntoAtual && router.members.some((m) => m.intentName === i))
    ) {
      return loadMatchedOrFallback('sticky', stickyMember.agentId, input.stickyIntent, null);
    }

    // Fatos do CRM para o classificador (agenda do contato). No motor, `leadId` É o
    // contact_id. Falha aqui nunca derruba o turno: classifica só com a mensagem.
    //
    // Regra 2b: só o roteador com `permanencia: 'agente'` lê também a conversa
    // recente. As duas leituras correm juntas e cada uma falha sozinha.
    const avisoDosFatos = 'resolve-turn-agent: fatos do contato indisponíveis — classificando só com a mensagem';
    const avisoDoHistorico = 'resolve-turn-agent: conversa recente indisponível, classificando sem ela';
    // `Promise.race`, como no degrau 0: o teto vale também com o pool esgotado.
    // UM relógio, e cada leitura corre contra ele sozinha: a rápida não é
    // descartada porque a outra travou, e cada aviso diz qual ficou de fora.
    const ESTOUROU = Symbol('teto');
    const teto = new Promise<typeof ESTOUROU>((resolve) => setTimeout(() => resolve(ESTOUROU), TETO_DOS_FATOS_MS));
    // `async () =>`: um throw síncrono vira rejeição da própria leitura.
    const ler = async (aviso: string, leitura: () => Promise<string | null>): Promise<string | null> => {
      try {
        const lido = await Promise.race([(async () => leitura())(), teto]);
        if (lido !== ESTOUROU) return lido;
        deps.log.warn(aviso, { routerId: router.id, error: 'timeout' });
      } catch (err) {
        deps.log.warn(aviso, { routerId: router.id, error: err instanceof Error ? err.message : String(err) });
      }
      return null;
    };
    const [fatos, historico] = await Promise.all([
      ler(avisoDosFatos, () => _buildFatos(db, input.tenantId, input.leadId, (deps.agora ?? (() => new Date()))())),
      comContexto
        ? ler(avisoDoHistorico, async () =>
            renderHistoricoRecente(await _historicoRecente(db, input.tenantId, input.conversationId)) || null)
        : null,
    ]);

    // Regra 9, sem modelo: a mensagem que ABRE a conversa se declara robô ou
    // é menu de robô (instrução de escolha + duas opções numeradas). Só a
    // instrução é gente citando menu, e cala paciente.
    // No modo 'observar' a decisão só vai ao log, e o turno segue como sempre.
    const soEquipe = (intentName: string, confidence: number, motivo: string): TurnAgentResolution | null => {
      if (router.soEquipe === 'observar') {
        deps.log.info('turno_so_da_equipe_observado', { routerId: router.id, intentName, confidence, motivo });
        return null;
      }
      deps.log.info('turno_so_da_equipe', { routerId: router.id, intentName, confidence, motivo });
      return { config: null, routerId: router.id, intentName, confidence, outcome: 'so_equipe', ...doRoteador };
    };
    if ((router.soEquipe === true || router.soEquipe === 'observar') && input.semSaida === true && semNadaNaAgenda(fatos)) {
      const motivo = ehMensagemDeRobo(input.signal)
        ? 'autodeclaracao_de_robo'
        : ehMenuDeRoboComOpcoes(input.signal)
          ? 'menu_de_robo'
          : null;
      const r = motivo === null ? null : soEquipe('mensagem_automatica', 1, motivo);
      if (r !== null) return r;
    }

    // classifica — inclusive com sticky ativo, pra detectar troca de assunto (regra 2).
    const veredito = await _classifyIntent(
      db,
      llmCfg,
      {
        tenantId: input.tenantId, leadId: input.leadId, jobId: input.jobId, router, signal: input.signal, fatos,
        // Fora do modo novo as chaves nem existem: a entrada é a de antes.
        ...(comContexto ? { historico, assuntoAtual } : {}),
      },
      { log: deps.log },
    );
    // Regra 9: negócio ou mensagem automática, com confiança alta e contato sem
    // agenda. Antes da permanência: vale também com agente atual.
    if (ehTurnoSoDaEquipe(router, veredito, fatos)) {
      const r = soEquipe(veredito!.intentName!, veredito!.confidence, 'classificador');
      if (r !== null) return r;
    }
    // Intenção fixa do produto (`config.so_equipe`) não tem agente: aqui ela
    // vale como "nenhuma". Sem isto o `member!` abaixo quebraria.
    const verdict: IntentVerdict | null =
      veredito !== null && ehAssuntoFixoSoDaEquipe(veredito.intentName)
        ? { intentName: null, confidence: veredito.confidence }
        : veredito;

    // regra 4: classificador falhou — um `null` é informação mais pobre que
    // "sem sinal", nunca deve derrubar a stickiness (review T4 finding 1).
    if (verdict === null) {
      if (stickyMember !== undefined) {
        return loadMatchedOrFallback('sticky', stickyMember.agentId, input.stickyIntent, null);
      }
      return resolveFallback('classifier_failed', null);
    }

    if (stickyMember !== undefined) {
      // No modo de sempre o assunto é o gravado na conversa, nulo inclusive: é a
      // comparação de antes, intocada.
      if (!mudouDeAssunto(router, comContexto ? assuntoAtual : input.stickyIntent, verdict)) {
        return loadMatchedOrFallback('sticky', stickyMember.agentId, input.stickyIntent, verdict.confidence);
      }
      const newMember = router.members.find((m) => m.intentName === verdict.intentName);
      // newMember sempre definido: classifyIntent só devolve intentName que bateu em router.members.
      return loadMatchedOrFallback('reclassified', newMember!.agentId, verdict.intentName, verdict.confidence);
    }

    // sem sticky (regra 3).
    if (verdict.intentName !== null && verdict.confidence >= router.minConfidence) {
      const member = router.members.find((m) => m.intentName === verdict.intentName);
      return loadMatchedOrFallback('classified', member!.agentId, verdict.intentName, verdict.confidence);
    }

    return resolveFallback('no_match', verdict.confidence);
  } catch (err) {
    deps.log.warn('resolve-turn-agent: erro inesperado no router — turno cai no fluxo sem router', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      config: await _loadAgentBySession(db, input.tenantId, input.channelSessionId),
      routerId: null,
      intentName: null,
      confidence: null,
      outcome: 'classifier_failed',
    };
  }
}

const ISO_COMPLETO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `metadata.ia_devolvida_manualmente_em` como instante, ou `null` (sem marco)
 * quando ausente ou torto: ISO completo E data que existe ("2026-13-40…" não).
 * Exportada para o teste.
 */
export function marcoDaDevolucaoManual(v: unknown): Date | null {
  if (typeof v !== 'string' || !ISO_COMPLETO.test(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Teto da rajada lida como sinal: o drain coalesce poucas mensagens por job. */
const MAXIMO_DE_INBOUNDS_NO_SINAL = 5;

/** One read-only selection before operation policy. A real queue job supplies correlation. */
export async function resolveConversationTurn(
  db: pg.Pool,
  llmCfg: LlmEdgeConfig,
  input: {
    tenantId: string;
    leadId: string;
    jobId: string;
    conversationId: string;
    channelSessionId: string;
    inbound: boolean;
  },
  deps: ResolveTurnAgentDeps,
): Promise<TurnAgentResolution> {
  // A última fala da equipe: a mesma régua de "envio de pessoa" de
  // `robo-do-outro-lado.ts` (tela, API de usuário, celular), sem o eco do envio
  // da IA (`SQL_FALA_DA_EQUIPE`). Pelo horário de ENVIO (`sent_at`; o celular
  // grava o do aparelho). O marco da última devolução MANUAL
  // (`metadata.ia_devolvida_manualmente_em`, gravado por `lib/escalacao/retomada.ts`;
  // a automática não grava, então não libera) é lido e validado AQUI, em JS:
  // marca torta não derruba o turno, vira "sem marco".
  const { rows } = await db.query<{
    active_ai_agent_id: string | null;
    active_intent: string | null;
    active_agent_set_at: Date | null;
    marco_da_devolucao: string | null;
    ultima_fala_da_equipe: Date | null;
    sem_saida: boolean | null;
  }>(
    `select c.active_ai_agent_id,c.active_intent,c.active_agent_set_at,
            c.metadata->>'${CHAVE_DA_DEVOLUCAO_MANUAL}' as marco_da_devolucao,
            (select max(coalesce(m.sent_at, m.created_at)) from messages m
              where m.organization_id=$1 and m.conversation_id=$2 and ${SQL_FALA_DA_EQUIPE}) as ultima_fala_da_equipe,
            not exists(select 1 from messages m where m.organization_id=$1 and m.conversation_id=$2
                     and m.direction='outbound') as sem_saida
       from conversations c where c.organization_id=$1 and c.id=$2`,
    [input.tenantId, input.conversationId],
  );
  const marco = marcoDaDevolucaoManual(rows[0]?.marco_da_devolucao);
  const fala = rows[0]?.ultima_fala_da_equipe ?? null;
  // As inbounds do TURNO: a mais nova e, antes dela, as que ainda não tiveram
  // resposta (nenhuma outbound depois delas), da mais nova para a mais antiga.
  // Ler só a mais nova perdia a rajada que o drain coalesce num job: áudio +
  // emoji 3 s depois, e o classificador via só o emoji (medido em 06/11: outcome
  // 'fallback' com 0,99, enquanto o agente escolhido respondia ao áudio).
  const signalRows = input.inbound
    ? (await db.query<CorpoDaMensagemRow & { respondida: boolean | null }>(
        `select body,type,media_url,media_storage_path,media_derived_text,
                exists(select 1 from messages o where o.organization_id=$1 and o.conversation_id=$2
                         and o.direction='outbound'
                         and coalesce(o.sent_at,o.created_at) > coalesce(m.sent_at,m.created_at)) as respondida
           from messages m where m.organization_id=$1 and m.conversation_id=$2 and m.direction='inbound'
          order by m.sent_at desc,m.created_at desc,m.id desc limit ${MAXIMO_DE_INBOUNDS_NO_SINAL}`,
        [input.tenantId, input.conversationId],
      )).rows
    : [];
  const corte = signalRows.findIndex((r, i) => i > 0 && r.respondida === true);
  const doTurno = corte === -1 ? signalRows : signalRows.slice(0, corte);
  // signal = o texto EFETIVO do turno, composto pelo mesmo caminho do agente
  // (#617): o que o cliente digitou OU a transcrição do áudio já pronta, uma
  // mensagem por linha, da mais antiga para a mais nova. Lido cru, um áudio
  // (body NULL) virava `null` → regra 6, e a conversa ficava presa no agente
  // sticky sem o classificador rodar. Áudio AINDA sem transcrição fica de fora
  // (a espera do handler, `espera-da-midia.ts`, já roda antes deste ponto); sem
  // nada com texto, o sinal segue `null` (mantém o agente atual).
  const falas = doTurno
    .filter((r) => (r.body ?? '').trim() !== '' || (r.media_derived_text ?? '').trim() !== '')
    .reverse()
    .map((r) => corpoDaMensagem(r));
  const signal = falas.length > 0 ? falas.join('\n') : null;
  const resolucao = await resolveTurnAgent(db, llmCfg, {
    ...input,
    signal,
    stickyAgentId: rows[0]?.active_ai_agent_id ?? null,
    stickyIntent: rows[0]?.active_intent ?? null,
    stickySetAt: rows[0]?.active_agent_set_at ?? null,
    falaDaEquipeEm: fala !== null && (marco === null || fala.getTime() > marco.getTime()) ? fala : null,
    semSaida: rows[0]?.sem_saida === true,
  }, deps);
  if (resolucao.config !== null) return resolucao;
  return (await numeroFechadoPelaDeclaracao(db, input.tenantId, input.channelSessionId))
    ? { config: null, routerId: null, intentName: null, confidence: null, outcome: 'numero_recusado' }
    : resolucao;
}

/**
 * `config: null` vira o agente GENÉRICO no turno (régua 5). Isso não pode
 * reabrir um número que a declaração fechou (migration 0380): se todo agente
 * ligado a este número — versão publicada nele, membro ou fallback do roteador
 * dele — declarou OUTROS números, e nenhum ligado o aceita, a resposta é
 * silêncio. Basta UM ligado que aceite o número para a régua 5 seguir como
 * sempre. O desenho de "ligado" é o do portão de custo (`drain.ts`).
 *
 * Só roda quando nada resolveu, então o caminho comum não paga a consulta.
 * Falha de leitura conta como "não fechado": é o comportamento de antes.
 */
async function numeroFechadoPelaDeclaracao(
  db: pg.Pool,
  organizationId: string,
  channelSessionId: string,
): Promise<boolean> {
  try {
    const { rows } = await db.query<{ fechado: boolean | null }>(
      `with ligados as (
         select public.fn_agente_atende_no_numero(a.organization_id, a.id, $2) as atende
           from ai_agents a
           join ai_agent_versions v on v.id = a.published_version_id and v.status = 'published'
          where a.organization_id = $1 and a.archived_at is null
            and (v.channel_session_id = $2
                 or exists (select 1 from ai_routers r
                             where r.organization_id = $1 and r.channel_session_id = $2 and r.is_active
                               and (r.fallback_agent_id = a.id
                                    or exists (select 1 from ai_router_members m
                                                where m.organization_id = $1 and m.router_id = r.id
                                                  and m.agent_id = a.id))))
       )
       select bool_or(not atende) and not bool_or(atende) as fechado from ligados`,
      [organizationId, channelSessionId],
    );
    return rows?.[0]?.fechado === true;
  } catch {
    return false;
  }
}
