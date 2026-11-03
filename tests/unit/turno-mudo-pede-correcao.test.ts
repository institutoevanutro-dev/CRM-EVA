/**
 * TURNO MUDO — quando o silêncio do turno é decisão e quando é defeito.
 *
 * A regra é de `lib/agent-engine/agent/turno-mudo.ts`; o caminho inteiro (o
 * handler de `inbound_turn` pedindo a correção ao modelo) está em
 * `tests/invariants/turno-mudo-pede-uma-correcao.test.ts`.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CORRECAO_DO_TURNO_MUDO,
  correcaoDoTurnoMudo,
  PASSOS_DA_CORRECAO,
  turnoMudoPedeCorrecao,
} from "@/lib/agent-engine/agent/turno-mudo";
import {
  BEFORE_SEND_GATES,
  lgpdGate,
  VETOS_IRREVOGAVEIS,
  type GateContext,
  type GateVerdict,
} from "@/lib/agent-engine/guardrails/before-send";

const MUDO = {
  tentativasDeEnvio: 0,
  vetoIrrevogavel: false,
  enviadas: 0,
  turnoDescartado: false,
  passouParaAEquipe: false,
  capDeEnvio: false,
};

describe("o turno mudo pede correção só quando nada explica o silêncio", () => {
  it("⭐ nenhum envio, nenhuma tentativa, nenhuma razão: pede correção", () => {
    expect(turnoMudoPedeCorrecao(MUDO)).toBe(true);
  });

  it.each([
    ["algo saiu", { enviadas: 1 }],
    ["o turno foi descartado como obsoleto", { turnoDescartado: true }],
    ["a conversa foi passada à equipe", { passouParaAEquipe: true }],
    ["o cap de envio do número barrou", { capDeEnvio: true }],
    // opt-out / contato interno / equipe / LGPD / janela fechada: o veto diz "encerre sem
    // tentar de novo" — a correção mandaria o modelo tentar de novo, contra o veto.
    ["a cadeia vetou com um código que manda parar", { tentativasDeEnvio: 1, vetoIrrevogavel: true }],
  ])("silêncio com razão — %s: não pede", (_razao, mudanca) => {
    expect(turnoMudoPedeCorrecao({ ...MUDO, ...mudanca })).toBe(false);
  });

  it("⭐ teste 10 do aceite: tentativas vetadas e NADA entregue — pede correção", () => {
    // O caso medido no original (2026-10-25, job 217c6925): o modelo chamou send_message
    // 2×, o agenda_stall vetou as duas (erros de ensino voltaram DENTRO do loop) e ele
    // encerrou o turno com texto solto. Nada chegou ao cliente e a agenda não mudou. "O
    // veto já ensinou" é uma suposição que este turno refuta: a lição ficou no loop e o
    // cliente ficou sem resposta — a correção é o único caminho de recuperação.
    expect(
      turnoMudoPedeCorrecao({ ...MUDO, tentativasDeEnvio: 2 }),
      "tentativa vetada não entregou nada — o silêncio é defeito, não decisão",
    ).toBe(true);
  });

  it("a correção diz o que aconteceu, manda usar send_message e deixa o silêncio deliberado possível", () => {
    expect(CORRECAO_DO_TURNO_MUDO).toContain("send_message");
    expect(CORRECAO_DO_TURNO_MUDO).toContain("não chega");
    expect(CORRECAO_DO_TURNO_MUDO).toMatch(/idioma da conversa/);
    expect(CORRECAO_DO_TURNO_MUDO).toMatch(/não responder, encerre/);
  });
});

describe("a receita de remarcar da correção (porte do #3673)", () => {
  it("⭐ para quem lista E remarca: MOVER o compromisso, nunca criar outro", () => {
    // Medido no original (2026-10-26, job 5ca40cb3): o diálogo trazia o veto de agenda e
    // a correção resolveu o "falta mexer na agenda" como NOVO agendamento, criando uma
    // SEGUNDA consulta com a original intacta. O texto nomeia o caminho certo: localizar
    // SEM `dia` (o dia chutado devolve lista vazia) e MOVER com crm_reschedule_appointment.
    const texto = correcaoDoTurnoMudo(["crm_list_appointments", "crm_reschedule_appointment"]);
    expect(texto.startsWith(CORRECAO_DO_TURNO_MUDO)).toBe(true);
    expect(texto).toContain("crm_list_appointments");
    expect(texto).toContain("crm_reschedule_appointment");
    expect(texto).toMatch(/sem `dia`/);
    expect(texto).toMatch(/SEGUNDO compromisso/);
    // …e a ordem continua sendo: mudar a agenda PRIMEIRO, responder DEPOIS.
    expect(texto).toMatch(/S[oó] depois de a agenda ter mudado/);
    // Neste fork a receita não nomeia ferramenta de marcar: nomear ferramenta faz o
    // modelo tentar chamá-la, e o agente pode nem tê-la.
    expect(texto).not.toContain("crm_book_appointment");
    expect(texto).not.toContain("crm_find_and_book_appointment");
  });

  it.each([
    [["crm_find_free_slots"]],
    [["crm_reschedule_appointment"]],
    [["crm_list_appointments"]],
    [[]],
  ])("sem as duas ferramentas, a correção é o texto base — %j", (toolIds) => {
    expect(correcaoDoTurnoMudo(toolIds)).toBe(CORRECAO_DO_TURNO_MUDO);
  });
});

describe("o teto da correção", () => {
  it("é 6 passos, e o turno usa a constante — nenhum literal", () => {
    // Com 3, a correção do teste 10 no original gastou os três em ferramentas de agenda e
    // parou antes do send_message. Uma remarcação são 4 saídas de modelo (localizar →
    // horário → mover → enviar); o limite continua existindo, só cabe a receita.
    expect(PASSOS_DA_CORRECAO).toBe(6);
    const turno = fs.readFileSync(path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
    expect(turno).toContain("Math.min(maxSteps, PASSOS_DA_CORRECAO)");
    expect(turno).not.toMatch(/Math\.min\(maxSteps, \d+\)/);
  });
});

describe("o pedido humano (porte do #3557) ocupa a vaga da correção — não é um passo a mais", () => {
  it("da régua do pedido ao fim do rascunho: UMA chamada de modelo, nunca duas", () => {
    // No clique em "Sugerir resposta" o pedido humano troca a INSTRUÇÃO da correção;
    // não ganha chamada própria. Um segundo `runModelCall` aqui é um clique pagando
    // três chamadas (turno + correção + pedido) e tem de doer neste teste.
    const turno = fs.readFileSync(path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
    const inicio = turno.indexOf("const pedidoHumano =");
    expect(inicio).toBeGreaterThan(-1);
    const fim = turno.indexOf("avisarSemCandidato(preview)", inicio);
    expect(fim).toBeGreaterThan(inicio);
    const regiao = turno.slice(inicio, fim);
    expect(regiao.split("await runModelCall(").length - 1).toBe(1);
    expect(regiao).toContain("INSTRUCAO_DO_PEDIDO_HUMANO");
    // Só proposta que o cliente veria cala o pedido (sem o #3093 do original, a
    // que só propõe nota, estado do lead ou marcação deixaria o rascunho vazio).
    expect(regiao).toContain("p.tool === 'send_template' || p.tool === 'send_media'");
  });
});

describe("VETOS_IRREVOGAVEIS cobre todo código que manda parar, com os nomes deste fork", () => {
  const stop = BEFORE_SEND_GATES[0]!;
  const veto = (v: GateVerdict): string => {
    if (v.pass) throw new Error("esperava veto");
    return v.code;
  };
  const SEM_BASE = { basis: null, legalBasisRef: null, consentGranted: false, dataOrigin: null };

  it("⭐ todo código do gate stop e do lgpd está na lista", () => {
    expect(stop.name).toBe("stop");
    const codigos = [
      veto(stop.evaluate({ optedOut: true } as GateContext)),
      veto(stop.evaluate({ optedOut: true, comHumano: true } as GateContext)),
      veto(stop.evaluate({ optedOut: true, contatoInterno: true } as GateContext)),
      veto(
        lgpdGate.evaluate({
          lgpd: { isAnonymized: true, isProspecting: false, isFirstOutbound: false, legalBasis: SEM_BASE },
        } as GateContext),
      ),
      veto(
        lgpdGate.evaluate({
          lgpd: { isAnonymized: false, isProspecting: true, isFirstOutbound: true, legalBasis: SEM_BASE },
        } as GateContext),
      ),
    ];
    expect(new Set(codigos).size).toBe(5);
    for (const c of codigos) expect(VETOS_IRREVOGAVEIS.has(c), c).toBe(true);
  });

  it("a janela de envio que fechou no meio do turno também manda parar", () => {
    expect(VETOS_IRREVOGAVEIS.has("outside_window")).toBe(true);
  });

  it("nem o nome do original nem a janela de 24h, que tem saída por template", () => {
    // `atendimento_com_humano` é o código do original; aqui o gate stop emite
    // `conversa_com_humano`, e com o nome de lá a pessoa que assumiu receberia a correção.
    expect(VETOS_IRREVOGAVEIS.has("atendimento_com_humano")).toBe(false);
    expect(VETOS_IRREVOGAVEIS.has("messaging_window_closed")).toBe(false);
  });
});
