import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAdminClient } from "@/lib/supabase/admin";
import { ErroDeExtracao, extrairTextoDoArquivo } from "@/lib/ai/rag/ingest/documento";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

/**
 * O `blob_path` da fonte de conhecimento pode vir do corpo da requisição
 * (`source_metadata`), e o download usa a service role num bucket único. Sem a
 * trava, um gerente da org A apontava o caminho para um arquivo da org B e o
 * indexador o embutia na base da org A.
 */
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

const download = vi.fn(async () => ({ data: new Blob(["conteúdo"]), error: null }));

beforeEach(() => {
  download.mockClear();
  vi.mocked(createAdminClient).mockReturnValue({
    storage: { from: () => ({ download }) },
  } as unknown as ReturnType<typeof createAdminClient>);
});

describe("extração de arquivo do acervo", () => {
  it("lê o arquivo que está na pasta da própria organização", async () => {
    const { texto } = await extrairTextoDoArquivo(ORG_A, `${ORG_A}/material.txt`, "txt");
    expect(texto).toContain("conteúdo");
    expect(download).toHaveBeenCalledWith(`${ORG_A}/material.txt`);
  });

  it.each([
    ["arquivo de outra organização", `${ORG_B}/material.txt`],
    ["subida de pasta", `${ORG_A}/../${ORG_B}/material.txt`],
    ["barra dupla", `${ORG_A}//material.txt`],
    ["prefixo sem barra", `${ORG_A}x/material.txt`],
  ])("recusa %s sem baixar nada", async (_nome, caminho) => {
    await expect(extrairTextoDoArquivo(ORG_A, caminho, "txt")).rejects.toBeInstanceOf(ErroDeExtracao);
    expect(download).not.toHaveBeenCalled();
  });
});
