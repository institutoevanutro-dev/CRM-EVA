/**
 * O LEMBRETE DE VÉSPERA QUE NASCE VENCIDO (#2223) — a regra, sem banco.
 *
 * O caso medido na issue: o agente marca reunião às 18:30 para as 16h do dia
 * seguinte (21h30 de antecedência) e o lembrete de 1440 min sai às 18:35:01 —
 * um minuto depois de confirmar — e DE NOVO, idêntico, às 18:40:01. Com reunião
 * a mais de 24h não há disparo imediato; o que muda é só isto: a hora do degrau
 * (16:00 de HOJE) já tinha passado quando a reunião foi marcada.
 *
 * Duas regras diferentes saem daí, e este arquivo prende as duas:
 *
 * 1. **Degrau cuja hora passou ANTES da marcação nunca sai.** Não é atraso de
 *    cron — a ocasião de avisar "na véspera" nunca existiu. A régua é
 *    `created_at`, e é ela que `vencidoNaMarcacao` compara.
 * 2. **Uma saída por degrau, mesmo com duas varreduras.** A rota grava
 *    `reminder_sent_offsets_minutes` entre uma varredura e a seguinte, e é o
 *    conjunto gravado que `varredura()` abaixo replica — a prova de que a
 *    segunda rodada não repete a primeira.
 *
 * O controle de 60 min entra de propósito no mesmo arquivo: o conserto não pode
 * apagar o lembrete que funciona (a regressão silenciosa seria pior que o defeito).
 *
 * A função mora na rota do cron porque é A rota quem decide enviar — o mesmo
 * desenho de `app/api/v1/cron/agenda-reminder/route.test.ts`, que a exercita
 * sem banco; aqui o foco é a sequência de varreduras.
 */
import { describe, expect, it } from "vitest";

import { degrausPendentes } from "@/app/api/v1/cron/agenda-reminder/route";

const d = (iso: string) => new Date(iso);

interface LinhaDeTeste {
  /** Início da reunião. */
  comeca: string;
  /** `created_at` — quando a reunião foi marcada. */
  criadoEm?: string | null;
  principal: number;
  extras?: number[] | null;
}

/**
 * Uma varredura do cron: devolve o que sairia e grava o carimbo, exatamente
 * como a rota faz entre uma rodada e a seguinte — é o estado que a segunda
 * varredura lê.
 */
function varredura(estado: { enviados: number[] | null }, linha: LinhaDeTeste, agora: string): number[] {
  const pendentes = degrausPendentes({
    agora: d(agora),
    comeca: d(linha.comeca),
    principal: linha.principal,
    extras: linha.extras ?? null,
    jaEnviados: estado.enviados,
    criadoEm: linha.criadoEm ? d(linha.criadoEm) : null,
  });
  estado.enviados = [...new Set([...(estado.enviados ?? []), ...pendentes])];
  return pendentes;
}

