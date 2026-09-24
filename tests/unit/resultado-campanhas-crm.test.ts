import { describe, expect, it } from "vitest";

import {
  campanhaDoContato,
  inicioDoDiaNoFuso,
  resultadosPorCampanha,
} from "@/lib/plataformas-de-anuncio/meta/resultado-crm";

const mapa = new Map([
  ["120200001", "120300001"],
  ["120200002", "120300002"],
]);

describe("resultado comercial por campanha", () => {
  it("usa o dia civil da conta, inclusive quando muda o horário de verão", () => {
    expect(inicioDoDiaNoFuso("2026-09-01", "America/Sao_Paulo")).toBe("2026-09-01T03:00:00.000Z");
    expect(inicioDoDiaNoFuso("2026-03-09", "America/New_York")).toBe("2026-03-09T04:00:00.000Z");
  });
  it("relaciona ad ID à campanha, sem confundir ctwa_clid ou título", () => {
    expect(
      campanhaDoContato(
        {
          ad_platform: "meta_ads",
          ad_source_id: "CLIQUE",
          ad_title: "Mesmo nome",
          ad_raw: {
            source_type: "ad",
            source_id: "120200001",
            ctwa_clid: "CLIQUE",
          },
        },
        mapa,
      ),
    ).toBe("120300001");
    expect(
      campanhaDoContato(
        { ad_platform: "meta_ads", ad_source_id: "120200001", ad_title: "Mesmo nome" },
        mapa,
      ),
    ).toBeNull();
    expect(
      campanhaDoContato(
        { ad_platform: "meta_ads", ad_raw: { source_type: "post", source_id: "120200001" } },
        mapa,
      ),
    ).toBeNull();
    expect(
      campanhaDoContato({ utm_source: "instagram", utm_campaign_id: "999999999" }, mapa),
    ).toBeNull();
    expect(campanhaDoContato({ utm_source: "instagram", utm_campaign_id: "120300001" }, mapa)).toBe(
      "120300001",
    );
  });

  it("soma apenas vendas financeiras dos contatos atribuídos, com centavos exatos", () => {
    const contatos = [
      {
        id: "a",
        is_anonymized: false,
        source_metadata: { ad_platform: "meta_ads", ad_raw: { source_id: "120200001" } },
      },
      {
        id: "b",
        is_anonymized: false,
        source_metadata: { ad_platform: "meta_ads", ad_raw: { source_id: "120200002" } },
      },
      {
        id: "c",
        is_anonymized: true,
        source_metadata: { ad_platform: "meta_ads", ad_raw: { source_id: "120200001" } },
      },
      { id: "d", is_anonymized: false, source_metadata: {} },
    ];
    const vendas = [
      { contato_id: "a", vendas: 2, valor_cents: "9007199254740993", recebido_cents: "4000" },
    ];
    expect(resultadosPorCampanha(contatos, mapa, vendas)).toEqual({
      campanhas: [
        {
          campanha_id: "120300001",
          contatos: 1,
          vendas: 2,
          valor_cents: "9007199254740993",
          recebido_cents: "4000",
        },
        { campanha_id: "120300002", contatos: 1, vendas: 0, valor_cents: "0", recebido_cents: "0" },
      ],
      contatos_sem_campanha: 1,
      contatos_atribuidos: 2,
    });
    expect(resultadosPorCampanha(contatos, mapa, null).campanhas[0]).toMatchObject({
      vendas: null,
      valor_cents: null,
    });
  });
});
