import { estadoDoAgente } from "@/lib/ai/agents/no-ar";
import type { AgentRow } from "@/hooks/ai/useAgent";

// Fora do "use client": a página do agente (servidor) também deriva o estado.
export type AgentStatus = "published" | "draft" | "paused" | "archived" | "invalid";

/**
 * "Publicado" tem que significar "está no ar", e quem decide isso é o runtime.
 *
 * A régua mora em `lib/ai/agents/no-ar.ts` e é a MESMA que os workers e as
 * rotas de picker importam. Ela morava aqui, e enquanto morou aqui foi copiada
 * errado três vezes — a cópia do `ai-response-worker` (`.eq("is_active", true)`
 * e nada mais) chegou a responder ao cliente por um agente que esta função
 * rotulava "Rascunho".
 *
 * Duas coisas que este badge já afirmou e que foram MEDIDAS como falsas:
 *
 *   1. "o agente ativo sem versão é invisível para os dois runtimes" — ele é
 *      visível para um terceiro, `workers/ai-response-worker.ts`, que responde
 *      ao cliente por ele. Um `rag_bot` legado ativo e sem versão está NO AR, e
 *      chamá-lo de "Rascunho" era a tela escondendo quem atende. O caso que
 *      motivou aquele texto — o agente do onboarding — não regride: hoje
 *      `createDefaultAgent.ts` grava `kind: "mcp_agent"`, e `mcp_agent` sem
 *      ponteiro continua "Rascunho", porque a config dele vive na versão.
 *   2. "com versão publicada e inativo é Pausado" — nem o agent-engine
 *      (`loadPublishedAgentConfig`) nem o dispatcher leem `is_active`. Com
 *      versão publicada o agente responde, e o rótulo honesto é "Publicado".
 *
 * "Parado" tem duas causas, e a tela as separa: com `paused_at` alguém PAUSOU
 * o agente ("Pausado"); sem ele, falta publicar ("Rascunho"). Antes as duas
 * viravam "Rascunho", e o filtro "Pausado" nunca encontrava nada.
 */
export function deriveAgentStatus(agent: AgentRow): AgentStatus {
  // `AgentRow` traz `paused_at` como opcional (o tipo vem da linha do banco),
  // e `FatosDoAgente` o exige justamente para que consulta sem a coluna não
  // compile. Aqui a página SELECIONA a coluna, então normalizar é honesto.
  switch (estadoDoAgente({ ...agent, paused_at: agent.paused_at ?? null })) {
    case "arquivado":
      return "archived";
    case "no_ar":
    case "no_ar_legado":
      return "published";
    case "parado":
      return agent.paused_at ? "paused" : "draft";
  }
}
