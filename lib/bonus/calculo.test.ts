import { describe, expect, it } from "vitest";

import {
  avaliarCriterio,
  calcularMes,
  desfechoDaRotina,
  desfechoDaTarefa,
  type EntradaDoMes,
  type FatosDaPessoa,
  fracaoDaFaixa,
  placarDosComparecimentos,
  type TarefaDoMes,
} from "./calculo";
import { regrasSchema, type RegrasDoBonus } from "./regras";

const FAIXAS = regrasSchema.parse({}).tarefas.faixas;
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

function regras(extra: Record<string, unknown> = {}): RegrasDoBonus {
  return regrasSchema.parse({
    participantes: [A, B],
    teto_cents: 40_000,
    tarefas: { valor_cents: 20_000 },
    resultados: {
      comparecimento: { valor_cents: 10_000 },
      sinal_pago: { valor_cents: 6_000 },
      avaliacao_google: { valor_cents: 3_000 },
    },
    metas_por_mes: {
      "2026-12": {
        comparecimento: { basica: 40, alta: 50 },
        sinal_pago: { basica: 10, alta: 14 },
        avaliacao_google: { basica: 4, alta: 6 },
      },
    },
    meses_de_teste: { "2026-11": { garantia_resultados_cents: 7_000 } },
    feriados: ["2026-11-02", "2026-11-20", "2026-12-25"],
    ...extra,
  });
}

const tarefa = (p: Partial<TarefaDoMes>): TarefaDoMes => ({
  id: "t",
  diaDoPrazo: "2026-11-10",
  situacao: "feita",
  diaDoFechamento: "2026-11-10",
  prazoTrocadoAposVencer: false,
  ...p,
});

describe("faixa das tarefas", () => {
  it("100% paga cheio; 9 de 10 (90% exatos) paga metade; 8 de 10 paga zero", () => {
    expect(fracaoDaFaixa(10, 10, FAIXAS)).toBe(10_000);
    expect(fracaoDaFaixa(9, 10, FAIXAS)).toBe(5_000);
    expect(fracaoDaFaixa(8, 10, FAIXAS)).toBe(0);
  });

  it("89,99% não chega a 90%", () => {
    expect(fracaoDaFaixa(8_999, 10_000, FAIXAS)).toBe(0);
  });

  it("99 de 100 é a faixa de 90%, não a cheia", () => {
    expect(fracaoDaFaixa(99, 100, FAIXAS)).toBe(5_000);
  });

  it("faixas fora de ordem dão o mesmo resultado que em ordem", () => {
    const embaralhadas = [...FAIXAS].reverse();
    expect(fracaoDaFaixa(9, 10, embaralhadas)).toBe(fracaoDaFaixa(9, 10, FAIXAS));
    expect(fracaoDaFaixa(7, 10, embaralhadas)).toBe(fracaoDaFaixa(7, 10, FAIXAS));
    expect(fracaoDaFaixa(10, 10, embaralhadas)).toBe(10_000);
  });

  it("nada devido paga a faixa cheia", () => {
    expect(fracaoDaFaixa(0, 0, FAIXAS)).toBe(10_000);
  });
});

describe("desfecho da tarefa", () => {
  const hoje = "2026-11-12";
  it("concluída no dia do prazo é feita; no dia seguinte, não", () => {
    expect(desfechoDaTarefa(tarefa({}), hoje)).toBe("feito");
    expect(desfechoDaTarefa(tarefa({ diaDoFechamento: "2026-11-11" }), hoje)).toBe("nao_feito");
  });
  it("prazo trocado depois de vencido conta como atrasada, mesmo concluída", () => {
    expect(desfechoDaTarefa(tarefa({ prazoTrocadoAposVencer: true }), hoje)).toBe("nao_feito");
  });
  it("cancelada até o prazo sai da conta; cancelada depois é atrasada", () => {
    expect(desfechoDaTarefa(tarefa({ situacao: "cancelada" }), hoje)).toBe("fora");
    expect(desfechoDaTarefa(tarefa({ situacao: "cancelada", diaDoFechamento: "2026-11-11" }), hoje)).toBe("nao_feito");
  });
  it("aberta e vencida é atrasada; aberta com prazo hoje ainda é pendente", () => {
    expect(desfechoDaTarefa(tarefa({ situacao: "aberta", diaDoFechamento: null }), hoje)).toBe("nao_feito");
    expect(desfechoDaTarefa(tarefa({ situacao: "aberta", diaDoFechamento: null, diaDoPrazo: hoje }), hoje)).toBe("pendente");
  });
});

