/**
 * Camada SEMÂNTICA de promessa em texto livre (F4-02; blueprint 6.5) — classificador
 * binário BARATO que roda DEPOIS da camada determinística (F4-01) no gate before_send.
 * A regex+schema da F4-01 só pega valor ESTRUTURADO (R$/%/parcelas); promessa em texto
 * livre ("faço de graça", "te dou uma cortesia", "garanto entrega amanhã") escapa dela —
 * esta camada fecha o buraco.
 *
 * O classificador passa pela camada de modelo agnóstica (F2-23 — modelo auxiliar pequeno,
 * budget da org checado ANTES da chamada dentro de runModelCall; NÃO é roteamento do modelo
 * do agente). Binário: a mensagem candidata contém uma promessa/compromisso livre? Devolve
 * {isPromise, suspectPhrase}. suspectPhrase é o trecho da PRÓPRIA candidata (mensagem que o
 * agente quer enviar) — volta ao modelo no veto (erro de ensino), mas NUNCA vai a log.
 *
 * Como Gate.evaluate é SÍNCRONO (before-send.ts), a chamada async roda ANTES da cadeia e
 * entra no GateContext pronta; o `semanticPromiseGate` (sync) lê e veta. Ela roda antes de o
 * runBeforeSend tomar conexão, FORA do advisory lock do número: não lê nada do que o lock
 * protege, e dentro da transação ela fechava um ciclo de travas com DDL (o `runModelCall`
 * grava `llm_calls`, que tem FK para `contacts`, por outra conexão; #2363 no original).
 * Este módulo não persiste nada.
 *
 * organization_id/contact_id vêm da ROW do job (closure do run), nunca do payload (regra dura 1).
 */
import type pg from 'pg';

import type { Logger } from '../../obs/logger';
import type { ProviderRegistry } from '../../edge/llm/providers';
import { runModelCall, type LlmEdgeConfig } from '../../edge/llm/run-model-call';
import type { LlmResolveOverride } from '../../edge/llm/credentials';
import { extrairObjetoJsonDoTexto } from '@/lib/agent-engine/texto/extrair-json-do-texto';
import { detectHumanPromise } from '../human-promise';

/** Veredito binário do classificador. suspectPhrase = null quando isPromise = false. */
export interface PromiseClassification {
  isPromise: boolean;
  /** trecho literal da candidata que caracteriza a promessa (só quando isPromise=true). */
  suspectPhrase: string | null;
  /**
   * A mensagem promete que ALGUÉM DA EMPRESA volta a falar com o cliente?
   *
   * PERGUNTA DIFERENTE de `isPromise` (promessa COMERCIAL: preço, prazo, cortesia).
   * Este campo é o COMPROMISSO DE RETORNAR: "te retorno", "vou encaminhar para
   * análise", "vou passar para o setor X", COM OU SEM nomear a pessoa ou o setor.
   *
   * Existe porque o detector léxico (`detectHumanPromise`) exige palavra de alvo
   * humano colada ao verbo, e um objeto no meio ("as informações") quebra o padrão:
   * no original, 5 de 7 frases medidas vazaram por ali. O `casePromiseGate` lê os
   * dois sinais em OU.
   */
  prometeuRetornoHumano: boolean;
  /**
   * Quem volta é SÓ o próprio assistente ("te retorno amanhã de manhã"), sem pessoa,
   * setor, equipe ou análise interna? É o que deixa o `casePromiseGate` aceitar um
   * `schedule_followup` agendado no turno como destino da promessa no lugar de um caso.
   *
   * Degrade FECHADO: falha de parse, campo ausente ou tipo trocado viram `false`.
   */
  retornoSoDoAssistente: boolean;
}

/**
 * Instrução FIXA do classificador — marcador estável (como STAGE_CLASSIFIER_INSTRUCTION)
 * para os testes reconhecerem a chamada do auxiliar. Descreve a tarefa binária, dá exemplos
 * de promessa vs. inocente (incl. as armadilhas de slogan) e força saída JSON.
 */
