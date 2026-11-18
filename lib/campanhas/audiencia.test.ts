/**
 * A edição do público MESCLA com o que está gravado (auditoria de 17/11/2026,
 * item 13, P0): salvar o rascunho apagava "com negócio no funil / na etapa"
 * porque a chave ausente virava `[]`. Chave ausente é "não mexi"; vazio é
 * "tirei".
 */
import { describe, expect, it } from "vitest";

import { FILTRO_VAZIO, mesclarFiltroDeAudiencia } from "./audiencia";

const FUNIL = "11111111-1111-4111-8111-111111111111";
const ETAPA = "22222222-2222-4222-8222-222222222222";

const GRAVADO = {
  ...FILTRO_VAZIO,
  com_alguma_tag: ["vip"],
  funis: [FUNIL],
  etapas: [ETAPA],
  limite: 100,
};

describe("mesclarFiltroDeAudiencia", () => {
  it("o que não veio continua como estava — o funil e a etapa não somem", () => {
    const r = mesclarFiltroDeAudiencia(GRAVADO, { com_alguma_tag: ["retorno"], limite: 50 });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ com_alguma_tag: ["retorno"], funis: [FUNIL], etapas: [ETAPA], limite: 50 });
  });

  it("lista vazia LIMPA o critério: é assim que a tela tira o funil", () => {
    const r = mesclarFiltroDeAudiencia(GRAVADO, { funis: [], etapas: [] });
    expect(r.data).toMatchObject({ funis: [], etapas: [], com_alguma_tag: ["vip"] });
  });

  it("o recorte que vale é o MESCLADO: tirar o último critério é recusado", () => {
    const r = mesclarFiltroDeAudiencia(
      { ...FILTRO_VAZIO, funis: [FUNIL] },
      { funis: [] },
    );
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.code === "custom")).toBe(true);
  });

  it("chave antiga gravada não trava a edição; chave desconhecida do cliente é recusada", () => {
    expect(mesclarFiltroDeAudiencia({ ...GRAVADO, chave_de_versao_antiga: 1 }, {}).success).toBe(true);
    expect(mesclarFiltroDeAudiencia(GRAVADO, { inventada: true }).success).toBe(false);
  });

  it("sem nada gravado (lixo no banco), vale só o que veio", () => {
    const r = mesclarFiltroDeAudiencia("lixo", { sem_tags: ["parou"] });
    expect(r.data).toMatchObject({ sem_tags: ["parou"], funis: [] });
  });
});
