/**
 * A visão Mês BUSCA o que DESENHA.
 *
 * A grade de setembro/2026 desenha de 30/08 a 10/10 (6 semanas), mas a busca
 * pedia só de 01/09 a 30/09: o compromisso de 1º de outubro aparecia na tela
 * como um dia vazio. O e2e `agenda-ocupacao-do-google-na-grade` só pegava isso
 * quando o relógio do CI caía perto da virada do mês; este teste fixa a data.
 */
import { addDays, format } from "date-fns";
import { describe, expect, it } from "vitest";

import { inicioDaGradeDoMes, recorteDaVisao, SEMANAS_DA_GRADE_DO_MES } from "@/lib/agenda/recorte-da-grade";

const dia = (d: Date) => format(d, "yyyy-MM-dd");

describe("recorte da grade da Agenda", () => {
  it("Mês: busca as mesmas 6 semanas que desenha, vizinhos inclusive", () => {
    const ancora = new Date(2026, 8, 27, 10); // domingo, 27/09/2026
    const { de, ate } = recorteDaVisao("mes", ancora);

    expect(dia(de)).toBe("2026-08-30");
    expect(de).toEqual(inicioDaGradeDoMes(ancora));
    expect(dia(ate)).toBe("2026-10-11"); // exclusivo: a última célula é 10/10
    expect(dia(addDays(de, SEMANAS_DA_GRADE_DO_MES * 7 - 1))).toBe("2026-10-10");

    const primeiroDeOutubro = new Date(2026, 9, 1, 15);
    expect(primeiroDeOutubro >= de && primeiroDeOutubro < ate).toBe(true);
  });

  it("Semana e Dia seguem como eram", () => {
    const ancora = new Date(2026, 8, 30, 10); // quarta
    expect(dia(recorteDaVisao("semana", ancora).de)).toBe("2026-09-27");
    expect(dia(recorteDaVisao("semana", ancora).ate)).toBe("2026-10-04");
    expect(dia(recorteDaVisao("dia", ancora).de)).toBe("2026-09-30");
    expect(dia(recorteDaVisao("dia", ancora).ate)).toBe("2026-10-01");
  });
});
