/**
 * QUEM GANHA QUANDO CINCO LUGARES OPINAM SOBRE O MESMO PONTO.
 *
 * A escolha de modelo de um ponto pode vir de cinco origens, e antes desta
 * frente elas conviviam sem ordem declarada — o que produzia o pior desfecho
 * possível: o operador mudava a configuração numa tela e o comportamento não
 * mudava, porque outra origem estava vencendo em silêncio.
 *
 * A ordem, do mais forte ao mais fraco:
 *
 *  1. **Agente publicado** — só para os pontos que SÃO o agente conversando
 *     (`agent_turn`, `operator_turn`). A escolha ali já tem tela própria, e
 *     duas telas mandando na mesma coisa é como se cria a configuração que
 *     mente. O painel mostra esses dois como leitura, com link para o agente.
 *  2. **Binding do ponto** — a escolha explícita feita no painel de provedores.
 *     É a superfície nova e é ela que o operador enxerga.
 *  3. **Variável de ambiente** — os sete knobs herdados (`COMPACTION_MODEL`,
 *     `STAGE_CLASSIFIER_MODEL`, …). Continuam valendo para quem já os usa, mas
 *     perdem para uma escolha feita na tela: quem clicou depois quis mais.
 *  4. **Herança de quem chamou** — o ponto AUXILIAR não tem modelo próprio, e
 *     quando o knob está vazio ele empresta o do agente publicado (ou o do
 *     roteador de intenção). Empresta os TRÊS campos juntos; emprestar só a
 *     string do modelo é o defeito do PR #151, e ele voltou por este degrau
 *     estar faltando.
 *  5. **Padrão da organização** — `organizations.settings.llm`, o que sempre
 *     valeu quando ninguém disse nada.
 *
 * Sobre 4 e 5, um degrau só para as classificações curtas
 * (`PONTOS_DE_TIER_ECONOMICO`): sem binding nem knob, o modelo mais barato do
 * MESMO provedor, com a mesma credencial. O que valeria sem ele fica como
 * reserva, para o seam repetir a chamada se o provedor recusar o econômico.
 * Porte do upstream melgarafael/DeskcommCRM#2118.
 *
 * A decisão devolve a ORIGEM junto com o valor. Isso não é enfeite: é o que
 * permite a tela responder "este ponto está usando X **porque**…" e o log
 * registrar a razão da escolha. Um resolvedor que devolvesse só o modelo
 * deixaria o operador na mesma dúvida de antes.
 *
 * Função pura, sem banco — mesmo motivo de `lib/routing/decide.ts` e
 * `lib/agent-engine/agent/aux-model-args.ts` existirem fora do worker: a regra
 * de precedência é a parte que erra, e ela precisa ser exercitável por teste
 * unitário. O I/O fica em quem chama.
 */
import { PROVEDORES } from "./provedores";
import { PONTO_POR_ID, type PontoDeIa } from "./registro";

/** De onde a escolha efetiva veio — vai para a tela e para o log. */
export type OrigemDaEscolha =
  | "fixo_do_produto"
  | "agente_publicado"
  | "binding"
  | "variavel_de_ambiente"
  | "herdado_de_quem_chamou"
  /** Classificador sem escolha explícita: o modelo mais barato do MESMO provedor de quem chamou. */
  | "economico_do_provedor"
  /**
   * Linha de ERRO do modelo econômico que a reserva cobriu: a chamada se
   * repetiu no modelo de antes. Sem origem própria, Execuções mostraria a
   * consequência de negócio da falha num atendimento que seguiu normal.
   */
  | "economico_coberto_pela_reserva"
  | "padrao_da_organizacao";

export const EXPLICACAO_DA_ORIGEM: Record<OrigemDaEscolha, string> = {
  agente_publicado: "Definido na versão publicada do agente.",
  binding: "Escolhido por você no painel de provedores.",
  variavel_de_ambiente: "Definido em variável de ambiente na instalação.",
  herdado_de_quem_chamou:
    "Herdado de quem disparou a chamada — o agente publicado, ou o roteador de intenção.",
  economico_do_provedor:
    "Modelo mais econômico do mesmo provedor: esta tarefa é uma classificação curta e não precisa do modelo do agente. Escolha outro no painel se preferir.",
  // Esta linha é gravada ANTES de a reserva rodar: o desfecho dela ainda não
  // existe, e "nada se perdeu" seria falso quando a reserva também cai.
  economico_coberto_pela_reserva:
    "O modelo econômico não respondeu; a chamada foi repetida no modelo de antes, e o resultado dessa repetição aparece numa linha própria.",
  padrao_da_organizacao: "Usando o padrão da organização.",
  fixo_do_produto: "O produto resolve este ponto sozinho — não há modelo a escolher.",
};