describe("desfecho da rotina", () => {
  it("29 de 30 num dia passado não conta (rotina parcial não vale)", () => {
    expect(desfechoDaRotina(30, 29, "2026-11-10", "2026-11-12")).toBe("nao_feito");
  });
  it("hoje incompleta ainda é pendente", () => {
    expect(desfechoDaRotina(30, 29, "2026-11-12", "2026-11-12")).toBe("pendente");
  });
  it("fila menor que 30: a meta é o tamanho da fila", () => {
    expect(desfechoDaRotina(12, 12, "2026-11-10", "2026-11-12")).toBe("feito");
  });
  it("fila vazia ou dia futuro não pesam", () => {
    expect(desfechoDaRotina(0, 0, "2026-11-10", "2026-11-12")).toBe("fora");
    expect(desfechoDaRotina(30, 0, "2026-11-13", "2026-11-12")).toBe("fora");
  });
});

describe("resultados da dupla", () => {
  const meta = { basica: 40, alta: 50 };
  it("meta alta paga cheio; básica paga metade; abaixo paga zero", () => {
    expect(avaliarCriterio("comparecimento", 50, 10_000, meta)).toMatchObject({ valorCents: 10_000, faixa: "alta" });
    expect(avaliarCriterio("comparecimento", 40, 10_000, meta)).toMatchObject({ valorCents: 5_000, faixa: "basica" });
    expect(avaliarCriterio("comparecimento", 39, 10_000, meta)).toMatchObject({ valorCents: 0, faixa: "nenhuma" });
  });
  it("sem meta no mês, zero; avaliação ainda não lançada, pendente", () => {
    expect(avaliarCriterio("sinal_pago", 99, 6_000, undefined)).toMatchObject({ valorCents: 0, faixa: "sem_meta" });
    expect(avaliarCriterio("avaliacao_google", null, 3_000, meta)).toMatchObject({ valorCents: 0, faixa: "pendente" });
  });
  it("meta alta 0 (critério que ninguém preencheu) nunca paga", () => {
    expect(avaliarCriterio("sinal_pago", 0, 6_000, { basica: 0, alta: 0 })).toMatchObject({
      valorCents: 0,
      faixa: "sem_meta",
      basica: null,
      alta: null,
    });
  });
});

/** Um mês inteiro feito por uma pessoa: todas as rotinas de todos os dias úteis. */
function mesPerfeito(userId: string, dias: string[]): FatosDaPessoa {
  return {
    userId,
    tarefas: [tarefa({ id: `${userId}-t1`, diaDoPrazo: dias[0], diaDoFechamento: dias[0] })],
    leads: dias.map((dia) => ({ dia, meta: 30, feitos: 30 })),
    ligacoes: dias.map((dia) => ({ dia, meta: 5, feitos: 5 })),
    diasDeExcecao: [],
  };
}

const DEZEMBRO_UTEIS = ["2026-12-01", "2026-12-02", "2026-12-03"];

function entrada(p: Partial<EntradaDoMes>): EntradaDoMes {
  return {
    mes: "2026-12",
    hoje: "2026-12-04",
    inicioDoPrograma: null,
    regras: regras(),
    pessoas: [mesPerfeito(A, DEZEMBRO_UTEIS), mesPerfeito(B, DEZEMBRO_UTEIS)],
    storiesPorDia: Object.fromEntries(DEZEMBRO_UTEIS.map((d) => [d, 2])),
    resultados: { comparecimento: 50, sinal_pago: 10, avaliacao_google: null },
    ...p,
  };
}

