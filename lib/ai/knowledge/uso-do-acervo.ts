/**
 * QUEM CONSULTA CADA MATERIAL DO ACERVO, E QUANDO FOI A ÚLTIMA VEZ.
 *
 * A tela "O que o agente sabe" dizia "Consultado por: nenhum assistente ainda"
 * em TODO cartão de uma clínica com 98 buscas no acervo em 30 dias, todas com
 * acerto, feitas por 5 assistentes. A causa era a consulta dos agentes: o embed
 * `ai_agent_versions!inner(...)` é ambíguo (as duas tabelas se ligam por duas
 * chaves estrangeiras), o PostgREST recusava a consulta inteira com PGRST201, e
 * a página lia só `data`, que vinha `null`. Lista vazia, cartão "órfão".
 *
 * Agora a resposta vem de DOIS fatos, e a tela mostra os dois:
 *   - quem PODE consultar: a versão publicada de cada assistente lista o
 *     material (`ai_agent_versions.knowledge_source_ids`);
 *   - quem CONSULTOU: `knowledge_searches`, gravada pelo motor a cada busca,
 *     com `agent_id` e `knowledge_source_ids` (0181).
 *
 * Erro de leitura não vira lista vazia: devolve `null`, e a tela diz que não
 * conseguiu ver, em vez de afirmar que ninguém consulta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** A janela de "quem consultou". Mais longa que isso, a resposta envelhece. */
export const JANELA_DE_CONSULTAS_DIAS = 30;

// ponytail: teto de linhas que o PostgREST devolve por consulta (max_rows do
// Supabase). Lidas da mais nova para a mais velha, a última consulta de cada
// material sai certa; com mais de 1000 buscas em 30 dias, "quem consultou" passa
// a valer para as 1000 mais recentes. Se um acervo chegar lá, vira uma função
// de agregação no banco.
const TETO_DE_BUSCAS = 1000;

export interface AgenteDoAcervo {
  id: string;
  nome: string;
  /** No ar: não arquivado e com versão publicada. */
  noAr: boolean;
  /** Materiais que a versão publicada consulta. */
  materiais: string[];
}

export interface BuscaNoAcervo {
  agent_id: string | null;
  knowledge_source_ids: string[] | null;
  created_at: string;
}

export interface UsoDoMaterial {
  /** Nomes de quem consultou nos últimos `JANELA_DE_CONSULTAS_DIAS` dias. */
  consultadoPor: string[];
  /** Todos os assistentes no ar que leem o acervo consultaram este material. */
  todos: boolean;
  /** A consulta mais recente na janela (ISO), ou `null`. */
  ultimaConsultaEm: string | null;
  /** Nomes de quem está no ar e tem este material na versão publicada. */
  disponivelPara: string[];
}

/** Regra pura: agentes e buscas já lidos → uso de cada material. */
export function usoDoAcervo(
  agentes: AgenteDoAcervo[],
  buscas: BuscaNoAcervo[],
): Record<string, UsoDoMaterial> {
  const nomePorId = new Map(agentes.map((a) => [a.id, a.nome]));
  // Quem lê o acervo: no ar e com pelo menos um material. Um assistente sem
  // material nenhum não tem como consultar, e não pode tirar o "todos".
  const leitores = agentes.filter((a) => a.noAr && a.materiais.length > 0);

  const consultas = new Map<string, { agentes: Set<string>; ultima: string }>();
  for (const b of buscas) {
    for (const materialId of b.knowledge_source_ids ?? []) {
      const atual = consultas.get(materialId) ?? { agentes: new Set<string>(), ultima: b.created_at };
      if (b.agent_id && nomePorId.has(b.agent_id)) atual.agentes.add(b.agent_id);
      if (Date.parse(b.created_at) > Date.parse(atual.ultima)) atual.ultima = b.created_at;
      consultas.set(materialId, atual);
    }
  }

  const materiais = new Set([...consultas.keys(), ...leitores.flatMap((a) => a.materiais)]);
  const uso: Record<string, UsoDoMaterial> = {};
  for (const materialId of materiais) {
    const c = consultas.get(materialId);
    const quem = c?.agentes ?? new Set<string>();
    uso[materialId] = {
      consultadoPor: [...quem].map((id) => nomePorId.get(id)!).sort((x, y) => x.localeCompare(y, "pt-BR")),
      todos: leitores.length > 1 && leitores.every((a) => quem.has(a.id)),
      ultimaConsultaEm: c?.ultima ?? null,
      disponivelPara: leitores
        .filter((a) => a.materiais.includes(materialId))
        .map((a) => a.nome)
        .sort((x, y) => x.localeCompare(y, "pt-BR")),
    };
  }
  return uso;
}

/**
 * Lê agentes e buscas da organização e aplica a regra. `null` = não deu para
 * ler, e a tela tem de dizer isso (nunca "ninguém consulta").
 */
export async function carregarUsoDoAcervo(
  supabase: SupabaseClient,
  organizationId: string,
  agora: Date = new Date(),
): Promise<Record<string, UsoDoMaterial> | null> {
  const desde = new Date(agora.getTime() - JANELA_DE_CONSULTAS_DIAS * 86_400_000).toISOString();
  const [agentes, buscas] = await Promise.all([
    supabase
      .from("ai_agents")
      // A chave vai NOMEADA: são duas entre as tabelas, e sem o nome o PostgREST
      // recusa a consulta (tests/unit/embed-da-versao-do-agente-nomeia-a-chave).
      .select(
        "id, name, archived_at, versao:ai_agent_versions!ai_agents_published_version_id_fkey(knowledge_source_ids)",
      )
      .eq("organization_id", organizationId),
    supabase
      .from("knowledge_searches")
      .select("agent_id, knowledge_source_ids, created_at")
      .eq("organization_id", organizationId)
      .gte("created_at", desde)
      .order("created_at", { ascending: false })
      .limit(TETO_DE_BUSCAS),
  ]);

  const erro = agentes.error ?? buscas.error;
  if (erro) {
    logger.warn("[acervo] não consegui ler quem consulta os materiais", {
      organization_id: organizationId,
      code: erro.code,
      error: erro.message,
    });
    return null;
  }

  type Linha = {
    id: string;
    name: string;
    archived_at: string | null;
    versao: { knowledge_source_ids: string[] | null } | Array<{ knowledge_source_ids: string[] | null }> | null;
  };
  const lidos: AgenteDoAcervo[] = ((agentes.data ?? []) as unknown as Linha[]).map((a) => {
    // Para-um vem como objeto; o array é defesa contra versão do PostgREST.
    const versao = Array.isArray(a.versao) ? (a.versao[0] ?? null) : a.versao;
    return {
      id: a.id,
      nome: a.name,
      noAr: a.archived_at === null && versao !== null,
      materiais: versao?.knowledge_source_ids ?? [],
    };
  });
  return usoDoAcervo(lidos, (buscas.data ?? []) as BuscaNoAcervo[]);
}
