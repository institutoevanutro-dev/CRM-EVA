/**
 * Quem já recebeu a campanha original fica de fora da cópia (decisão do André,
 * 18/11/2026). A leitura pagina: o PostgREST corta em 1.000 linhas sem avisar,
 * e a cópia voltaria a falar com quem recebeu depois do milésimo.
 */
import { describe, expect, it } from "vitest";

import { supabaseEmMemoria } from "@/tests/helpers/supabase-em-memoria";

import { contatosQueReceberam } from "./consulta-de-audiencia";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const ORIGINAL = "cccccccc-0000-4000-8000-000000000001";

describe("contatosQueReceberam", () => {
  it("lê todos os que receberam, além das 1.000 linhas, e só os que receberam", async () => {
    const recebeu = Array.from({ length: 1500 }, (_, i) => ({
      id: `r${String(i).padStart(5, "0")}`,
      organization_id: ORG,
      campaign_id: ORIGINAL,
      contact_id: `k${i}`,
      sent_at: "2026-11-17T12:00:00.000Z",
    }));
    const banco = supabaseEmMemoria(
      {
        campaign_recipients: [
          ...recebeu,
          { id: "x1", organization_id: ORG, campaign_id: ORIGINAL, contact_id: "nao-saiu", sent_at: null },
          { id: "x2", organization_id: "outra", campaign_id: ORIGINAL, contact_id: "outra-org", sent_at: "2026-11-17T12:00:00.000Z" },
        ],
      },
      { maxRows: 1000 },
    );

    const ids = await contatosQueReceberam(banco.cliente as never, ORG, [ORIGINAL]);

    expect(ids.size).toBe(1500);
    expect(ids.has("nao-saiu")).toBe(false);
    expect(ids.has("outra-org")).toBe(false);
  });

  it("sem origem, não consulta nada", async () => {
    const banco = supabaseEmMemoria({});
    expect((await contatosQueReceberam(banco.cliente as never, ORG, [])).size).toBe(0);
    expect(banco.cliente.from).not.toHaveBeenCalled();
  });
});