/** Uma linha de `ai_purpose_bindings`, já filtrada por organização. */
export interface LinhaDeBinding {
  purpose: string;
  provider: string;
  credential_id: string | null;
  model_id: string;
  base_url: string | null;
  is_enabled: boolean;
}

/** O que o agente publicado impõe aos pontos que são o próprio agente. */
export interface AgentePublicado {
  provider: string;
  credentialId: string | null;
  model: string | undefined;
}

/** O padrão da organização (`organizations.settings.llm`). */
export interface PadraoDaOrganizacao {
  provider: string;
  defaultModel: string | null;
}

export interface EntradaDaDecisao {
  pontoId: string;
  binding: LinhaDeBinding | null;
  agentePublicado: AgentePublicado | null;
  /** O knob de ambiente daquele ponto, quando existe. */
  modeloDeAmbiente: string | undefined;
  padraoDaOrganizacao: PadraoDaOrganizacao;
  /**
   * O modelo econômico do provedor, para os pontos de
   * `PONTOS_DE_TIER_ECONOMICO`. Quem chama consulta o catálogo (I/O) e
   * responde com `escolherModeloEconomico`; o resolvedor só decide QUANDO ele
   * vale. Ausente = a regra de antes, intacta.
   */
  economicoDoProvedor?: (provider: string, modeloAtual: string | null) => string | null;
}

export interface DecisaoDeBinding {
  provider: string;
  modelId: string | null;
  credentialId: string | null;
  baseUrl: string | null;
  origem: OrigemDaEscolha;
  /**
   * Incoerências que NÃO impedem a chamada, mas que alguém precisa ver. A
   * validação dura acontece na escrita (a API recusa binding incompatível); na
   * leitura, avisar é melhor que falhar — falhar fechado na ação, aberto na
   * informação. Sem isto, um ponto configurado errado antes de a validação
   * existir voltaria a ser uma falha muda.
   */
  avisos: string[];
  /**
   * O que valeria SEM a economia, só quando `origem` é
   * `economico_do_provedor`. O seam tenta este modelo se o econômico falhar:
   * um catálogo com um modelo que a chave não alcança degradaria o
   * classificador em silêncio (ele falha aberto), e a reserva devolve
   * exatamente o comportamento de antes.
   */
  reserva?: { modelId: string; origem: OrigemDaEscolha };
}

/**
 * Os pontos cuja escolha pertence à versão publicada do agente, não ao painel.
 *
 * São os dois em que o modelo É a personalidade do agente: mudá-lo por fora
 * mudaria como o agente fala com o cliente sem passar pelo fluxo de publicação
 * (que é onde mora a revisão e o histórico de versão).
 */
export const PONTOS_DO_AGENTE_PUBLICADO: ReadonlySet<string> = new Set([
  "agent_turn",
  "agent_preview",
  "operator_turn",
  // A revisão de supervisão (migration 0263) usa o modelo da versão PUBLICADA
  // do agente supervisor: trocar por fora mudaria quem revisa sem passar pela
  // publicação, que é onde a política dele é versionada.
  "supervisor_review",
]);

/**
 * Modelo e credencial vêm sempre do MESMO lugar.
 *
 * Esta é a regra que o PR #151 pagou caro para aprender (ver
 * `lib/agent-engine/agent/aux-model-args.ts`): emprestar só a string do modelo
 * e deixar provider/credencial no padrão da org mandava `gpt-5-mini` para o
 * endpoint da Anthropic e matava o turno inteiro. Cada ramo abaixo devolve os
 * três campos juntos, ou nenhum.
 */
/**
 * Os pontos que HERDAM do agente publicado sem serem o agente.
 *
 * Eles não têm modelo próprio: quando o knob de ambiente está vazio,
 * `auxModelArgs` empresta o do agente — e, desde o PR #151, empresta provider e
 * credencial JUNTO. Em runtime quem sinaliza a herança é a presença do
 * override; a TELA não tem esse sinal e precisa desta lista, senão ela passaria
 * a anunciar herança em ponto que não herda — a mesma mentira de antes, virada
 * do avesso.
 *
 * Fonte: os quatro `argsAux(...)` de `inbound-turn.ts` mais o `checkpoint`, que
 * passa o mesmo par direto. Ponto que entrar ou sair daquele conjunto entra ou
 * sai daqui no mesmo commit.
 */
