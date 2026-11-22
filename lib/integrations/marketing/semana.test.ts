import { describe, expect, it, vi } from "vitest";
import { consultaSemana } from "./semana";

function adminFalso(respostas: Record<string, unknown>) {
  return { rpc: vi.fn(async (nome: string) => ({ data: respostas[nome], error: null })) } as never;
}
const SEMANA = { mensagens: [{ via: "ai", mensagens: 10, conversas: 4 }], recebidas: 30,
  agenda: { criados: 5, realizados: 3, faltas: 1, cancelados: 0 }, quem_marcou: [{ nome: "Atendente virtual", total: 2 }] };
const ORG = "00000000-0000-4000-8000-000000000001";

describe("consultaSemana", () => {
  it("junta as três consultas e agrupa a origem pelo rótulo", async () => {
    const admin = adminFalso({
      fn_marketing_semana: SEMANA,
      fn_inicio_atendimento: { ia_sozinha: 4, com_equipe: 6, sem_resposta: 1, mediana_primeira_resposta_s: 24.5 },
      fn_inicio_origem: [{ origem: "meta_ads", utm_source: null, total: 3 }, { origem: "whatsapp", utm_source: null, total: 7 }, { origem: "google_ads", utm_source: "x", total: 2 }],
    });
    const s = await consultaSemana(admin, ORG, "2026-11-17", "2026-11-23");
    expect(s.contatos_novos.total).toBe(12);
    expect(s.contatos_novos.por_origem[0]?.total).toBe(7);
    expect(s.atendimento.mediana_primeira_resposta_s).toBe(24.5);
    expect(s.agenda.criados).toBe(5);
    expect(s.financeiro).toBeNull();
    expect(s.financeiro_indisponivel).toBe(false);
    const chamada = (admin as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc.mock.calls.find((c) => c[0] === "fn_marketing_semana")!;
    expect(chamada[1]).toMatchObject({ p_inicio: "2026-11-17T03:00:00.000Z", p_fim: "2026-11-24T03:00:00.000Z" });
  });
  it("Financeiro fora do ar não derruba a semana: financeiro vira null", async () => {
    const admin = adminFalso({ fn_marketing_semana: SEMANA, fn_inicio_atendimento: {}, fn_inicio_origem: [] });
    const fin = vi.fn(async () => { throw new Error("fora"); });
    const s = await consultaSemana(admin, ORG, "2026-11-17", "2026-11-23", fin);
    expect(s.financeiro).toBeNull();
    // ligado mas fora do ar: o Marketing precisa saber, para não mandar o PDF sem vendas como se não houvesse Financeiro
    expect(s.financeiro_indisponivel).toBe(true);
  });
  it("erro do banco lança (o endpoint responde 503, nunca zeros)", async () => {
    const admin = { rpc: vi.fn(async () => ({ data: null, error: { message: "x" } })) } as never;
    await expect(consultaSemana(admin, ORG, "2026-11-17", "2026-11-23")).rejects.toThrow();
  });
});