describe("calcularMes", () => {
  it("stories são da dupla: os dois ganham o item no mesmo dia", () => {
    const placar = calcularMes(entrada({}));
    for (const p of placar.pessoas) {
      expect(p.tarefas.naoFeitos.filter((i) => i.tipo === "stories")).toEqual([]);
      // 1 tarefa + 3 dias × (leads + ligações + stories) = 10 itens devidos
      expect(p.tarefas.devidos).toBe(10);
    }
  });

  it("um story a menos num dia derruba a faixa dos dois (9 de 10 → metade)", () => {
    const placar = calcularMes(entrada({ storiesPorDia: { "2026-12-01": 2, "2026-12-02": 1, "2026-12-03": 2 } }));
    for (const p of placar.pessoas) {
      expect(p.tarefas.feitos).toBe(9);
      expect(p.tarefas.fracaoBps).toBe(5_000);
      expect(p.tarefas.valorCents).toBe(10_000);
    }
  });

  it("exceção da pessoa A tira o dia só dela", () => {
    const comFerias = { ...mesPerfeito(A, DEZEMBRO_UTEIS), diasDeExcecao: ["2026-12-02"] };
    comFerias.leads = comFerias.leads.map((r) => (r.dia === "2026-12-02" ? { ...r, feitos: 0 } : r));
    const placar = calcularMes(entrada({ pessoas: [comFerias, mesPerfeito(B, DEZEMBRO_UTEIS)] }));
    const a = placar.pessoas.find((p) => p.userId === A)!;
    const b = placar.pessoas.find((p) => p.userId === B)!;
    expect(a.tarefas.devidos).toBe(7);
    expect(a.tarefas.percentualBps).toBe(10_000);
    expect(b.tarefas.devidos).toBe(10);
  });

  describe("programa ligado no meio do mês", () => {
    // 2026-03: dias úteis 2..13 antes do início (14 é sábado, 15 segunda), 15..19 depois
    const ANTES = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13"];
    const DEPOIS = ["2026-03-16", "2026-03-17", "2026-03-18", "2026-03-19", "2026-03-20"];
    const pessoa = (): FatosDaPessoa => ({
      userId: A,
      tarefas: [],
      leads: [...ANTES.map((dia) => ({ dia, meta: 30, feitos: 0 })), ...DEPOIS.map((dia) => ({ dia, meta: 30, feitos: 30 }))],
      ligacoes: [...ANTES.map((dia) => ({ dia, meta: 5, feitos: 0 })), ...DEPOIS.map((dia) => ({ dia, meta: 5, feitos: 5 }))],
      diasDeExcecao: [],
    });
    const base = (inicioDoPrograma: string | null) =>
      entrada({
        mes: "2026-03",
        hoje: "2026-03-21",
        inicioDoPrograma,
        pessoas: [pessoa()],
        storiesPorDia: Object.fromEntries(DEPOIS.map((d) => [d, 2])),
      });

    it("dias antes do início saem de leads, ligações e stories", () => {
      const p = calcularMes(base("2026-03-15")).pessoas[0]!;
      expect(p.tarefas.naoFeitos.filter((i) => i.ref < "2026-03-15")).toEqual([]);
      expect(p.tarefas.fracaoBps).toBe(10_000);
    });

    it("sem início (null) o comportamento antigo vale: os dias anteriores contam como não feitos", () => {
      const p = calcularMes(base(null)).pessoas[0]!;
      expect(p.tarefas.naoFeitos.some((i) => i.tipo === "stories" && i.ref < "2026-03-15")).toBe(true);
      expect(p.tarefas.fracaoBps).toBeLessThan(10_000);
    });
  });

  it("feriado não gera rotina para ninguém", () => {
    const placar = calcularMes(
      entrada({
        mes: "2026-12",
        hoje: "2026-12-26",
        pessoas: [{ userId: A, tarefas: [], leads: [{ dia: "2026-12-25", meta: 30, feitos: 0 }], ligacoes: [], diasDeExcecao: [] }],
        storiesPorDia: {},
      }),
    );
    expect(placar.pessoas[0]!.tarefas.naoFeitos.some((i) => i.ref === "2026-12-25")).toBe(false);
  });

  it("resultados somam as faixas; avaliação pendente vale zero", () => {
    const placar = calcularMes(entrada({}));
    // comparecimento 50 (alta: 10000) + sinal 10 (básica: 3000) + avaliação pendente (0)
    expect(placar.resultadosCents).toBe(13_000);
    expect(placar.pessoas[0]!.totalCents).toBe(20_000 + 13_000);
  });

  it("mês de teste: a garantia SUBSTITUI os resultados, seja qual for a contagem", () => {
    const placar = calcularMes(
      entrada({
        mes: "2026-11",
        hoje: "2026-11-05",
        pessoas: [],
        storiesPorDia: {},
        resultados: { comparecimento: 0, sinal_pago: 0, avaliacao_google: null },
      }),
    );
    expect(placar.mesDeTeste).toBe(true);
    expect(placar.resultadosCents).toBe(7_000);
  });

  it("o teto corta o total", () => {
    const placar = calcularMes(entrada({ regras: regras({ teto_cents: 20_000 }) }));
    expect(placar.pessoas[0]!.totalCents).toBe(20_000);
  });

  it("tarefa de outro mês não entra", () => {
    const fora = { ...mesPerfeito(A, DEZEMBRO_UTEIS), tarefas: [tarefa({ id: "x", diaDoPrazo: "2026-11-30", diaDoFechamento: "2026-12-02" })] };
    const placar = calcularMes(entrada({ pessoas: [fora] }));
    expect(placar.pessoas[0]!.tarefas.devidos).toBe(9);
  });
});