export const PONTOS_QUE_HERDAM_DO_AGENTE: ReadonlySet<string> = new Set([
  "stage_classifier",
  "jailbreak_detect",
  "promise_semantic",
  "compaction",
  "flush",
  "checkpoint",
  "draft_suggestion",
  "automation_ai_message",
]);

/**
 * Os pontos que são uma CLASSIFICAÇÃO curta e, sem escolha explícita, usam o
 * modelo mais barato do mesmo provedor em vez do modelo do agente.
 *
 * Por que existe: sem knob nem binding, estes pontos herdavam o modelo do
 * agente, um modelo de conversa para devolver um rótulo, em TODO turno. O
 * comentário "modelo BARATO" em `lib/agent-engine/env.ts` descrevia uma
 * intenção que só valia para quem preenchia a variável à mão.
 *
 * Só entram pontos cuja saída ruim DEGRADA sem repetir nada: o estágio vira
 * "sem sugestão" e a manipulação vira "sem veredito" naquele turno. A reserva
 * do seam cobre recusa do PROVEDOR, não resposta fora do formato.
 *
 * Fora daqui de propósito (mesma decisão do upstream #2118):
 *  - `promise_semantic`: guardrail de compliance sem `catch` no envio; trocar o
 *    modelo dele exige golden set e reserva testados antes.
 *  - `checkpoint`, `compaction`, `flush`: são a memória do lead; um modelo
 *    fraco degrada a continuidade sem erro nenhum.
 *  - `intent_router`: decide QUAL agente atende; erro ali é cliente com o
 *    agente errado, e a tela do roteador já oferece a escolha.
 *  - `sentiment_classify`: já nasce no modelo econômico (`DEFAULT_CLASSIFIER_MODEL`).
 * Qualquer um deles pode ser fixado num modelo barato pelo painel (IA › Provedores).
 */
export const PONTOS_DE_TIER_ECONOMICO: ReadonlySet<string> = new Set([
  "stage_classifier",
  "jailbreak_detect",
]);

/**
 * Provedores cujo catálogo é CURADO pelo produto (semeado por migration), os
 * únicos em que a escolha automática é segura. Num catálogo sincronizado do
 * mercado (OpenRouter) "o mais barato" seria um modelo de outro fabricante
 * qualquer.
 */
const PROVEDORES_COM_CATALOGO_CURADO: ReadonlySet<string> = new Set(
  PROVEDORES.filter((p) => !p.catalogoSincronizavel).map((p) => p.id),
);

/** Uma linha do catálogo `ai_models`, só com o que a escolha econômica consulta. */
export interface ModeloDoCatalogoEconomico {
  provider: string;
  model_id: string;
  input_price_per_million_cents: number | null;
  output_price_per_million_cents: number | null;
  supports_tools: boolean;
  supports_embedding: boolean;
}

/**
 * O modelo mais barato do provedor que ainda é um modelo de CONVERSA, e só se
 * ele for estritamente mais barato que o atual. `null` = fique com o atual.
 *
 * - Modelo de embedding sai (`supports_embedding`): o catálogo da OpenAI tem
 *   `text-embedding-3-small` a 2 centavos/M, e mandá-lo para um classificador
 *   seria um 400 que o fail-open engoliria.
 * - Sem `supports_tools` sai: no catálogo curado, é o marcador de modelo que
 *   não é de chat (transcrição, imagem).
 * - Preço do modelo atual desconhecido ⇒ `null`: sem régua não há como afirmar
 *   que a troca economiza, e o agente pode já estar num modelo barato fora do catálogo.
 * - `habilitados` não vazio restringe a escolha: a organização que limitou os
 *   modelos tomaria `LlmModelNotEnabledError` em todo turno.
 * - Desempate determinístico: menor saída, depois o id em ordem DECRESCENTE.
 *   Entre `gemini-2.0-flash` e `gemini-2.5-flash-lite` (mesmo preço), a versão
 *   mais nova.
 * - `temPrecoNoMotor`: o catálogo ter preço não basta, porque quem COBRA é a
 *   tabela do motor (`precoDoModelo`). Se o atual é cobrado e o candidato não,
 *   a troca faz o custo sair null e a chamada some do teto. Vem de quem chama
 *   para este módulo seguir puro; ausente = sem essa restrição (upstream #2507).
 */