describe("o lembrete de véspera (1440 min) e a marcação (#2223)", () => {
  it("marcada às 18:30 para as 16h do dia seguinte (21h30 de antecedência): NÃO sai na primeira varredura", () => {
    // O caso da issue. A hora do degrau é 16:00 de HOJE — duas horas e meia
    // antes de a linha existir.
    const estado = { enviados: null as number[] | null };
    const linha: LinhaDeTeste = {
      comeca: "2026-10-04T16:00:00.000Z",
      criadoEm: "2026-10-03T18:30:00.000Z",
      principal: 60,
      extras: [1440],
    };
    expect(varredura(estado, linha, "2026-10-03T18:35:00.000Z")).toEqual([]);
    // Nem o degrau sozinho, nem os dois juntos: o de 60 continua dormente.
    expect(varredura({ enviados: null }, { ...linha, principal: 1440, extras: null }, "2026-10-03T18:35:00.000Z")).toEqual([]);
  });

  it("início às 21:30 marcado às 18:35: nem a varredura das 18:35 nem a das 18:40 mandam a véspera", () => {
    // As duas horários do relato da issue — e as duas davam o MESMO texto.
    const estado = { enviados: null as number[] | null };
    const linha: LinhaDeTeste = {
      comeca: "2026-10-03T21:30:00.000Z",
      criadoEm: "2026-10-03T18:35:00.000Z",
      principal: 60,
      extras: [1440],
    };
    expect(varredura(estado, linha, "2026-10-03T18:35:00.000Z")).toEqual([]);
    expect(varredura(estado, linha, "2026-10-03T18:40:00.000Z")).toEqual([]);
    expect(estado.enviados).toEqual([]);
  });

  it("duas varreduras dão UMA única saída — o degrau legítimo não repete", () => {
    // Marcada em 02/10 08:00, com a véspera em 03/10 16:00: a hora nasceu
    // DEPOIS da marcação, então o degrau está armado e sai na primeira
    // varredura depois das 16:00 — e só nela.
    const estado = { enviados: null as number[] | null };
    const linha: LinhaDeTeste = {
      comeca: "2026-10-04T16:00:00.000Z",
      criadoEm: "2026-10-02T08:00:00.000Z",
      principal: 60,
      extras: [1440],
    };
    const saidas = [
      ...varredura(estado, linha, "2026-10-03T16:05:00.000Z"),
      ...varredura(estado, linha, "2026-10-03T16:10:00.000Z"),
    ];
    expect(saidas).toEqual([1440]);
  });

  it("o controle do offset 60 continua saindo — e também uma vez só", () => {
    // A véspera já saiu; falta a hora cheia. O conserto de 1440 não pode ter
    // apagado o 60.
    const estado = { enviados: [1440] as number[] | null };
    const linha: LinhaDeTeste = {
      comeca: "2026-10-04T16:00:00.000Z",
      criadoEm: "2026-10-02T08:00:00.000Z",
      principal: 60,
      extras: [1440],
    };
    const saidas = [
      ...varredura(estado, linha, "2026-10-04T15:05:00.000Z"),
      ...varredura(estado, linha, "2026-10-04T15:10:00.000Z"),
    ];
    expect(saidas).toEqual([60]);
  });

  it("cron parado: degrau que venceu DEPOIS da marcação continua saindo atrasado", () => {
    // O outro lado da régua: atraso de cron legítimo não é o defeito da issue,
    // e apagá-lo em silêncio seria a regressão oposta.
    const estado = { enviados: null as number[] | null };
    const linha: LinhaDeTeste = {
      comeca: "2026-10-04T16:00:00.000Z",
      criadoEm: "2026-10-02T08:00:00.000Z",
      principal: 1440,
      extras: null,
    };
    expect(varredura(estado, linha, "2026-10-03T18:00:00.000Z")).toEqual([1440]);
  });

  it("linha que não sabe quando foi marcada mantém o comportamento antigo", () => {
    // `created_at` ausente = guarda fora do caminho: só o degrau que PROVA ter
    // vencido antes da marcação é descartado, nunca um que não dá pra datar.
    const estado = { enviados: null as number[] | null };
    const linha: LinhaDeTeste = {
      comeca: "2026-10-04T16:00:00.000Z",
      criadoEm: null,
      principal: 1440,
      extras: null,
    };
    expect(varredura(estado, linha, "2026-10-03T18:00:00.000Z")).toEqual([1440]);
  });

  it("marcada no instante exato da hora do degrau também é descartada", () => {
    // `<=`, não `<`: lembrete que sai no segundo em que a reunião é marcada é
    // exatamente o que a issue reporta.
    const estado = { enviados: null as number[] | null };
    const linha: LinhaDeTeste = {
      comeca: "2026-10-04T16:00:00.000Z",
      criadoEm: "2026-10-03T16:00:00.000Z",
      principal: 1440,
      extras: null,
    };
    expect(varredura(estado, linha, "2026-10-03T16:00:30.000Z")).toEqual([]);
  });
});