describe("bônus por comparecimento", () => {
  const regra = regrasSchema.parse({
    comparecimentos: {
      por_mensagem_cents: 1_000,
      por_ligacao_cents: 2_000,
      faixas: [
        { minimo: 15, valor_cents: 15_000 },
        { minimo: 10, valor_cents: 10_000 },
        { minimo: 20, valor_cents: 25_000 },
      ],
    },
  }).comparecimentos;
  const so = (mensagem: number, ligacao = 0) => placarDosComparecimentos({ mensagem, ligacao }, regra);

  it("padrão: dinheiro zero e limiares 10/15/20", () => {
    const r = regrasSchema.parse({}).comparecimentos;
    expect(r).toEqual({
      por_mensagem_cents: 0,
      por_ligacao_cents: 0,
      faixas: [
        { minimo: 10, valor_cents: 0 },
        { minimo: 15, valor_cents: 0 },
        { minimo: 20, valor_cents: 0 },
      ],
    });
    expect(placarDosComparecimentos({ mensagem: 30, ligacao: 5 }, r).valorCents).toBe(0);
  });

  it("9 não chega à primeira faixa: só o fixo, faltam 1", () => {
    const p = so(9);
    expect(p).toMatchObject({ total: 9, fixoCents: 9_000, faixasCents: 0, faixaAtingida: null, valorCents: 9_000 });
    expect(p.proximaFaixa).toEqual({ minimo: 10, valorCents: 10_000, faltam: 1 });
  });

  it("10 paga a primeira faixa", () => {
    expect(so(10)).toMatchObject({ faixasCents: 10_000, faixaAtingida: 10, valorCents: 20_000, proximaFaixa: { minimo: 15, faltam: 5 } });
  });

  it("15 soma as duas primeiras (cumulativo)", () => {
    expect(so(15)).toMatchObject({ faixasCents: 25_000, faixaAtingida: 15, valorCents: 40_000 });
  });

  it("20 soma as três: R$ 500 de faixas, sem próxima", () => {
    const p = so(20);
    expect(p).toMatchObject({ faixasCents: 50_000, faixaAtingida: 20, valorCents: 70_000 });
    expect(p.proximaFaixa).toBeNull();
  });

  it("mistura de canais: ligação vale o dobro e a faixa conta o total", () => {
    const p = so(6, 4);
    expect(p).toMatchObject({ mensagem: 6, ligacao: 4, total: 10, fixoCents: 6_000 + 8_000, faixasCents: 10_000, valorCents: 24_000 });
  });

  it("entra no total da pessoa, somado às tarefas, e o teto corta", () => {
    const base = regras({ comparecimentos: { por_mensagem_cents: 1_000, por_ligacao_cents: 2_000, faixas: [] } });
    const pessoa: FatosDaPessoa = { userId: A, tarefas: [], leads: [], ligacoes: [], diasDeExcecao: [], comparecimentos: { mensagem: 3, ligacao: 1 } };
    const e = entrada({ mes: "2026-10", hoje: "2026-10-31", regras: { ...base, rotinas: { ...base.rotinas, stories_por_dia: 0 } }, pessoas: [pessoa], storiesPorDia: {} });
    const p = calcularMes(e).pessoas[0]!;
    expect(p.comparecimentos.valorCents).toBe(5_000);
    expect(p.totalCents).toBe(p.tarefas.valorCents + p.resultadosCents + 5_000);
    const comTeto = calcularMes({ ...e, regras: { ...e.regras, teto_cents: 1_000 } }).pessoas[0]!;
    expect(comTeto.totalCents).toBe(1_000);
  });

  it("pessoa sem contagem conta zero", () => {
    const p = calcularMes(entrada({})).pessoas[0]!;
    expect(p.comparecimentos.total).toBe(0);
  });
});
