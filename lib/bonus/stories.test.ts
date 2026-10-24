import { describe, expect, it } from "vitest";

import { agruparStoriesPorDia, contagemDoDia, normalizarTimestamp, unirIds } from "./stories";

describe("stories por dia", () => {
  it("normaliza o +0000 da plataforma para um ISO que o Date entende", () => {
    expect(normalizarTimestamp("2026-11-03T14:00:00+0000")).toBe("2026-11-03T14:00:00+00:00");
    expect(new Date(normalizarTimestamp("2026-11-03T14:00:00+0000")).toISOString()).toBe("2026-11-03T14:00:00.000Z");
  });

  it("agrupa pelo dia LOCAL: 01h UTC ainda é ontem em São Paulo", () => {
    const g = agruparStoriesPorDia(
      [
        { id: "s1", timestamp: "2026-11-04T01:00:00+0000" },
        { id: "s2", timestamp: "2026-11-04T13:00:00+0000" },
      ],
      "America/Sao_Paulo",
    );
    expect(Object.fromEntries(g)).toEqual({ "2026-11-03": ["s1"], "2026-11-04": ["s2"] });
  });

  it("une sem repetir e conta o que entrou", () => {
    expect(unirIds(["s1"], ["s1", "s2"])).toEqual({ ids: ["s1", "s2"], acrescentados: 1 });
  });

  it("o lançamento manual vence a leitura", () => {
    expect(contagemDoDia({ story_ids: ["s1"], contagem_manual: 2 })).toBe(2);
    expect(contagemDoDia({ story_ids: ["s1", "s2", "s3"], contagem_manual: null })).toBe(3);
  });

  it("leitura recusada não apaga o lançamento manual: ids vazios + leitura_erro, vale a contagem manual", () => {
    // A linha como o cron a deixa quando a borda recusa: só leitura_erro/lido_em mudam.
    const linha = { story_ids: [] as string[], contagem_manual: 2, leitura_erro: "sem_permissao" };
    expect(contagemDoDia(linha)).toBe(2);
  });
});