export const PROMISE_SEMANTIC_INSTRUCTION =
  'Você é um classificador auxiliar de compliance de vendas (NÃO responde ao lead). ' +
  'Analise a MENSAGEM que o vendedor quer enviar e responda a DUAS perguntas INDEPENDENTES.\n' +
  '\n' +
  '## Pergunta 1 — isPromise (promessa COMERCIAL concreta)\n' +
  'Decida se a mensagem contém uma PROMESSA ou ' +
  'COMPROMISSO concreto em texto livre — algo que obriga a empresa a algo específico e que ' +
  'um validador de valores estruturados (preço/desconto/parcelas em número) NÃO pegaria.\n' +
  'É PROMESSA (isPromise=true): oferecer algo de graça/cortesia/por conta da casa, isentar ' +
  'taxa, dar brinde, garantir devolução de dinheiro, garantir um prazo de entrega concreto ' +
  '("entrego amanhã", "fica pronto até sexta") ou assumir que resolve pessoalmente até um prazo.\n' +
  'NÃO é promessa (isPromise=false): perguntas, saudações, agradecimentos, descrições de ' +
  'horário/empresa, próximos passos vagos SEM compromisso concreto e slogans genéricos de ' +
  'marketing ("garantimos qualidade", "nossa entrega é rápida", "10x mais rápido que a concorrência").\n' +
  '\n' +
  '## Pergunta 2 — prometeuRetornoHumano (promessa de retorno humano)\n' +
  'Decida se a mensagem promete que ALGUÉM DA EMPRESA volta a falar com o cliente, ou que ' +
  'algo será feito internamente e devolvido a ele.\n' +
  'É promessa de retorno (prometeuRetornoHumano=true): "te retorno", "te dou um retorno", ' +
  '"vou encaminhar para análise", "vou levar para avaliação interna", "vou passar para o ' +
  'setor X", "te mando a proposta" — COM OU SEM nomear a pessoa ou o setor. O que importa ' +
  'é o COMPROMISSO DE VOLTAR, não a palavra usada.\n' +
  'NÃO é promessa de retorno (prometeuRetornoHumano=false): perguntas, saudações, horário ' +
  'de funcionamento, oferta de horários já disponíveis, e qualquer coisa que o próprio ' +
  'assistente resolve AGORA na própria conversa.\n' +
  '⚠️ A ressalva da pergunta 1 — "próximos passos vagos SEM compromisso concreto NÃO é ' +
  'promessa" — NÃO vale para esta pergunta. É exatamente por essa ressalva que a frase ' +
  '"vou encaminhar para análise e te retorno com a proposta" escapou da trava: ela É um ' +
  'compromisso de retorno, ainda que vaga sobre o CONTEÚDO do que volta.\n' +
  'Na mesma pergunta, decida também retornoSoDoAssistente: true SOMENTE quando quem volta ' +
  'a falar é o próprio assistente, sem nenhuma pessoa, setor, equipe ou análise interna no ' +
  'caminho ("combinado, te retorno amanhã de manhã"). Se a mensagem diz que alguém da ' +
  'empresa vai agir ("vou encaminhar para a equipe", "para análise", "o responsável vai ' +
  'ver"), retornoSoDoAssistente=false. Também é false quando prometeuRetornoHumano=false.\n' +
  '\n' +
  'Responda SOMENTE com JSON, sem explicação: ' +
  '{"isPromise": true|false, "suspectPhrase": "<trecho literal da promessa na mensagem>"|null, ' +
  '"prometeuRetornoHumano": true|false, "retornoSoDoAssistente": true|false}. ' +
  'suspectPhrase é null quando isPromise=false.';

function buildPromiseMessage(candidate: string): string {
  return ['## Mensagem candidata (que o vendedor quer enviar ao lead)', candidate, '', PROMISE_SEMANTIC_INSTRUCTION].join(
    '\n',
  );
}

/**
 * Extrai {isPromise, suspectPhrase, prometeuRetornoHumano, retornoSoDoAssistente} do texto
 * do modelo (tolerante a code-fence/prosa em volta do JSON). Saída não-parseável → `isPromise`
 * degrada para "sem promessa" (a camada determinística F4-01 já rodou) e
 * `prometeuRetornoHumano` degrada ao veredito do léxico.
 */
