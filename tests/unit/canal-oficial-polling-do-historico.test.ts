import { describe, expect, it } from "vitest";

import { intervaloDoHistorico } from "@/hooks/channels/useOfficialChannel";

const base = { onboarding_em: "2026-10-01T00:00:00Z", pedidos: { contatos: null, historico: { request_id: "r" } as { request_id: string } | null } };
const T0 = 1_000_000;

function chamar(coex: Parameters<typeof intervaloDoHistorico>[0], marca = { visto: "", desde: 0 }, agora = T0) {
  let gravada = marca;
  const r = intervaloDoHistorico(coex, marca, agora, (m) => (gravada = m));
  return { r, gravada };
}

describe("intervaloDoHistorico", () => {
  it("pedido com request_id e histórico ainda nulo: continua lendo", () => {
    expect(chamar({ ...base, historico: null }).r).toBe(5_000);
  });
  it("sem request_id e sem histórico: não lê", () => {
    expect(chamar({ ...base, pedidos: { contatos: null, historico: null }, historico: null }).r).toBe(false);
  });
  it("sem coexistência: não lê", () => {
    expect(chamar(null).r).toBe(false);
  });
  it("em andamento lê; concluído ou com erro para", () => {
    expect(chamar({ ...base, historico: { fase: 1, progresso: 20, concluido: false, erro_codigo: null } }).r).toBe(5_000);
    expect(chamar({ ...base, historico: { fase: 2, progresso: 100, concluido: true, erro_codigo: null } }).r).toBe(false);
    expect(chamar({ ...base, historico: { fase: null, progresso: null, concluido: false, erro_codigo: 1 } }).r).toBe(false);
  });
  it("teto de 30 min sem mudança de progresso, também esperando o primeiro pedaço", () => {
    const { gravada } = chamar({ ...base, historico: null });
    expect(chamar({ ...base, historico: null }, gravada, T0 + 31 * 60_000).r).toBe(false);
  });
});