export function escolherModeloEconomico(
  catalogo: readonly ModeloDoCatalogoEconomico[],
  provider: string,
  modeloAtual: string | null,
  habilitados: readonly string[] = [],
  temPrecoNoMotor?: (modelId: string) => boolean,
): string | null {
  if (!PROVEDORES_COM_CATALOGO_CURADO.has(provider) || modeloAtual === null) return null;
  const doProvedor = catalogo.filter(
    (m) =>
      m.provider === provider &&
      m.supports_tools &&
      !m.supports_embedding &&
      m.input_price_per_million_cents !== null &&
      m.output_price_per_million_cents !== null,
  );
  const atual = doProvedor.find((m) => m.model_id === modeloAtual);
  if (atual === undefined) return null;
  const exigePrecoNoMotor = temPrecoNoMotor !== undefined && temPrecoNoMotor(modeloAtual);
  const candidatos = doProvedor
    .filter((m) => habilitados.length === 0 || habilitados.includes(m.model_id))
    .filter((m) => !exigePrecoNoMotor || temPrecoNoMotor(m.model_id))
    .sort(
      (a, b) =>
        a.input_price_per_million_cents! - b.input_price_per_million_cents! ||
        a.output_price_per_million_cents! - b.output_price_per_million_cents! ||
        b.model_id.localeCompare(a.model_id),
    );
  const maisBarato = candidatos[0];
  if (maisBarato === undefined) return null;
  const maisBaratoQueOAtual =
    maisBarato.input_price_per_million_cents! < atual.input_price_per_million_cents! ||
    (maisBarato.input_price_per_million_cents === atual.input_price_per_million_cents &&
      maisBarato.output_price_per_million_cents! < atual.output_price_per_million_cents!);
  return maisBaratoQueOAtual ? maisBarato.model_id : null;
}

/**
 * Troca o modelo pelo econômico do MESMO provedor e da MESMA credencial,
 * guardando a decisão original como reserva. Provider e credencial não mudam
 * nunca: é a regra do PR #151 (modelo e chave vêm do mesmo lugar).
 */
function comEconomia(entrada: EntradaDaDecisao, decisao: DecisaoDeBinding): DecisaoDeBinding {
  if (!PONTOS_DE_TIER_ECONOMICO.has(entrada.pontoId) || entrada.economicoDoProvedor === undefined) {
    return decisao;
  }
  if (decisao.baseUrl !== null || decisao.modelId === null) return decisao;
  const economico = entrada.economicoDoProvedor(decisao.provider, decisao.modelId);
  if (economico === null || economico === decisao.modelId) return decisao;
  return {
    ...decisao,
    modelId: economico,
    origem: "economico_do_provedor",
    reserva: { modelId: decisao.modelId, origem: decisao.origem },
  };
}

