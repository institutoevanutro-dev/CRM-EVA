import { trustedAiBaseUrlOrDefault } from "@/lib/ai/trusted-base-url";
/**
 * Registro de providers da camada agnóstica. ÚNICO lugar (junto do resto de
 * edge/llm/) onde SDK de vendor é importado. Instância POR CHAMADA com a chave
 * BYOK da org: sem pool global de chave, sem fallback silencioso.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

import { allowlistedFetch, buildAllowlist } from '../egress';

/**
 * provider name → (chave BYOK da org, id do modelo, endpoint opcional) → modelo
 * pronto para generateText.
 *
 * O terceiro parâmetro é o endpoint escolhido no painel de provedores
 * (`ai_purpose_bindings.base_url`). Existe por causa dos dois casos que o
 * registry precisa atender e que não têm endpoint fixo: um gateway
 * OpenAI-compatível na frente da OpenRouter e, no roteiro do produto, um modelo
 * rodando na máquina do próprio cliente. É opcional — os providers canônicos
 * ignoram e continuam indo ao endpoint intrínseco de terem sido escolhidos.
 */
export type ProviderRegistry = Record<
  string,
  (apiKey: string, modelId: string, baseUrl?: string) => LanguageModel
>;

/**
 * Endpoint canônico do provider Anthropic (baseURL default do @ai-sdk/anthropic). NÃO é
 * um knob de política (a allowlist de política é a do egress.ts) — é o destino INTRÍNSECO
 * de ter escolhido o provider anthropic. Se uma org precisar de proxy/baseURL custom, é aqui
 * que ele entra (junto do `fetch` contido), nunca espalhado.
 */
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com';
const OPENAI_ENDPOINT = 'https://api.openai.com';
const GOOGLE_ENDPOINT = 'https://generativelanguage.googleapis.com';
/**
 * A OpenRouter fala a API da OpenAI, então o provider `@ai-sdk/openai` conversa
 * com ela sem dependência nova — e os ids dela já vêm no formato
 * `familia/modelo`, o mesmo dos nossos, sem tradução no meio.
 */
export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1';

/**
 * Cabeçalhos OPCIONAIS de atribuição da OpenRouter.
 *
 * A doc deles chama `HTTP-Referer` e `X-Title` de "optional headers to identify
 * your app and make it discoverable to users on our site" — servem para
 * atribuição e para o ranking público do site deles, NÃO para a chamada
 * funcionar. Chamada sem eles é atendida normalmente.
 *
 * Por isso eles saem da INSTALAÇÃO e nunca do código: uma URL literal aqui
 * viajaria dentro da imagem que todo self-hoster roda, creditando o consumo de
 * OpenRouter de cada cliente a um site que não é dele. E um título literal com
 * o nome do produto é a marca vazando por fora do resolvedor — a catraca de
 * `tests/unit/branding.test.ts` reprova, e está certa.
 *
 * Sem valor, nenhum header vai: falha aberta na informação, porque a ausência
 * de atribuição não quebra ninguém.
 */
