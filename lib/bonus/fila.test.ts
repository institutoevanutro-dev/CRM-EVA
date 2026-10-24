import { describe, expect, it } from "vitest";

import { regrasSchema } from "./regras";
import {
  deveMontarAgora,
  historicoDeEnvio,
  type ItemDaFila,
  itensEnviados,
  rotinasDaPessoa,
  tamanhoDaFilaDeLeads,
} from "./fila";

const SP = "America/Sao_Paulo";
const A = "pessoa-a";
const B = "pessoa-b";

const item = (p: Partial<ItemDaFila>): ItemDaFila => ({
  id: "i1",
  dia: "2026-11-03",
  tipo: "lead_antigo",
  userId: A,
  contactId: "c1",
  ligacaoRegistradaEm: null,
  ...p,
});

describe("mensagem enviada pela fila", () => {
  it("conta a mensagem da MESMA pessoa ao MESMO contato no MESMO dia local", () => {
    const itens = [item({ id: "i1" }), item({ id: "i2", contactId: "c2" })];
    const enviados = itensEnviados(
      itens,
      [
        { contactId: "c1", userId: A, sentAt: "2026-11-03T13:00:00Z" },
        { contactId: "c2", userId: B, sentAt: "2026-11-03T13:00:00Z" }, // outra pessoa: não vale
      ],
      SP,
    );
    expect([...enviados]).toEqual(["i1"]);
  });

  it("22h30 em São Paulo (01h30 UTC do dia seguinte) é o MESMO dia", () => {
    const enviados = itensEnviados([item({})], [{ contactId: "c1", userId: A, sentAt: "2026-11-04T01:30:00Z" }], SP);
    expect(enviados.has("i1")).toBe(true);
  });

  it("mensagem do dia seguinte não completa a fila de ontem", () => {
    const enviados = itensEnviados([item({})], [{ contactId: "c1", userId: A, sentAt: "2026-11-04T12:00:00Z" }], SP);
    expect(enviados.size).toBe(0);
  });
});

describe("rotinas da pessoa", () => {
  it("meta = tamanho da fila do dia; feitos = enviados (leads) ou registradas (ligações)", () => {
    const itens = [
      item({ id: "l1" }),
      item({ id: "l2", contactId: "c2" }),
      item({ id: "g1", tipo: "ligacao", contactId: "c3", ligacaoRegistradaEm: "2026-11-03T15:00:00Z" }),
      item({ id: "g2", tipo: "ligacao", contactId: "c4" }),
      item({ id: "x", userId: B, contactId: "c5" }),
    ];
    expect(rotinasDaPessoa(itens, new Set(["l1"]), A)).toEqual({
      leads: [{ dia: "2026-11-03", meta: 2, feitos: 1 }],
      ligacoes: [{ dia: "2026-11-03", meta: 2, feitos: 1 }],
    });
  });
});

describe("proteção do número", () => {
  const regras = regrasSchema.parse({});
  const dia = (d: string, enviados: number, pedidos: number) => ({ dia: d, enviados, pedidosParaParar: pedidos });

  it("acima de 5% em 3 dias seguidos, a fila de amanhã cai pela metade", () => {
    const h = [dia("2026-11-03", 60, 4), dia("2026-11-04", 60, 4), dia("2026-11-05", 60, 4)];
    expect(tamanhoDaFilaDeLeads(regras, h)).toEqual({ tamanho: 15, reduzida: true });
  });

  it("5% exatos não é PASSAR do limite", () => {
    const h = [dia("2026-11-03", 60, 3), dia("2026-11-04", 60, 3), dia("2026-11-05", 60, 3)];
    expect(tamanhoDaFilaDeLeads(regras, h).reduzida).toBe(false);
  });

  it("dois dias ruins e um bom não reduzem; dia sem envio é pulado", () => {
    const h = [dia("2026-11-02", 0, 0), dia("2026-11-03", 60, 9), dia("2026-11-04", 60, 0), dia("2026-11-05", 60, 9)];
    expect(tamanhoDaFilaDeLeads(regras, h).reduzida).toBe(false);
  });

  it("menos de 3 dias de histórico não reduz", () => {
    expect(tamanhoDaFilaDeLeads(regras, [dia("2026-11-03", 60, 30)]).reduzida).toBe(false);
  });

  it("pedido para parar conta se o bloqueio veio até 48h depois do início do dia", () => {
    const itens = [item({ id: "i1" }), item({ id: "i2", contactId: "c2" }), item({ id: "i3", contactId: "c3" })];
    const bloqueio = new Map([
      ["c1", "2026-11-04T20:00:00Z"], // dentro de 48h
      ["c2", "2026-11-06T12:00:00Z"], // fora
    ]);
    expect(historicoDeEnvio(itens, new Set(["i1", "i2"]), bloqueio, SP)).toEqual([
      { dia: "2026-11-03", enviados: 2, pedidosParaParar: 1 },
    ]);
  });
});

describe("hora de montar a fila", () => {
  it("a partir da hora da regra e antes do meio-dia", () => {
    expect(deveMontarAgora(6, 7)).toBe(false);
    expect(deveMontarAgora(7, 7)).toBe(true);
    expect(deveMontarAgora(11, 7)).toBe(true);
    expect(deveMontarAgora(12, 7)).toBe(false);
  });
});
