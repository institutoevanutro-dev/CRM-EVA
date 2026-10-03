/**
 * Embedding das formas de perguntar, no CADASTRO. NUNCA lança: sem chave ou com
 * falha, a forma de perguntar é salva com `embedding = null` e a tela avisa
 * ("não reconhecida") — salvar não pode depender da OpenAI estar de pé, e o
 * botão "Calcular agora" (POST .../embeddings) completa depois.
 *
 * O texto embedado passa pelo MESMO `textoParaComparar` da mensagem do cliente:
 * uma saudação cadastrada ("Oi, quanto custa?") não pode deslocar o vetor.
 */
import { embedText } from "@/lib/ai/embed";
import { MODELO_DE_EMBEDDING, resolverChaveDeEmbedding } from "@/lib/ai/embeddings/chave";
import { logger } from "@/lib/logger";

import { textoParaComparar } from "./casamento";

export interface PerguntaEmbedada {
  texto: string;
  /** Literal pgvector `[x,y,…]`, ou null = ainda não reconhecida. */
  embedding: string | null;
  modelo_embedding: string | null;
}

export async function embedarPerguntas(
  organizationId: string,
  textos: readonly string[],
  deps: { embed?: typeof embedText; resolverChave?: typeof resolverChaveDeEmbedding } = {},
): Promise<PerguntaEmbedada[]> {
  const semVetor = (texto: string): PerguntaEmbedada => ({ texto, embedding: null, modelo_embedding: null });
  if (textos.length === 0) return [];
  let chave: Awaited<ReturnType<typeof resolverChaveDeEmbedding>>;
  try {
    chave = await (deps.resolverChave ?? resolverChaveDeEmbedding)(organizationId, "embedding_indexar");
  } catch {
    return textos.map(semVetor);
  }
  if (!chave) return textos.map(semVetor);
  const embed = deps.embed ?? embedText;
  const saida: PerguntaEmbedada[] = [];
  for (const texto of textos) {
    try {
      const { embedding } = await embed(textoParaComparar([texto]) || texto, {
        organizationId,
        ponto: "embedding_indexar",
        chave,
      });
      saida.push({ texto, embedding: `[${embedding.join(",")}]`, modelo_embedding: MODELO_DE_EMBEDDING });
    } catch (err) {
      logger.warn("[respostas-prontas] embedding da forma de perguntar falhou", {
        organization_id: organizationId,
        error: err instanceof Error ? err.message.slice(0, 160) : "erro desconhecido",
      });
      saida.push(semVetor(texto));
    }
  }
  return saida;
}
