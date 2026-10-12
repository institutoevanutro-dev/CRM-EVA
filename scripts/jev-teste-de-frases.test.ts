// @vitest-environment node
/**
 * A CONTA DO TESTE DE FRASES, com um Jev de mentira: nenhuma chamada de rede,
 * nenhum banco. O script (`./jev-teste-de-frases.ts`) é só o encanamento.
 */
import { describe, expect, it, vi } from "vitest";

import type { Pergunta, ResultadoDaDecisao } from "../lib/ai/decisao/cliente";

import { FRASES_DE_CLINICA, type Frase } from "./lib/jev-frases-de-clinica";
import {
  medirFrase,
  pontuarClima,
  pontuarPedido,
  relatorio,
  resumirLatencia,
  type Medida,
  type Regra,
} from "./lib/jev-teste-de-frases";

const frase = (texto: string, opt_out: Frase["opt_out"], humano: Frase["humano"], clima: Frase["clima"]): Frase => ({
  texto,
  opt_out,
  humano,
  clima,
});
const REGRA_CEGA: Regra = () => ({ humano: false, opt_out: false });

/** Responde o que foi perguntado, com os números dados. */
function jevDeMentira(numeros: { opt_out?: number; humano?: number; clima?: number }, latenciaMs = 300) {
  return vi.fn(async (_estado: string, perguntas: Record<string, Pergunta>): Promise<ResultadoDaDecisao> => {
    const respostas: Record<string, unknown> = {};
    for (const id of Object.keys(perguntas)) {
      respostas[id] =
        id === "clima"
          ? { tipo: "score", score: numeros.clima ?? 2, probabilidades: {}, confianca: 0.9 }
          : { tipo: "noul", noul: numeros[id as "opt_out" | "humano"] ?? 0 };
    }
    return { ok: true, respostas, modelo: "jev-1.13.0", latenciaMs, uso: { tokensDeEntrada: 100, tokensDeSaida: 0 } } as ResultadoDaDecisao;
  });
}