export function parsePromiseClassification(
  text: string,
  candidata: string,
  log?: Logger,
): PromiseClassification {
  // ⛔ DEGRADE ASSIMÉTRICO DE PROPÓSITO.
  //
  // `isPromise` degrada para `false`: a camada determinística (F4-01) já rodou;
  // fail-open ali é uma rede a menos, não uma invariante ferida.
  //
  // `prometeuRetornoHumano` NÃO pode degradar para `false`: não há camada anterior
  // equivalente para ELE, e degradar para `false` desarmaria a trava exatamente
  // quando o classificador está com defeito. Degrada para o veredito do LÉXICO.
  const fallbackLexico = detectHumanPromise(candidata);
  // Primeiro OBJETO parseável (prosa, cerca de código, JSON REPETIDO ou dentro de
  // array: o recorte antigo abria no primeiro `{` e fechava no último `}`,
  // abrangendo as DUAS cópias). A falha não muda: sem objeto, o mesmo fail-open
  // para "sem promessa" com o MESMO warn, e o `reason` pelo critério de antes
  // (havia `{`…`}` = JSON candidato que não parseou → invalid_json; sem → no_json).
  const obj = extrairObjetoJsonDoTexto(text);
  if (obj === null) {
    const haviaJsonCandidato = /\{[\s\S]*\}/.test(text);
    // degrade OBSERVÁVEL (F4-08 ressalva 2): sem o warn, um classificador sistematicamente
    // quebrado ficaria invisível (todo envio "sem promessa"). Loga só o FATO do parse-fail —
    // nunca o texto do modelo (poderia carregar trecho da candidata, PII fora de log).
    log?.warn(
      haviaJsonCandidato
        ? 'classificador semântico de promessa: JSON inválido — fail-open p/ "sem promessa"; retorno humano degrada ao léxico'
        : 'classificador semântico de promessa: saída sem JSON — fail-open p/ "sem promessa"; retorno humano degrada ao léxico',
      {
        event: 'promise_semantic_parse_fail',
        reason: haviaJsonCandidato ? 'invalid_json' : 'no_json',
      },
    );
    return {
      isPromise: false,
      suspectPhrase: null,
      prometeuRetornoHumano: fallbackLexico,
      retornoSoDoAssistente: false,
    };
  }
  const isPromise = obj.isPromise === true || obj.isPromise === 'true';
  const rawPhrase = typeof obj.suspectPhrase === 'string' ? obj.suspectPhrase.trim() : '';
  // Campo ausente ou com tipo trocado cai no MESMO degrade do léxico: um sinal de
  // segurança `undefined` o gate leria como ausência e a trava ficaria desarmada.
  const prometeuRetornoHumano =
    typeof obj.prometeuRetornoHumano === 'boolean' ? obj.prometeuRetornoHumano : fallbackLexico;
  // Degrade FECHADO: só `true` literal libera o follow-up como destino.
  const retornoSoDoAssistente = obj.retornoSoDoAssistente === true;
  return {
    isPromise,
    suspectPhrase: isPromise && rawPhrase !== '' ? rawPhrase : null,
    prometeuRetornoHumano,
    retornoSoDoAssistente,
  };
}

/**
 * Roda o classificador semântico pelo seam agnóstico (purpose 'promise_semantic'; budget da
 * org checado ANTES da chamada dentro de runModelCall). Injetável (registry) para testes
 * determinísticos com MockLanguageModelV4. Devolve o veredito binário + a frase suspeita.
 */
export async function classifyPromise(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  ids: { tenantId: string; leadId?: string | null; jobId?: string },
  args: { candidate: string; model?: string; llmOverride?: LlmResolveOverride },
  deps: { registry?: ProviderRegistry; log: Logger },
): Promise<PromiseClassification> {
  const call = await runModelCall(
    db,
    cfg,
    {
      tenantId: ids.tenantId,
      ...(ids.leadId != null ? { leadId: ids.leadId } : {}),
      ...(ids.jobId !== undefined ? { jobId: ids.jobId } : {}),
      purpose: 'promise_semantic',
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.llmOverride !== undefined ? { llmOverride: args.llmOverride } : {}),
      messages: [{ role: 'user', content: buildPromiseMessage(args.candidate) }],
    },
    { registry: deps.registry, log: deps.log },
  );
  // A CANDIDATA vai junto para o degrade de `prometeuRetornoHumano` pelo léxico.
  return parsePromiseClassification(call.result.text, args.candidate, deps.log);
}

/**
 * Erro de ENSINO que volta AO MODELO no veto semântico (acceptance 3): destaca a frase
 * suspeita e orienta a reformular. É o único lugar onde a frase (trecho da própria candidata)
 * aparece — vai ao modelo, jamais a log.
 */
export function renderSemanticPromiseVeto(suspectPhrase: string | null): string {
  const highlight = suspectPhrase !== null ? `frase suspeita: "${suspectPhrase}" — ` : '';
  return (
    `${highlight}isso é uma promessa/compromisso fora do playbook que a validação de valores ` +
    'estruturados não pega; reformule sem prometer prazo, cortesia, gratuidade, brinde ou garantia ' +
    'não autorizada antes de reenviar.'
  );
}

/**
 * Uma classificação por CORPO EXATO enquanto a função memoizada viver (o turno
 * cria uma por turno). Os fail-safes de vocabulário e de promessa re-rodam a
 * cadeia `before_send` com o mesmo texto, e cada passagem pagava uma chamada de
 * modelo nova para a mesma frase. Falha sai do memo: a próxima passagem tenta
 * de novo, como antes. (No original a chave também leva as evidências
 * comerciais do turno; o fork não tem essa camada.)
 */
export function memoizarPorCandidata(
  classificar: (candidata: string) => Promise<PromiseClassification>,
): (candidata: string) => Promise<PromiseClassification> {
  const pedidas = new Map<string, Promise<PromiseClassification>>();
  return (candidata) => {
    const jaPedida = pedidas.get(candidata);
    if (jaPedida !== undefined) return jaPedida;
    const pedida = classificar(candidata);
    pedidas.set(candidata, pedida);
    pedida.catch(() => pedidas.delete(candidata));
    return pedida;
  };
}
