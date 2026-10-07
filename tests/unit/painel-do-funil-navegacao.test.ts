/**
 * A porta do Painel do funil (DoD 14) e o espanhol do que ela escreve.
 *
 * A entrada mora só no hub de Análise: a barra lateral está medida no limite
 * (`app/app/analise/page.tsx`). E o guard de i18n das telas NÃO varre o
 * catálogo — o de `idioma-da-interface` só olha item com `sidebar` —, então o
 * rótulo e a descrição desta entrada são cobrados aqui.
 */
import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";
import { NAV_DESTINATIONS } from "@/lib/navigation/registry";

describe("porta do Painel do funil", () => {
  const entrada = NAV_DESTINATIONS.find((d) => d.href === "/app/painel-do-funil");

  it("está no grupo Análise, para manager, fora da barra lateral", () => {
    expect(entrada).toBeDefined();
    expect(entrada).toMatchObject({
      label: "Painel do funil",
      group: "analise",
      minRole: "manager",
      section: "Os números do período",
    });
    expect(entrada?.sidebar).toBeUndefined();
  });

  it("rótulo e descrição têm espanhol", () => {
    expect(DICIONARIO[entrada!.label]?.es).toBeTruthy();
    expect(DICIONARIO[entrada!.description]?.es).toBeTruthy();
  });
});
