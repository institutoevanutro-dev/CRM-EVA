/**
 * A PROMESSA AO CLIENTE NASCE DO ESTADO REAL DA EQUIPE (ACH-03).
 *
 * O defeito que este arquivo prende foi medido num turno REAL, não deduzido: o
 * agente abriu o chamado e disse ao cliente *"vou providenciar para que alguém
 * da equipe entre em contato"* — sem prazo, sem saber se havia alguém. A
 * capacidade de consultar (`crm_list_available_attendants`) existia, estava
 * ligada e foi montada no turno (o log lista as 8 tools pelo nome). O modelo
 * simplesmente não a escolheu.
 *
 * A conclusão não foi "melhorar a descrição da tool": capacidade que depende de
 * o modelo LEMBRAR não existe metade das vezes. O caminho de escalação passou a
 * consultar sozinho e a devolver a expectativa junto com a confirmação.
 *
 * O teste é sobre a FRASE, porque é ela que decide o que o cliente ouve.
 */
import { describe, expect, it } from "vitest";

import { textoDoAviso } from "@/lib/escalacao/aviso-ao-lead";
import type { AvailabilitySchedule } from "@/lib/schemas/routing";

import {
  fraseDeExpectativa,
  quandoAEquipeVolta,
  quemPodeAssumirAgora,
  expectativaDeAtendimento,
} from "@/lib/escalacao/disponibilidade";

describe("a frase que o agente recebe ao escalar", () => {
  it("com gente disponível, autoriza dizer que alguém continua em seguida", () => {
    const f = fraseDeExpectativa({ disponiveis: 2, total: 4 });
    expect(f).toContain("2 pessoas");
    expect(f).toMatch(/pode dizer ao cliente/i);
    expect(f).not.toMatch(/NÃO prometa/);
  });

  it("uma pessoa só não vira '1 pessoas'", () => {
    expect(fraseDeExpectativa({ disponiveis: 1, total: 3 })).toContain("1 pessoa da equipe");
  });

  it("equipe existe mas ninguém online: proíbe prometer contato imediato", () => {
    const f = fraseDeExpectativa({ disponiveis: 0, total: 4 });
    expect(f).toMatch(/NÃO prometa contato/i);
    expect(f).toMatch(/registrado/i);
    // A diferença entre "ninguém agora" e "ninguém nunca" importa para o texto
    // que o cliente lê — a primeira ainda promete retorno.
    expect(f).toMatch(/retorna assim que possível/i);
  });

  it("conta sem ninguém configurado: o caso da VPS recém-instalada", () => {
    // Numa instalação fresca NINGUÉM está em attendant_availability. Sem este
    // ramo, a primeira conversa de um cliente real terminaria com o agente
    // prometendo contato para o vazio.
    const f = fraseDeExpectativa({ disponiveis: 0, total: 0 });
    expect(f).toMatch(/ninguém configurado/i);
    expect(f).toMatch(/NÃO prometa/i);
  });

  it("as três situações produzem frases DIFERENTES", () => {
    const frases = new Set([
      fraseDeExpectativa({ disponiveis: 2, total: 4 }),
      fraseDeExpectativa({ disponiveis: 0, total: 4 }),
      fraseDeExpectativa({ disponiveis: 0, total: 0 }),
    ]);
    expect(frases.size).toBe(3);
  });
});

