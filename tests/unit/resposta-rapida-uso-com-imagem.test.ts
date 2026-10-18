/**
 * O PAYLOAD DE USO DA RESPOSTA RÁPIDA — texto e imagens da Biblioteca de mídia,
 * ou só texto. Portado e adaptado do projeto original (DeskcommCRM, PR #2704 de
 * @webtecnica): aqui as imagens são ids de itens da biblioteca.
 */
import { describe, expect, it } from "vitest";

import { payloadDeUso } from "@/lib/inbox/template-vars";
import { idsDeMidiaSchema } from "@/lib/templates/midias";

const ITEM = "9b1f0000-0000-4000-8000-0000000000aa";

describe("payload de uso da resposta rápida", () => {
  it("com imagem: o texto interpolado E os itens, numa lista nova", () => {
    const ids = [ITEM];
    const payload = payloadDeUso({ id: "tpl-1", body: "Olá {{primeiro_nome}}, veja.", media_item_ids: ids }, { name: "Ana Souza" });
    expect(payload).toEqual({ texto: "Olá Ana, veja.", midias: [ITEM] });
    expect(payload.midias).not.toBe(ids);
  });

  it("só texto (lista vazia, nula ou ausente): nenhuma imagem", () => {
    expect(payloadDeUso({ body: "Oi", media_item_ids: [] }, {}).midias).toEqual([]);
    expect(payloadDeUso({ body: "Oi", media_item_ids: null }, {}).midias).toEqual([]);
    expect(payloadDeUso({ body: "Oi" }, {}).midias).toEqual([]);
  });

  it("a API aceita até 5 itens, uuids, sem repetição", () => {
    const uuid = (n: number) => `9b1f0000-0000-4000-8000-00000000000${n}`;
    expect(idsDeMidiaSchema.safeParse([1, 2, 3, 4, 5].map(uuid)).success).toBe(true);
    expect(idsDeMidiaSchema.safeParse([1, 2, 3, 4, 5, 6].map(uuid)).success).toBe(false);
    expect(idsDeMidiaSchema.safeParse([uuid(1), uuid(1)]).success).toBe(false);
    expect(idsDeMidiaSchema.safeParse(["org/templates/x.jpg"]).success).toBe(false);
  });
});
