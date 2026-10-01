import { describe, expect, it } from "vitest";

import { appDaMetaDoAmbiente, VARIAVEIS_DO_CADASTRO_INCORPORADO } from "@/lib/channels/meta/app";

describe("app da Meta — Cadastro Incorporado", () => {
  it("lê META_APP_ID e META_ES_CONFIG_ID do ambiente, vazio é ausente", () => {
    expect(appDaMetaDoAmbiente({ META_APP_ID: " 1054112660758768 ", META_ES_CONFIG_ID: "" })).toMatchObject({
      appId: "1054112660758768",
      esConfigId: null,
    });
  });
  it("as variáveis que a tela pode nomear", () => {
    expect(VARIAVEIS_DO_CADASTRO_INCORPORADO).toEqual(["META_APP_ID", "META_ES_CONFIG_ID"]);
  });
});
