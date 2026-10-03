/**
 * Grava a similaridade (cosseno) de cada frase do corpus contra cada item do
 * CADASTRO, com o modelo de embedding REAL do produto. Rodado à mão, uma vez por
 * mudança de corpus — o teste do CI lê o arquivo e nunca chama a rede.
 *
 * Uso: OPENAI_API_KEY=sk-... pnpm exec tsx scripts/respostas-prontas-gravar-similaridades.ts
 *
 * A similaridade por item é o MÁXIMO entre as formas de perguntar do item — a
 * mesma régua do SQL do motor (`max(1 - (embedding <=> vetor))`). Os dois lados
 * passam pelo `textoParaComparar`, como no cadastro e no motor.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createOpenAI } from "@ai-sdk/openai";
import { embedMany } from "ai";

import { textoParaComparar } from "@/lib/respostas-prontas/casamento";

import { CADASTRO, DEVEM_CASAR, FORA_DA_AMOSTRA, NAO_DEVEM_CASAR, hashDoCadastro } from "../tests/fixtures/respostas-prontas/corpus";

/**
 * Literal, e não importado de `lib/ai/embeddings/chave.ts`: aquele módulo puxa o
 * `lib/env.ts`, que exige as variáveis do Supabase para rodar. Divergir não passa
 * em silêncio: o teste do corpus compara o `modelo` gravado com MODELO_DE_EMBEDDING.
 */
const MODELO_DE_EMBEDDING = "openai/text-embedding-3-small";

function cosseno(a: readonly number[], b: readonly number[]): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    ab += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  return ab / Math.sqrt(aa * bb);
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("defina OPENAI_API_KEY");
  const modelo = createOpenAI({ apiKey }).textEmbeddingModel(MODELO_DE_EMBEDDING.replace(/^openai\//, ""));

  const perguntas = CADASTRO.flatMap((item) =>
    item.perguntas.map((p) => ({ item: item.id, texto: textoParaComparar([p]) || p })),
  );
  const mensagens = [
    ...new Set([...DEVEM_CASAR.map((d) => d.mensagem), ...NAO_DEVEM_CASAR, ...FORA_DA_AMOSTRA.map((d) => d.mensagem)]),
  ];
  const textosDasMensagens = mensagens.map((m) => textoParaComparar([m]) || m);

  const { embeddings } = await embedMany({
    model: modelo,
    values: [...perguntas.map((p) => p.texto), ...textosDasMensagens],
  });
  const vetoresDasPerguntas = embeddings.slice(0, perguntas.length);
  const vetoresDasMensagens = embeddings.slice(perguntas.length);

  const similaridades: Record<string, Record<string, number>> = {};
  mensagens.forEach((mensagem, i) => {
    const porItem: Record<string, number> = {};
    perguntas.forEach((p, j) => {
      const s = Number(cosseno(vetoresDasMensagens[i]!, vetoresDasPerguntas[j]!).toFixed(4));
      porItem[p.item] = Math.max(porItem[p.item] ?? -1, s);
    });
    similaridades[mensagem] = porItem;
  });

  const destino = join(process.cwd(), "tests/fixtures/respostas-prontas/similaridades.json");
  writeFileSync(
    destino,
    `${JSON.stringify({ modelo: MODELO_DE_EMBEDDING, cadastro_hash: hashDoCadastro(), gerado_em: new Date().toISOString(), similaridades }, null, 2)}\n`,
  );
  process.stdout.write(`gravado: ${destino}\n`);
  for (const [m, s] of Object.entries(similaridades)) {
    const top = Object.entries(s).sort((a, b) => b[1] - a[1]).slice(0, 2);
    process.stdout.write(`${top.map(([k, v]) => `${k}=${v.toFixed(3)}`).join("  ")}  ← ${m}\n`);
  }
}

main().catch((err: unknown) => {
  // A OpenAI ecoa um pedaço da chave no 401: nunca deixar chegar ao terminal.
  const mensagem = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${mensagem.replace(/sk-[\w*.-]+/g, "sk-[omitida]")}\n`);
  process.exit(1);
});
