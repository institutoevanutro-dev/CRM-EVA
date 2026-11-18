/**
 * A prévia e a preparação deixam de fora quem já recebeu a campanha de onde
 * esta foi duplicada (decisão do André, 18/11/2026) — com o motivo, para a tela
 * dizer quantos.
 */
import { describe, expect, it, vi } from "vitest";

import { FILTRO_VAZIO } from "./audiencia";

const ORIGINAL = "cccccccc-0000-4000-8000-000000000001";
const consultas = vi.hoisted(() => ({ jaReceberam: vi.fn() }));

vi.mock("./consulta-de-audiencia", () => ({
  buscarCandidatos: vi.fn(async () =>
    ["a", "b", "c"].map((id, i) => ({
      contactId: id,
      nome: `Pessoa Fictícia ${i}`,
      telefone: `+552799000000${i}`,
      bloqueado: false,
      anonimizado: false,
      oculto: false,
      recusouMarketing: false,
    })),
  ),
  contatosJaEmCampanha: vi.fn(async () => new Set()),
  contatosQueReceberam: consultas.jaReceberam,
}));
vi.mock("./exclusoes", () => ({ hashesExcluidos: vi.fn(async () => new Set()), hashDoEndereco: (e: string) => e }));

const { preverAudiencia } = await import("./preparacao");

describe("prévia de uma cópia", () => {
  it("quem já recebeu a original fica de fora, contado pelo motivo", async () => {
    consultas.jaReceberam.mockResolvedValue(new Set(["a", "c"]));

    const r = await preverAudiencia({} as never, {
      organizationId: "org",
      filtro: { ...FILTRO_VAZIO, com_alguma_tag: ["retorno"], sem_quem_recebeu_campanhas: [ORIGINAL] },
      corpo: "Oi!",
      agora: new Date("2026-11-18T12:00:00.000Z"),
    });

    expect(consultas.jaReceberam).toHaveBeenCalledWith(expect.anything(), "org", [ORIGINAL]);
    expect(r.elegiveis).toBe(1);
    expect(r.motivos).toEqual({ ja_recebeu_a_original: 2 });
  });
});