export function decidirBinding(entrada: EntradaDaDecisao): DecisaoDeBinding {
  const ponto = PONTO_POR_ID.get(entrada.pontoId);
  const avisos: string[] = [];

  // 0 · Ponto FIXO responde por si, antes de qualquer cadeia.
  //
  // ⚠️ Sem este degrau, um ponto fixo percorria a resolução inteira e caía no
  // padrão da organização — e a tela anunciava `claude-sonnet-5` em "Ouvir o
  // áudio do cliente", ao lado do texto que diz "usa o padrão de transcrição
  // da OpenAI". A mesma tela afirmando duas coisas incompatíveis.
  //
  // Modelo de conversa não transcreve áudio: anunciar um ali manda quem opera
  // caçar um problema que não existe, ou trocar o modelo errado.
  if (ponto?.fixo?.usa) {
    return {
      provider: ponto.fixo.usa.provider,
      modelId: ponto.fixo.usa.modelId,
      credentialId: null,
      baseUrl: null,
      origem: "fixo_do_produto",
      avisos,
    };
  }

  // 1 · O agente publicado manda nos pontos que são o próprio agente.
  if (PONTOS_DO_AGENTE_PUBLICADO.has(entrada.pontoId) && entrada.agentePublicado !== null) {
    if (entrada.binding !== null && entrada.binding.is_enabled) {
      avisos.push(
        "Este ponto usa o modelo definido na versão publicada do agente; a escolha do painel não se aplica.",
      );
    }
    const agente = entrada.agentePublicado;
    // Versão publicada SEM modelo: o padrão da organização vale INTEIRO. O
    // `agente.model ?? padrao.defaultModel` que morava aqui juntava o provider
    // do agente ao modelo da org — o cruzamento do PR #151 escrito à mão, num
    // ramo que existe justamente para impedi-lo.
    if (agente.model === undefined) {
      return {
        provider: entrada.padraoDaOrganizacao.provider,
        modelId: entrada.padraoDaOrganizacao.defaultModel,
        credentialId: null,
        baseUrl: null,
        origem: "padrao_da_organizacao",
        avisos,
      };
    }
    return {
      provider: agente.provider,
      modelId: agente.model,
      credentialId: agente.credentialId,
      baseUrl: null,
      origem: "agente_publicado",
      avisos,
    };
  }

  // 2 · A escolha explícita do painel.
  if (entrada.binding !== null && entrada.binding.is_enabled) {
    if (entrada.modeloDeAmbiente !== undefined) {
      avisos.push(
        `A variável de ambiente deste ponto está definida como "${entrada.modeloDeAmbiente}", mas a escolha do painel tem prioridade.`,
      );
    }
    avisos.push(...avisosDeCapacidade(ponto, entrada.binding.model_id));
    return {
      provider: entrada.binding.provider,
      modelId: entrada.binding.model_id,
      credentialId: entrada.binding.credential_id,
      baseUrl: entrada.binding.base_url,
      origem: "binding",
      avisos,
    };
  }

  // 3 · O knob de ambiente. Herda provider/credencial do padrão da org, que é
  // exatamente o que esse knob sempre pressupôs — ele nasceu quando só havia
  // um provider por instalação.
  if (entrada.modeloDeAmbiente !== undefined) {
    return {
      provider: entrada.padraoDaOrganizacao.provider,
      modelId: entrada.modeloDeAmbiente,
      credentialId: null,
      baseUrl: null,
      origem: "variavel_de_ambiente",
      avisos,
    };
  }

  // 3.5 · A herança de quem disparou a chamada.
  //
  // ⚠️ É O RAMO QUE NÃO PODE FALTAR, e faltava. Sem ele o ponto auxiliar caía
  // no padrão da organização — mas `runModelCall` já havia resolvido a config
  // COM o override, então o `padraoDaOrganizacao` que chega aqui carrega o
  // provider de quem chamou e o modelo da org. Provider de um lugar, modelo de
  // outro: a forma exata do PR #151, medida de novo em produção em 2026-08-25
  // (`stage_classifier`, provider `openai`, model `claude-sonnet-4-5`, 400
  // `modelo_inexistente`, turno morto antes de o cliente receber resposta).
  //
  // Vem DEPOIS do knob de ambiente de propósito: `aux-model-args.ts` só
  // empresta o modelo do agente quando o knob está vazio, e as duas metades da
  // mesma regra não podem discordar sobre a ordem.
  const modeloDeQuemChamou = entrada.agentePublicado?.model;
  if (entrada.agentePublicado !== null && modeloDeQuemChamou !== undefined) {
    const quemChamou = entrada.agentePublicado;
    // 3.6 · Classificador: o econômico do provedor de quem chamou (ver
    // `PONTOS_DE_TIER_ECONOMICO`). Depois do knob e do binding de propósito:
    // escolha explícita sempre vence a automática.
    return comEconomia(entrada, {
      provider: quemChamou.provider,
      modelId: modeloDeQuemChamou,
      credentialId: quemChamou.credentialId,
      baseUrl: null,
      origem: "herdado_de_quem_chamou",
      avisos,
    });
  }

  // 4 · O padrão da organização (com o mesmo degrau 3.6 para classificador).
  return comEconomia(entrada, {
    provider: entrada.padraoDaOrganizacao.provider,
    modelId: entrada.padraoDaOrganizacao.defaultModel,
    credentialId: null,
    baseUrl: null,
    origem: "padrao_da_organizacao",
    avisos,
  });
}

/**
 * Avisos sobre capacidade que a leitura consegue dar sem consultar o catálogo.
 *
 * A checagem completa (o modelo suporta ferramentas? enxerga imagem?) exige o
 * catálogo e acontece na ESCRITA, onde dá para recusar. Aqui cobrimos o caso
 * que não precisa de catálogo nenhum: ponto de embedding com modelo que não é
 * de embedding — um erro de digitação que, sem aviso, degrada a busca sem
 * derrubar nada.
 */
function avisosDeCapacidade(ponto: PontoDeIa | undefined, modelId: string): string[] {
  if (ponto === undefined) return [];
  if (ponto.exige.embeddingDims === undefined) return [];
  if (/embed/i.test(modelId)) return [];
  return [
    `Este ponto precisa de um modelo de embedding, e "${modelId}" não parece ser um. A busca no seu material pode parar de encontrar o conteúdo certo.`,
  ];
}
