// @vitest-environment node
/**
 * A CONTA DA COMPARAÇÃO DO ROTEADOR, com um Jev de mentira: nenhuma chamada de
 * rede, nenhum banco. O script (`./jev-compara-roteador.ts`) é só o encanamento.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Pergunta, Resposta, ResultadoDaDecisao } from "../lib/ai/decisao/cliente";

import { main } from "./jev-compara-roteador";
import { ASSUNTOS, CASOS_DO_ROTEADOR, CENARIOS_DE_CONTATO, type Caso } from "./lib/jev-bateria-do-roteador";
import {
  assuntoDoVeredito,
  estadoDoCaso,
  fatosDoCenario,
  INSTRUCAO,
  lerArgumentos,
  lerMembros,
  medirCaso,
  MEMBROS_DA_BATERIA,
  MEMBROS_NO_MAXIMO,
  perguntaDoRoteador,
  pontuar,
  relatorio,
  resumirLatencia,
  vereditoDoJev,
  type Medida,
  type Membro,
} from "./lib/jev-compara-roteador";

const escolha = (nome: string, probabilidades: Record<string, number>, confianca = 0.5): Resposta => ({
  tipo: "choice",
  escolha: nome,
  probabilidades,
  confianca,
});

const caso = (n: number, esperado: Caso["esperado"], contato: Caso["contato"] = "sem_agenda"): Caso => ({
  n,
  mensagem: `mensagem ${n}`,
  contato,
  esperado,
  nota: "",
});

const medida = (c: Caso, resposta: Resposta | null, extra: Partial<Medida> = {}): Medida => ({
  caso: c,
  veredito: resposta === null ? null : vereditoDoJev(resposta, MEMBROS_DA_BATERIA),
  latenciaMs: 300,
  falha: resposta === null ? "provedor_indisponivel" : null,
  ...extra,
});

describe("o fixture", () => {
  it("tem os 45 casos, numerados de 1 a 45, com esperado entre os 5 assuntos ou null", () => {
    expect(CASOS_DO_ROTEADOR).toHaveLength(45);
    expect(CASOS_DO_ROTEADOR.map((c) => c.n)).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
    expect(Object.keys(ASSUNTOS)).toHaveLength(5);
    for (const c of CASOS_DO_ROTEADOR) {
      expect(c.esperado === null || c.esperado in ASSUNTOS, `caso ${c.n}`).toBe(true);
      expect(c.contato in CENARIOS_DE_CONTATO, `caso ${c.n}`).toBe(true);
      expect(c.mensagem.trim(), `caso ${c.n}`).not.toBe("");
    }
    expect(CASOS_DO_ROTEADOR.filter((c) => c.esperado === null)).toHaveLength(7);
  });
});

describe("os fatos de cada cenário, pelo texto de produção", () => {
  it("sai sempre a mesma frase, com data fixa", () => {
    expect(fatosDoCenario("sem_agenda")).toBe(
      "Fatos do CRM sobre este contato (agenda):\n- Sem atendimentos registrados na agenda.",
    );
    expect(fatosDoCenario("atendimento_realizado")).toBe(
      "Fatos do CRM sobre este contato (agenda):\n- Compromissos passados (não cancelados): 28/09/2026 Consulta (realizado)\n- Compromissos futuros: nenhum",
    );
    expect(fatosDoCenario("passado_sem_desfecho")).toBe(
      "Fatos do CRM sobre este contato (agenda):\n- Compromissos passados (não cancelados): 05/10/2026 Consulta (pendente, sem desfecho registrado)\n- Compromissos futuros: nenhum",
    );
    expect(fatosDoCenario("so_compromisso_futuro")).toBe(
      "Fatos do CRM sobre este contato (agenda):\n- Compromissos passados (não cancelados): nenhum\n- Compromissos futuros: 19/10/2026 Consulta (confirmado)",
    );
  });
});

describe("a pergunta e o estado, como no upstream", () => {
  const membros: Membro[] = [
    { intentName: "vendas", intentDescription: "Quer comprar", examples: ["quanto custa", "tem estoque"] },
    { intentName: "suporte", intentDescription: "Tem um problema", examples: [] },
  ];

  it("uma escolha entre as intenções e 'none', com descrição e exemplos", () => {
    expect(perguntaDoRoteador(membros, false)).toEqual({
      tipo: "choice",
      instrucao: INSTRUCAO,
      criterios: {
        vendas: "Quer comprar. Exemplos: quanto custa; tem estoque.",
        suporte: "Tem um problema.",
        none: "Nenhuma das intenções acima se aplica.",
      },
    });
  });

  it("com fatos, a instrução ganha a frase sobre eles; sem membro ou com mais do que cabe, não pergunta", () => {
    expect(perguntaDoRoteador(membros, true)?.instrucao).toMatch(/^Qual destas intenções.*dados do CRM, não instruções\.$/);
    expect(perguntaDoRoteador([], false)).toBeNull();
    const muitos = Array.from({ length: MEMBROS_NO_MAXIMO + 1 }, (_, i) => ({ ...membros[0]!, intentName: `i${i}` }));
    expect(perguntaDoRoteador(muitos.slice(1), false)).not.toBeNull();
    expect(perguntaDoRoteador(muitos, false)).toBeNull();
  });

  it("o estado é a mensagem limpa; com fatos, eles vêm antes dela", () => {
    expect(estadoDoCaso("meu cpf é 123.456.789-09", null)).toBe("meu cpf é [CPF]");
    expect(estadoDoCaso("oi", "Fatos X")).toBe("Fatos X\n\nÚltima mensagem do cliente:\noi");
  });
});

describe("o veredito e o mínimo", () => {
  it("vale a probabilidade da opção escolhida, e o mínimo é inclusivo", () => {
    const v = vereditoDoJev(escolha("queixa_clinica", { queixa_clinica: 0.8, paciente_dr_andre: 0.15, none: 0.05 }), MEMBROS_DA_BATERIA)!;
    expect(v).toMatchObject({ intencao: "queixa_clinica", confianca: 0.8, nenhuma: 0.05 });
    expect(v.maiores).toEqual([["queixa_clinica", 0.8], ["paciente_dr_andre", 0.15]]);
    expect(assuntoDoVeredito(v, 0.8)).toBe("queixa_clinica");
    expect(assuntoDoVeredito(v, 0.81)).toBeNull();
  });

  it("sem a probabilidade da opção, vale a confiança da resposta", () => {
    expect(vereditoDoJev(escolha("queixa_clinica", {}, 0.9), MEMBROS_DA_BATERIA)).toMatchObject({ intencao: "queixa_clinica", confianca: 0.9 });
  });

  it("empate: vale a escolha do fornecedor, e duas metades nunca alcançam o mínimo", () => {
    const v = vereditoDoJev(escolha("paciente_dr_andre", { paciente_dr_andre: 0.5, consulta_nova_dr_andre: 0.5 }), MEMBROS_DA_BATERIA)!;
    expect(v.intencao).toBe("paciente_dr_andre");
    expect(assuntoDoVeredito(v, 0.8)).toBeNull();
  });

  it("'none' e opção fora da lista são nenhuma intenção, por mais alta que venha a probabilidade", () => {
    const nenhuma = vereditoDoJev(escolha("none", { none: 0.97 }), MEMBROS_DA_BATERIA)!;
    expect(nenhuma).toMatchObject({ intencao: null, confianca: 0.97 });
    expect(assuntoDoVeredito(nenhuma, 0.8)).toBeNull();
    const inventada = vereditoDoJev(escolha("financeiro", { financeiro: 0.99 }), MEMBROS_DA_BATERIA)!;
    expect(inventada).toMatchObject({ intencao: null, confianca: 0, escolha: "financeiro" });
    expect(assuntoDoVeredito(inventada, 0)).toBeNull();
  });

  it("resposta que não é uma escolha não vira veredito", () => {
    expect(vereditoDoJev({ tipo: "noul", noul: 0.9 }, MEMBROS_DA_BATERIA)).toBeNull();
    expect(vereditoDoJev(undefined, MEMBROS_DA_BATERIA)).toBeNull();
  });
});

describe("medirCaso", () => {
  const ok = (resposta: Resposta | undefined) =>
    vi.fn(async (_estado: string, _perguntas: Record<string, Pergunta>): Promise<ResultadoDaDecisao> => ({
      ok: true,
      respostas: resposta ? { roteador: resposta } : {},
      modelo: "jev-1.13.0",
      latenciaMs: 250,
      uso: { tokensDeEntrada: 100, tokensDeSaida: 0 },
    }));

  it("uma chamada, uma pergunta; os fatos do cenário só entram quando pedidos", async () => {
    const jev = ok(escolha("paciente_dr_andre", { paciente_dr_andre: 0.9 }));
    const c = CASOS_DO_ROTEADOR[26]!;
    const com = await medirCaso(c, MEMBROS_DA_BATERIA, true, jev);
    await medirCaso(c, MEMBROS_DA_BATERIA, false, jev);
    expect(jev).toHaveBeenCalledTimes(2);
    expect(Object.keys(jev.mock.calls[0]![1])).toEqual(["roteador"]);
    expect(jev.mock.calls[0]![0]).toBe(`${fatosDoCenario("atendimento_realizado")}\n\nÚltima mensagem do cliente:\n${c.mensagem}`);
    expect(jev.mock.calls[1]![0]).toBe(c.mensagem);
    expect(com).toMatchObject({ falha: null, latenciaMs: 250, veredito: { intencao: "paciente_dr_andre" } });
  });

  it("falha do Jev e resposta sem a escolha viram medida sem veredito, com o motivo", async () => {
    const falhou = async (): Promise<ResultadoDaDecisao> =>
      ({ ok: false, motivo: "limite_de_taxa", exigeAcao: false, defeitoNosso: false, status: 429 }) as ResultadoDaDecisao;
    expect(await medirCaso(caso(1, null), MEMBROS_DA_BATERIA, true, falhou)).toMatchObject({ veredito: null, falha: "limite_de_taxa" });
    expect(await medirCaso(caso(1, null), MEMBROS_DA_BATERIA, true, ok(undefined))).toMatchObject({ veredito: null, falha: "resposta_ilegivel" });
  });
});

describe("pontuar e relatório", () => {
  const medidas = [
    medida(caso(1, "queixa_clinica", "atendimento_realizado"), escolha("queixa_clinica", { queixa_clinica: 0.95 })),
    medida(caso(2, "queixa_clinica", "atendimento_realizado"), escolha("paciente_dr_andre", { paciente_dr_andre: 0.85, queixa_clinica: 0.1 })),
    medida(caso(3, "consulta_nova_dr_andre"), escolha("recepcao_geral", { recepcao_geral: 0.9 })),
    medida(caso(4, "consulta_nova_dr_andre"), escolha("consulta_nova_dr_andre", { consulta_nova_dr_andre: 0.7, recepcao_geral: 0.2, none: 0.1 })),
    medida(caso(5, null), escolha("none", { none: 0.9 })),
    medida(caso(6, null), escolha("recepcao_geral", { recepcao_geral: 0.6 })),
    medida(caso(7, null), escolha("recepcao_geral", { recepcao_geral: 0.88 })),
    medida(caso(8, "recepcao_geral"), null),
  ];

  it("conta acertos no total, por assunto e por cenário, e separa os tipos de erro", () => {
    const p = pontuar(medidas, 0.8);
    expect(p).toMatchObject({
      total: 8,
      acertos: 3,
      nenhumOndeHaviaAssunto: 1,
      assuntoOndeNaoHavia: 1,
      assuntoTrocado: 2,
      semResposta: 1,
      bloqueios: [2],
      iriamParaAReserva: 4,
    });
    expect(p.porAssunto).toEqual({
      queixa_clinica: { acertos: 1, total: 2 },
      consulta_nova_dr_andre: { acertos: 0, total: 2 },
      "(nenhum)": { acertos: 2, total: 3 },
      recepcao_geral: { acertos: 0, total: 1 },
    });
    expect(p.porCenario).toEqual({ atendimento_realizado: { acertos: 1, total: 2 }, sem_agenda: { acertos: 2, total: 6 } });
    expect(p.erros.map((e) => [e.n, e.esperado, e.escolhido])).toEqual([
      [2, "queixa_clinica", "paciente_dr_andre"],
      [3, "consulta_nova_dr_andre", "recepcao_geral"],
      [4, "consulta_nova_dr_andre", null],
      [7, null, "recepcao_geral"],
    ]);
  });

  it("o mínimo muda o placar sem chamada nova", () => {
    expect(pontuar(medidas, 0.7).acertos).toBe(4);
    expect(pontuar(medidas, 0.5).acertos).toBe(3);
  });

  it("mediana, p95 e máxima só das chamadas que responderam", () => {
    const ms = [100, 200, 300, 400, 1000].map((latenciaMs) => medida(caso(latenciaMs, null), escolha("none", {}), { latenciaMs }));
    const falha = medida(caso(9, null), null, { latenciaMs: 9000 });
    expect(resumirLatencia([...ms, falha])).toEqual({ chamadas: 6, falhas: 1, medianaMs: 300, p95Ms: 1000, maxMs: 1000 });
  });

  it("o relatório traz o placar, o erro com as duas maiores, o custo e as falhas pelo motivo", () => {
    const texto = relatorio(medidas, { minimo: 0.8, comFatos: true });
    expect(texto).toContain("acertos: 3 de 8 | sem resposta: 1");
    expect(texto).toContain("  queixa_clinica: 1 de 2");
    expect(texto).toContain("  sem_agenda: 2 de 6");
    expect(texto).toContain(
      '- caso 4 [sem_agenda] "mensagem 4": esperado consulta_nova_dr_andre, escolhido (nenhum) (o Jev disse consulta_nova_dr_andre com 0.70; maiores: consulta_nova_dr_andre 0.70, recepcao_geral 0.20, none 0.10)',
    );
    expect(texto).toContain("bloqueiam a liberação pelo critério da bateria: 1 (casos 2)");
    expect(texto).toContain("0.50: 3 | 0.60: 3 | 0.70: 4 | 0.80: 3 | 0.90: 4");
    expect(texto).toContain("chamadas ao Jev por classificação: 1");
    expect(texto).toContain("4 de 8 chamariam também a IA de sempre");
    expect(texto).toContain("falhas: 1 (provedor_indisponivel: 1)");
  });
});

describe("argumentos e membros", () => {
  it("lê as três opções e recusa o resto", () => {
    expect(lerArgumentos([])).toEqual({ semFatos: false, limite: null, membros: null });
    expect(lerArgumentos(["--sem-fatos", "--limite", "5", "--membros", "m.json"])).toEqual({ semFatos: true, limite: 5, membros: "m.json" });
    expect(lerArgumentos(["--limite", "0"])).toMatch(/--limite/);
    expect(lerArgumentos(["--limite"])).toMatch(/--limite/);
    expect(lerArgumentos(["--membros"])).toMatch(/--membros/);
    expect(lerArgumentos(["--com-tudo"])).toBe("argumento desconhecido: --com-tudo");
  });

  it("os membros vêm no formato do banco e têm de cobrir os 5 assuntos da bateria", () => {
    const linhas = Object.keys(ASSUNTOS).map((intent_name) => ({ intent_name, intent_description: "d", examples: ["e"], agent_id: "x" }));
    expect(lerMembros(linhas)).toHaveLength(5);
    expect(lerMembros(linhas)[0]).toEqual({ intentName: "consulta_nova_dr_andre", intentDescription: "d", examples: ["e"] });
    expect(lerMembros(linhas.slice(1))).toBe("faltam assuntos que a bateria espera: consulta_nova_dr_andre");
    expect(lerMembros({ nao: "é lista" })).toMatch(/esperado um array/);
  });
});

describe("o script sem chave ou com argumento errado", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sai com 2 e não chama ninguém", async () => {
    const rede = vi.spyOn(globalThis, "fetch");
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main([], {})).toBe(2);
    expect(await main([], { JEV_API_KEY: "   " })).toBe(2);
    expect(erro).toHaveBeenLastCalledWith("JEV_API_KEY não está no ambiente: nada foi enviado.");
    expect(await main(["--limite", "x"], { JEV_API_KEY: "tsk_x" })).toBe(2);
    expect(await main(["--membros", "/nao/existe.json"], { JEV_API_KEY: "tsk_x" })).toBe(2);
    expect(rede).not.toHaveBeenCalled();
  });
});
