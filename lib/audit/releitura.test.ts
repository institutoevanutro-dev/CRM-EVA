import { describe, expect, it } from "vitest";

import { ehAberturaDeLeitura, marcarReleitura, PARAM_RELEITURA } from "./releitura";

describe("releitura — a regra que separa abrir de atualizar", () => {
  const u = (qs: string) => new URL(`http://x/api/v1/conversations/c/messages${qs}`);

  it("abertura: primeira página, sem marca de atualização → audita", () => {
    expect(ehAberturaDeLeitura(u("?limit=50"))).toBe(true);
  });

  it("atualização de dado já na tela (Realtime, foco da aba, invalidação) → não audita", () => {
    expect(ehAberturaDeLeitura(u(`?limit=50&${PARAM_RELEITURA}=1`))).toBe(false);
  });

  it("paginação (cursor) → não audita", () => {
    expect(ehAberturaDeLeitura(u("?cursor=abc&limit=50"))).toBe(false);
  });

  it("o cliente só marca quando o dado já está na tela", () => {
    expect(marcarReleitura(new URLSearchParams("limit=50"), false).toString()).toBe("limit=50");
    expect(marcarReleitura(new URLSearchParams("limit=50"), true).get(PARAM_RELEITURA)).toBe("1");
  });
});