describe("quem pode assumir agora", () => {
  const AGORA = new Date("2026-08-05T15:00:00.000Z");

  function dublePg(linhas: Array<Record<string, unknown>>) {
    return { query: () => Promise.resolve({ rows: linhas, rowCount: linhas.length }) } as never;
  }

  it("conta só quem está online, com folga e é atendente", async () => {
    const q = await quemPodeAssumirAgora(
      dublePg([
        { user_id: "a", role: "agent", capacity: 5, schedule: {}, carga: "2" }, // livre
        { user_id: "b", role: "manager", capacity: 3, schedule: {}, carga: "3" }, // lotado
        { user_id: "c", role: "agent", capacity: null, schedule: null, carga: "0" }, // offline/não configurado
        { user_id: "d", role: "viewer", capacity: 9, schedule: {}, carga: "0" }, // não é atendente
      ]),
      "org",
      AGORA,
    );
    expect(q).toEqual({ disponiveis: 1, total: 3, volta: null });
  });

  it("quem nunca configurou disponibilidade NÃO é contado como disponível", async () => {
    // O worker de roteamento também não o escolhe — contá-lo aqui prometeria o
    // que o roteamento nunca entregaria.
    const q = await quemPodeAssumirAgora(
      dublePg([{ user_id: "a", role: "agent", capacity: null, schedule: null, carga: "0" }]),
      "org",
      AGORA,
    );
    expect(q).toEqual({ disponiveis: 0, total: 1, volta: null });
  });

  it("fora da janela de horário não conta, mesmo online e com folga", async () => {
    // 15:00Z = 12:00 em São Paulo; a janela abaixo é 18:00–19:00 local.
    const q = await quemPodeAssumirAgora(
      dublePg([
        {
          user_id: "a",
          role: "agent",
          capacity: 5,
          schedule: { timezone: "America/Sao_Paulo", windows: [{ dow: 3, start: "18:00", end: "19:00" }] },
          carga: "0",
        },
      ]),
      "org",
      AGORA,
    );
    expect(q.disponiveis).toBe(0);
  });

  it("leitura que falha vira instrução conservadora, nunca silêncio otimista", async () => {
    const r = await expectativaDeAtendimento(
      { query: () => Promise.reject(new Error("banco fora do ar")) } as never,
      "org",
      AGORA,
    );
    expect(r.quem).toBeNull();
    expect(r.frase).toMatch(/NÃO prometa contato/i);
  });
});

/**
 * QUANDO A EQUIPE VOLTA — a clínica não atende sábado nem domingo.
 *
 * Datas de outubro de 2026 (24/10 é sábado). São Paulo é UTC-3 o ano todo.
 * Jornada fictícia: segunda a sexta, 08:00–18:00.
 */
