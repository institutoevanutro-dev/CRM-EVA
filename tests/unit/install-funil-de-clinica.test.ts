import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { slugDeNome } from "@/lib/leads/stage-editing";
import { PACOTES } from "@/lib/onboarding/pacotes-de-funil";
import { etapasParaGravar } from "@/lib/onboarding/proposta-de-funil";

/**
 * O FUNIL DE CLÍNICA DO install.sh É O DO ONBOARDING.
 *
 * Com ORG_NICHO=clinica, o install.sh grava o funil "Agendamentos" pela mesma
 * função do banco que o assistente de onboarding usa
 * (fn_aplicar_quadro_do_onboarding). O instalador é bash e não importa
 * TypeScript, então o quadro mora lá como CÓPIA em JSON (FUNIL_DE_CLINICA).
 * Este teste dá dono a ela: a fonte é o pacote "clinica" de
 * lib/onboarding/pacotes-de-funil.ts, convertido do mesmo jeito que o
 * importador de clínicas converte (etapasParaGravar + slugDeNome). Mudou o
 * pacote, este teste reprova até a cópia acompanhar.
 */
const INSTALL = fs.readFileSync(path.join(process.cwd(), "hostgator-setup-kit/install.sh"), "utf8");

describe("o funil de clínica do install.sh", () => {
  it("é o pacote clinica do onboarding, no formato que o banco grava", () => {
    const linha = /^FUNIL_DE_CLINICA='(.*)'$/m.exec(INSTALL);
    expect(
      linha,
      "FUNIL_DE_CLINICA sumiu do install.sh, ou saiu do formato de uma linha entre aspas simples",
    ).not.toBeNull();

    const pacote = PACOTES.find((p) => p.id === "clinica");
    if (!pacote) throw new Error("o pacote clinica sumiu de lib/onboarding/pacotes-de-funil.ts");
    expect(JSON.parse(linha?.[1] ?? "null")).toEqual({
      nome: pacote.proposta.nome,
      slug: slugDeNome(pacote.proposta.nome, [], "funil"),
      etapas: etapasParaGravar(pacote.proposta, slugDeNome),
    });

    // A cópia entra num literal SQL entre aspas simples: uma aspa simples
    // num nome de etapa fecharia o literal e quebraria a etapa 8 da instalação.
    expect(linha?.[1] ?? "").not.toContain("'");
  });
});
