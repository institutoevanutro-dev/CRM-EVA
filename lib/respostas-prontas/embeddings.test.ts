import { describe, expect, it, vi } from "vitest";

import { embedarPerguntas } from "./embeddings";

const chave = { origem: "plataforma" } as never;
const ctx = (embed: unknown, resolverChave: unknown = async () => chave) =>
  ({ embed, resolverChave }) as unknown as Parameters<typeof embedarPerguntas>[2];

describe("embedarPerguntas", () => {
  it("sucesso: devolve o literal pgvector e o modelo", async () => {
    const embed = vi.fn(async () => ({ embedding: [0.1, 0.2] }));
    const r = await embedarPerguntas("org", ["Quanto custa?"], ctx(embed));
    expect(r).toEqual([{ texto: "Quanto custa?", embedding: "[0.1,0.2]", modelo_embedding: "openai/text-embedding-3-small" }]);
  });

  it("falha do embedding: salva como não reconhecida e NÃO lança; as outras seguem", async () => {
    const embed = vi
      .fn()
      .mockRejectedValueOnce(new Error("fora do ar"))
      .mockResolvedValueOnce({ embedding: [1] });
    const r = await embedarPerguntas("org", ["a pergunta", "outra pergunta"], ctx(embed));
    expect(r[0]).toEqual({ texto: "a pergunta", embedding: null, modelo_embedding: null });
    expect(r[1]!.embedding).toBe("[1]");
  });

  it("sem chave (ou resolvedor lançando): tudo não reconhecido, sem chamar o embedding", async () => {
    const embed = vi.fn();
    const semChave = await embedarPerguntas("org", ["x y z"], ctx(embed, async () => null));
    const lancou = await embedarPerguntas("org", ["x y z"], ctx(embed, async () => { throw new Error("db"); }));
    expect(semChave[0]!.embedding).toBeNull();
    expect(lancou[0]!.embedding).toBeNull();
    expect(embed).not.toHaveBeenCalled();
  });

  it("lista vazia: vazio", async () => {
    expect(await embedarPerguntas("org", [], ctx(vi.fn()))).toEqual([]);
  });
});
