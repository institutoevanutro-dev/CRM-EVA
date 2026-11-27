/**
 * UMA SÓ CÓPIA ABERTA POR NEGÓCIO DE ORIGEM E FUNIL — a régua que reconhece o
 * `23505` do índice único `crm_leads_clone_aberto_no_funil_uidx` (migration
 * 0440) e o transforma em 409 de negócio.
 *
 * Portado do projeto original (DeskcommCRM PR #5294, de melgarafael), reduzido à
 * régua: os escritores de cópia do upstream (`clone-com-anexos`,
 * `transfere-para-o-funil`) não existem neste fork. O índice em si é medido em
 * `tests/invariants/clone-no-funil-sem-duplicata.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { ApiErrorCodes } from "@/lib/api/errors";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  COPIA_ABERTA_NO_FUNIL,
  ehCopiaAbertaRepetida,
  recusaDeCopiaAbertaPeloBanco,
} from "@/lib/leads/copia-aberta-no-funil";

const doIndice = {
  code: "23505",
  message: 'duplicate key value violates unique constraint "crm_leads_clone_aberto_no_funil_uidx"',
};

describe("copia-aberta-no-funil", () => {
  it("reconhece o 23505 DESTE índice e só dele", () => {
    expect(ehCopiaAbertaRepetida(doIndice)).toBe(true);
    expect(ehCopiaAbertaRepetida({
      code: "23505",
      message: 'duplicate key value violates unique constraint "uniq_crm_leads_org_source_external"',
    })).toBe(false);
    expect(ehCopiaAbertaRepetida({ code: "42501", message: doIndice.message })).toBe(false);
    expect(ehCopiaAbertaRepetida(null)).toBe(false);
  });

  it("vira a recusa 409 com código declarado e frase traduzida", () => {
    expect(recusaDeCopiaAbertaPeloBanco(doIndice)).toEqual({
      codigo: "copia_aberta_no_funil",
      mensagem: COPIA_ABERTA_NO_FUNIL,
    });
    expect(ApiErrorCodes.copia_aberta_no_funil).toBe("copia_aberta_no_funil");
    expect(recusaDeCopiaAbertaPeloBanco(doIndice, "es")?.mensagem).toBe(traduzir(COPIA_ABERTA_NO_FUNIL, "es"));
    expect(traduzir(COPIA_ABERTA_NO_FUNIL, "es")).not.toBe(COPIA_ABERTA_NO_FUNIL);
  });
});