describe("quando a equipe volta", () => {
  const SP = "America/Sao_Paulo";
  const semanaUtil = (timezone = SP): AvailabilitySchedule => ({
    timezone,
    windows: [1, 2, 3, 4, 5].map((dow) => ({ dow, start: "08:00", end: "18:00" })),
  });

  it("sábado à tarde: volta na segunda-feira", () => {
    // sábado 24/10 15:00 SP
    expect(quandoAEquipeVolta([semanaUtil()], new Date("2026-10-24T18:00:00Z"), SP)).toBe(
      "na segunda-feira",
    );
  });

  it("sexta 23:00: volta na segunda-feira", () => {
    // sexta 23/10 23:00 SP = sábado 02:00 UTC
    expect(quandoAEquipeVolta([semanaUtil()], new Date("2026-10-24T02:00:00Z"), SP)).toBe(
      "na segunda-feira",
    );
  });

  it("terça 21:00: volta amanhã", () => {
    // terça 20/10 21:00 SP
    expect(quandoAEquipeVolta([semanaUtil()], new Date("2026-10-21T00:00:00Z"), SP)).toBe("amanhã");
  });

  it("antes de abrir no mesmo dia: hoje a partir da hora da janela", () => {
    // quarta 21/10 06:00 SP; uma agenda abre 08:30, outra 10:00: vale a mais cedo.
    const tarde: AvailabilitySchedule = { timezone: SP, windows: [{ dow: 3, start: "10:00", end: "12:00" }] };
    const cedo: AvailabilitySchedule = { timezone: SP, windows: [{ dow: 3, start: "08:30", end: "12:00" }] };
    expect(quandoAEquipeVolta([tarde, cedo], new Date("2026-10-21T09:00:00Z"), SP)).toBe(
      "hoje a partir das 8h30",
    );
  });

  it("dentro do horário: null (o texto de hoje fica)", () => {
    // terça 20/10 10:00 SP
    expect(quandoAEquipeVolta([semanaUtil()], new Date("2026-10-20T13:00:00Z"), SP)).toBeNull();
  });

  it("sem horário configurado: null (o texto de hoje fica)", () => {
    const sabado = new Date("2026-10-24T18:00:00Z");
    expect(quandoAEquipeVolta([], sabado, SP)).toBeNull();
    // alguém sem janela atende 24/7: não há "volta"
    expect(quandoAEquipeVolta([semanaUtil(), { timezone: SP, windows: [] }], sabado, SP)).toBeNull();
  });

  it("fuso: o mesmo instante perto da meia-noite dá respostas diferentes em SP e em UTC", () => {
    // terça 20/10 01:00 UTC = segunda 19/10 22:00 SP.
    const t = new Date("2026-10-20T01:00:00Z");
    // jornada em SP: abre terça 08:00 SP, que é "amanhã" para quem está em SP.
    expect(quandoAEquipeVolta([semanaUtil(SP)], t, SP)).toBe("amanhã");
    // jornada escrita em UTC: abre terça 08:00 UTC = terça 05:00 SP, também "amanhã" em SP.
    expect(quandoAEquipeVolta([semanaUtil("UTC")], t, SP)).toBe("amanhã");
    // rotulado em UTC, o mesmo início é "hoje" (já é terça em UTC).
    expect(quandoAEquipeVolta([semanaUtil("UTC")], t, "UTC")).toBe("hoje a partir das 8h");
  });

  it("uma semana à frente diz 'próxima'", () => {
    // terça 20/10 19:00 SP, só há janela às terças.
    const soTerca: AvailabilitySchedule = { timezone: SP, windows: [{ dow: 2, start: "08:00", end: "18:00" }] };
    expect(quandoAEquipeVolta([soTerca], new Date("2026-10-20T22:00:00Z"), SP)).toBe(
      "na próxima terça-feira",
    );
  });

  it("quemPodeAssumirAgora lê a volta da jornada de quem está ligado", async () => {
    const q = await quemPodeAssumirAgora(
      {
        query: () =>
          Promise.resolve({
            rows: [
              { user_id: "a", role: "agent", capacity: 5, schedule: semanaUtil(), carga: "0", fuso_org: SP },
              // desligado: não entra na conta da volta
              { user_id: "b", role: "agent", capacity: null, schedule: null, carga: "0", fuso_org: SP },
            ],
            rowCount: 2,
          }),
      } as never,
      "org",
      new Date("2026-10-24T18:00:00Z"),
    );
    expect(q).toEqual({ disponiveis: 0, total: 2, volta: "na segunda-feira" });
  });
});

describe("o que o paciente lê com a volta conhecida", () => {
  const LEAD = "22222222-2222-4222-8222-222222222222";
  const fora = { disponiveis: 0, total: 2, volta: "na segunda-feira" };

  it("aviso de escalação diz quando a equipe volta, sem travessão", () => {
    const t = textoDoAviso("pediu_humano", fora, LEAD);
    expect(t).toContain("na segunda-feira");
    expect(t).not.toMatch(/[—–]/);
  });

  it("sem volta conhecida, o texto é exatamente o de antes", () => {
    const antes = textoDoAviso("pediu_humano", { disponiveis: 0, total: 2 }, LEAD);
    expect(textoDoAviso("pediu_humano", { ...fora, volta: null }, LEAD)).toBe(antes);
    expect(fraseDeExpectativa({ disponiveis: 0, total: 2, volta: null })).toBe(
      fraseDeExpectativa({ disponiveis: 0, total: 2 }),
    );
  });

  it("com gente disponível, a volta não muda nada", () => {
    expect(textoDoAviso("pediu_humano", { disponiveis: 1, total: 2, volta: "amanhã" }, LEAD)).toBe(
      textoDoAviso("pediu_humano", { disponiveis: 1, total: 2 }, LEAD),
    );
  });

  it("instrução ao modelo (open_human_case) carrega a volta e proíbe outro prazo", () => {
    const f = fraseDeExpectativa(fora);
    expect(f).toContain("retorna na segunda-feira");
    expect(f).toMatch(/NÃO prometa contato antes/);
  });

  it("três redações entre leads (o spinning cruza leads)", () => {
    const textos = new Set(
      Array.from({ length: 60 }, (_, i) => textoDoAviso("pediu_humano", fora, `lead-${i}`)),
    );
    expect(textos.size).toBeGreaterThanOrEqual(3);
  });
});