describe("o fixture", () => {
  it("tem de 60 a 80 frases, sem repetida, com positivos, negativos e ambíguas em cada tarefa", () => {
    expect(FRASES_DE_CLINICA.length).toBeGreaterThanOrEqual(60);
    expect(FRASES_DE_CLINICA.length).toBeLessThanOrEqual(80);
    expect(new Set(FRASES_DE_CLINICA.map((f) => f.texto)).size).toBe(FRASES_DE_CLINICA.length);
    for (const [tarefa, positivo] of [["opt_out", "sim"], ["humano", "sim"], ["clima", "reclamando"]] as const) {
      const rotulos = FRASES_DE_CLINICA.map((f) => f[tarefa] as string);
      expect(rotulos.filter((r) => r === positivo).length, tarefa).toBeGreaterThanOrEqual(10);
      expect(rotulos.filter((r) => r === "ambiguo").length, tarefa).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("medirFrase", () => {
  it("limpa a frase, pergunta o clima sempre e o pedido só onde a regra disse não", async () => {
    const jev = jevDeMentira({ opt_out: 0.95 });
    const regra: Regra = () => ({ humano: true, opt_out: false });
    const m = await medirFrase(frase("meu cpf é 123.456.789-09, me tira daí", "sim", "nao", "ok"), jev, regra);
    const [estado, perguntas] = jev.mock.calls[0]!;
    expect(estado).not.toContain("123.456.789-09");
    expect(Object.keys(perguntas).sort()).toEqual(["clima", "opt_out"]);
    expect(m).toMatchObject({ regra: { humano: true, opt_out: false }, jev: { humano: null, opt_out: 0.95 }, clima: 0.5, falha: null });
  });

  it("falha do Jev vira medida sem resposta, com o motivo", async () => {
    const falhou = async (): Promise<ResultadoDaDecisao> =>
      ({ ok: false, motivo: "provedor_indisponivel", exigeAcao: false, defeitoNosso: false, status: 503 }) as ResultadoDaDecisao;
    const m = await medirFrase(frase("oi", "nao", "nao", "ok"), falhou, REGRA_CEGA);
    expect(m).toMatchObject({ jev: { humano: null, opt_out: null }, clima: null, falha: "provedor_indisponivel" });
  });
});

const medida = (f: Frase, jev: Partial<Medida["jev"]>, extra: Partial<Medida> = {}): Medida => ({
  frase: f,
  regra: { humano: false, opt_out: false },
  jev: { humano: null, opt_out: null, ...jev },
  clima: 0.5,
  latenciaMs: 300,
  falha: null,
  ...extra,
});

describe("pontuarPedido", () => {
  const medidas = [
    medida(frase("pego pelo Jev", "sim", "nao", "ok"), { opt_out: 0.8 }),
    medida(frase("perdido por pouco", "sim", "nao", "ok"), { opt_out: 0.79 }),
    medida(frase("pego pela regra", "sim", "nao", "ok"), {}, { regra: { humano: false, opt_out: true } }),
    medida(frase("alarme falso", "nao", "nao", "ok"), { opt_out: 0.93 }),
    medida(frase("negativo certo", "nao", "nao", "ok"), { opt_out: 0.02 }),
    medida(frase("a regra errou", "nao", "nao", "ok"), {}, { regra: { humano: false, opt_out: true } }),
    medida(frase("sem resposta", "sim", "nao", "ok"), {}, { falha: "limite_de_taxa" }),
    medida(frase("ninguém sabe", "ambiguo", "nao", "ok"), { opt_out: 0.99 }),
  ];

  it("conta pegos, perdidos, alarmes falsos, e separa a regra do Jev", () => {
    const p = pontuarPedido("opt_out", medidas);
    expect(p).toMatchObject({
      acertos: 2,
      acertosDaRegra: 1,
      perdidos: 1,
      alarmesFalsos: 1,
      alarmesFalsosDaRegra: 1,
      negativosCertos: 1,
      semResposta: 1,
    });
    expect(p.erros.map((e) => e.texto)).toEqual(["perdido por pouco", "alarme falso", "a regra errou"]);
    expect(p.ambiguas).toEqual([{ texto: "ninguém sabe", oQue: "Jev 0.99" }]);
  });

  it("o corte é o de cada pedido: 0,85 avisa no parar e não avisa na pessoa", () => {
    const f = frase("x", "sim", "sim", "ok");
    expect(pontuarPedido("opt_out", [medida(f, { opt_out: 0.85 })]).acertos).toBe(1);
    expect(pontuarPedido("humano", [medida(f, { humano: 0.85 })]).perdidos).toBe(1);
    expect(pontuarPedido("humano", [medida(f, { humano: 0.9 })]).acertos).toBe(1);
  });
});

describe("pontuarClima", () => {
  it("sintoma com nota 0,5 não é reclamação; reclamação com 0,25 é", () => {
    const p = pontuarClima([
      medida(frase("estou com muita dor", "nao", "nao", "ok"), {}, { clima: 0.5 }),
      medida(frase("sintoma lido como reclamação", "nao", "nao", "ok"), {}, { clima: 0.25 }),
      medida(frase("péssimo atendimento", "nao", "nao", "reclamando"), {}, { clima: 0.25 }),
      medida(frase("reclamação perdida", "nao", "nao", "reclamando"), {}, { clima: 0.5 }),
      medida(frase("tanto faz", "nao", "nao", "ambiguo"), {}, { clima: 0 }),
      medida(frase("sem nota", "nao", "nao", "ok"), {}, { clima: null }),
    ]);
    expect(p).toMatchObject({ acertos: 1, perdidos: 1, alarmesFalsos: 1, negativosCertos: 1, semResposta: 1 });
    expect(p.erros.map((e) => e.texto)).toEqual(["sintoma lido como reclamação", "reclamação perdida"]);
    expect(p.ambiguas).toHaveLength(1);
  });
});

describe("latência e relatório", () => {
  it("mediana, p95 e máxima só das chamadas que responderam", () => {
    const ms = [100, 200, 300, 400, 1000].map((latenciaMs) => medida(frase(String(latenciaMs), "nao", "nao", "ok"), {}, { latenciaMs }));
    const falha = medida(frase("f", "nao", "nao", "ok"), {}, { falha: "limite_de_taxa", latenciaMs: 9000 });
    expect(resumirLatencia([...ms, falha])).toEqual({ chamadas: 6, falhas: 1, medianaMs: 300, p95Ms: 1000, maxMs: 1000 });
    expect(resumirLatencia([falha])).toMatchObject({ medianaMs: null, p95Ms: null, maxMs: null });
  });

  it("o relatório traz as três tarefas, os erros pelo texto e as falhas pelo motivo", async () => {
    const medidas = [
      await medirFrase(frase("tem como parar a dor?", "nao", "nao", "ok"), jevDeMentira({ opt_out: 0.95 }), REGRA_CEGA),
      medida(frase("f", "nao", "nao", "ok"), {}, { falha: "limite_de_taxa" }),
    ];
    const texto = relatorio(medidas);
    expect(texto).toContain("PARAR DE RECEBER");
    expect(texto).toContain("FALAR COM UMA PESSOA");
    expect(texto).toContain("CLIMA");
    expect(texto).toContain('"tem como parar a dor?": alarme falso (Jev 0.95)');
    expect(texto).toContain("falhas: 1 (limite_de_taxa: 1)");
  });
});