export function cabecalhosDeAtribuicaoOpenRouter(): Record<string, string> | undefined {
  const url = process.env.OPENROUTER_APP_URL?.trim();
  const titulo = process.env.OPENROUTER_APP_TITLE?.trim();
  const headers: Record<string, string> = {};
  if (url) headers['HTTP-Referer'] = url;
  if (titulo) headers['X-Title'] = titulo;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Esforço de raciocínio das chamadas DIRETAS à OpenAI — knob
 * OPENAI_REASONING_EFFORT (opcional; ausente = nada é injetado e vale o padrão
 * do modelo).
 *
 * Por que existe: nos modelos de raciocínio da OpenAI (famílias gpt-5.x e
 * gpt-6) o padrão é PENSAR antes de responder, e o agente de WhatsApp paga isso
 * em latência. Medido em 2026-09-24 com `gpt-6-luna`, prompt de produção e a
 * tool `send_message`, 2 repetições por configuração:
 *
 *   padrão ........ 4,9–5,5 s, 248–282 tokens de saída, send_message 0 de 2
 *   effort=low .... 5,9–6,3 s, 258–284 tokens de saída, send_message 1 de 2
 *   effort=none ... 1,8–2,0 s,       49 tokens de saída, send_message 2 de 2
 *
 * No turno real (`agent_preview`) o padrão levou 9–27 s, com ~700 tokens de
 * saída para um rascunho de ~40 — e, quando o modelo não chama a tool, o loop
 * roda outra etapa.
 *
 * ⚠️ Só vale para o provider `openai` (endpoint oficial, Responses API) e só
 * em modelo que raciocina (`modeloOpenAIRaciocina`): modelo SEM raciocínio
 * recusa o campo — medido: `gpt-4.1-nano` + `reasoning.effort` → 400
 * "Unsupported parameter". A grafia é validada no boot do worker
 * (`lib/agent-engine/env.ts`, pela mesma função abaixo): errada, o worker não
 * sobe e diz qual variável corrigir, em vez de falhar a cada turno.
 */
export type EsforcoDeRaciocinioOpenAI = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
const ESFORCOS_OPENAI: readonly EsforcoDeRaciocinioOpenAI[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export function esforcoDeRaciocinioOpenAI(
  valor: string | undefined = process.env.OPENAI_REASONING_EFFORT,
): EsforcoDeRaciocinioOpenAI | null {
  const v = valor?.trim().toLowerCase();
  if (!v) return null;
  if (!(ESFORCOS_OPENAI as readonly string[]).includes(v)) {
    throw new Error(`OPENAI_REASONING_EFFORT inválido — use ${ESFORCOS_OPENAI.join(', ')} (ou deixe vazio)`);
  }
  return v as EsforcoDeRaciocinioOpenAI;
}

/**
 * Famílias de raciocínio da OpenAI: `o1`/`o3`/`o4-…`, `gpt-5…` e `gpt-6…` — menos
 * as variantes `-chat`, que não raciocinam. Fora daqui o knob não injeta nada.
 */
export function modeloOpenAIRaciocina(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return /^(o\d|gpt-5|gpt-6)/.test(id) && !id.includes('chat');
}

/** Injeta `reasoning.effort` no corpo, preservando o resto de `reasoning` e da chamada. */
function comEsforcoDeRaciocinio(inner: typeof fetch, esforco: EsforcoDeRaciocinioOpenAI): typeof fetch {
  return (input, init) => {
    const corpo = init?.body;
    if (typeof corpo === 'string') {
      try {
        const json = JSON.parse(corpo) as Record<string, unknown>;
        const bruto = json['reasoning'];
        const reasoning = bruto !== null && typeof bruto === 'object' ? (bruto as Record<string, unknown>) : {};
        return inner(input, { ...init, body: JSON.stringify({ ...json, reasoning: { ...reasoning, effort: esforco } }) });
      } catch {
        // Corpo não-JSON: repassa intacto — um ajuste de tuning nunca derruba a chamada.
      }
    }
    return inner(input, init);
  };
}


/**
 * Providers reais do lançamento. Sonnet (Anthropic) é o default RECOMENDADO —
 * recomendação vive em .env.example/docs; o id do modelo é sempre config da org.
 *
 * O `fetch` INTERNO do provider (generateText) também roteia pela allowlist
 * (`allowlistedFetch`) — sem isso o egress do SDK escapava da contenção. A
 * allowlist do provider = seu endpoint canônico + hosts extra de config
 * (`allowedHosts`, ex.: proxy corporativo). Testes usam o registry fake
 * (createFakeRegistry, sem fetch real); este caminho só é exercitado pelo smoke
 * (rede real → endpoint canônico do provider allowlistado).
 */
export function createDefaultRegistry(opts?: {
  allowedHosts?: string[];
  /** Knob OPENAI_REASONING_EFFORT; ausente = lido do ambiente. `null` = não injeta. */
  openaiReasoningEffort?: EsforcoDeRaciocinioOpenAI | null;
}): ProviderRegistry {
  const extra = opts?.allowedHosts ?? [];
  const esforcoOpenAI =
    opts?.openaiReasoningEffort !== undefined ? opts.openaiReasoningEffort : esforcoDeRaciocinioOpenAI();
  const contain = (endpoint: string): typeof fetch => {
    const allow = buildAllowlist([endpoint, ...extra]);
    return (input, init) => {
      const url = typeof input === 'string' || input instanceof URL ? input : input.url;
      return allowlistedFetch(url, init, { allowlist: allow });
    };
  };
  return {
    anthropic: (apiKey, modelId) =>
      createAnthropic({ apiKey, fetch: contain(ANTHROPIC_ENDPOINT) })(modelId),
    openai: (apiKey, modelId) => {
      const contido = contain(OPENAI_ENDPOINT);
      const fetchFinal =
        esforcoOpenAI && modeloOpenAIRaciocina(modelId)
          ? comEsforcoDeRaciocinio(contido, esforcoOpenAI)
          : contido;
      return createOpenAI({ apiKey, fetch: fetchFinal })(modelId);
    },
    google: (apiKey, modelId) =>
      createGoogleGenerativeAI({ apiKey, fetch: contain(GOOGLE_ENDPOINT) })(modelId),
    // O tenant só escolhe entre o endpoint oficial e o autorizado pelo operador.
    openrouter: (apiKey, modelId, baseUrl) => {
      const endpoint = trustedAiBaseUrlOrDefault("openrouter", baseUrl) ?? OPENROUTER_ENDPOINT;
      // Chat Completions, NÃO Responses: o `createOpenAI()(modelId)` desta versão
      // do SDK usa /responses por padrão, e a OpenRouter não o serve para todo
      // modelo (no original, `google/gemini-2.5-flash-lite` devolvia "Invalid
      // JSON response"). `.chat()` fixa o formato que a OpenRouter implementa.
      return createOpenAI({
        apiKey,
        baseURL: endpoint,
        headers: cabecalhosDeAtribuicaoOpenRouter(),
        fetch: contain(endpoint),
      }).chat(modelId);
    },
  };
}

/**
 * Registry FAKE para testes: provider 'anthropic' (e alias 'fake') respondendo
 * com o MockLanguageModelV3 do SDK v6 instalado — zero rede, zero chave real.
 * O doGenerate default devolve `text` com usage fixo; injete o seu para cenários
 * de tool-call/erro.
 */
type MockDoGenerate = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>['doGenerate'];

export function createFakeRegistry(
  doGenerate?: MockDoGenerate,
  opts?: { text?: string },
): ProviderRegistry {
  const factory = (_apiKey: string, modelId: string): LanguageModel =>
    new MockLanguageModelV3({
      modelId,
      doGenerate:
        doGenerate ??
        {
          content: [{ type: 'text', text: opts?.text ?? 'ok' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        },
    });
  return { anthropic: factory, fake: factory };
}
