import { ptBR } from "date-fns/locale";
import { describe, expect, it } from "vitest";

import { fraseDaRemarcacao, quandoCurto } from "@/components/agenda/rotulo-do-bloco";

/** A8 do pacote 2a de design: remarcar com frase clara. Nomes fictícios. */
const FUSO = "America/Sao_Paulo";
const MOLDES = {
  comPaciente: "Remarcar {paciente} ({titulo}) de {de} para {para}?",
  semPaciente: "Remarcar {titulo} de {de} para {para}?",
  aviso: "Avise {paciente} do novo horário: a mudança não manda mensagem sozinha, a não ser por uma automação de remarcação.",
};

describe("frase de remarcar", () => {
  it("diz 'hoje' no dia de hoje e 'qui 5/11' nos outros, no fuso da organização", () => {
    const agora = new Date("2026-11-03T15:00:00Z"); // ter 3/11 12:00 em São Paulo
    expect(quandoCurto(new Date("2026-11-03T13:00:00Z"), FUSO, agora, ptBR, "hoje")).toBe("hoje 10:00");
    expect(quandoCurto(new Date("2026-11-05T18:00:00Z"), FUSO, agora, ptBR, "hoje")).toBe("qui 5/11 15:00");
    // 01:30Z do dia 4 ainda é dia 3 em São Paulo.
    expect(quandoCurto(new Date("2026-11-04T01:30:00Z"), FUSO, agora, ptBR, "hoje")).toBe("hoje 22:30");
  });

  it("com paciente: nome, procedimento, de/para e a condição do aviso", () => {
    expect(
      fraseDaRemarcacao({
        paciente: "Marina Alves",
        titulo: "Consulta",
        de: "ter 4/11 10:00",
        para: "qui 6/11 15:00",
        moldes: MOLDES,
      }),
    ).toBe(
      "Remarcar Marina Alves (Consulta) de ter 4/11 10:00 para qui 6/11 15:00? " +
        "Avise Marina Alves do novo horário: a mudança não manda mensagem sozinha, a não ser por uma automação de remarcação.",
    );
  });

  it("sem paciente: só o título, sem falar de aviso", () => {
    expect(
      fraseDaRemarcacao({ titulo: "Reunião", de: "hoje 10:00", para: "hoje 11:00", moldes: MOLDES }),
    ).toBe("Remarcar Reunião de hoje 10:00 para hoje 11:00?");
  });

  it("'$' no nome não vira padrão de substituição", () => {
    expect(
      fraseDaRemarcacao({ paciente: "Ana $&", titulo: "Retorno", de: "a", para: "b", moldes: MOLDES }),
    ).toContain("Remarcar Ana $& (Retorno)");
  });
});
