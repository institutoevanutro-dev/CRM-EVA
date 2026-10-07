/**
 * O TEXTO DO LEMBRETE — as variáveis, no fuso do compromisso.
 *
 * Tudo com `agora` explícito: "hoje" e "amanhã" dependem do relógio, e um teste
 * que lesse o relógio de verdade passaria ou falharia conforme a hora do CI.
 *
 * 2026-10-12 é uma segunda-feira. 08:00 em São Paulo = 11:00Z.
 */
import { describe, expect, it } from "vitest";

import { montarLembrete, variaveisDesconhecidas } from "./texto-do-lembrete";

const AGORA = new Date("2026-10-12T11:00:00Z"); // seg 12/10 08:00 em São Paulo
const SP = "America/Sao_Paulo";

function lembrete(molde: string | null, extra: Partial<Parameters<typeof montarLembrete>[0]> = {}) {
  return montarLembrete({
    nomeDoContato: "Maria Silva",
    titulo: "Consulta — Dr. André",
    quando: new Date("2026-10-12T17:30:00Z"), // 14:30 em São Paulo
    timezone: SP,
    local: "Rua das Flores, 100",
    agora: AGORA,
    molde,
    ...extra,
  });
}

describe("{{quando}} no dia LOCAL do compromisso", () => {
  it("hoje", () => {
    expect(lembrete("{{quando}} às {{hora}}")).toBe("hoje às 14:30");
  });

  it("amanhã", () => {
    expect(lembrete("{{quando}} às {{hora}}", { quando: new Date("2026-10-13T12:00:00Z") })).toBe("amanhã às 09:00");
  });

  it("mais longe vira dia da semana e data, e data, dia_semana e hora saem soltos", () => {
    const texto = lembrete("{{quando}} | {{data}} | {{dia_semana}} | {{hora}}", {
      agora: new Date("2026-10-09T11:00:00Z"), // sex 09/10
    });
    expect(texto).toBe("segunda-feira, 12/10 | 12/10 | segunda-feira | 14:30");
  });

  it("a borda do dia é a do fuso do compromisso, não a do servidor", () => {
    // 03:30Z de 13/10: 00:30 de 13/10 em São Paulo, 23:30 de 12/10 em Manaus.
    const instante = new Date("2026-10-13T03:30:00Z");
    expect(lembrete("{{quando}} {{hora}}", { quando: instante })).toBe("amanhã 00:30");
    expect(lembrete("{{quando}} {{hora}}", { quando: instante, timezone: "America/Manaus" })).toBe("hoje 23:30");
  });

  it("em espanhol, hoy, mañana e o dia da semana traduzido", () => {
    expect(lembrete("{{quando}}", { idioma: "es" })).toBe("hoy");
    expect(lembrete("{{quando}}", { idioma: "es", quando: new Date("2026-10-13T12:00:00Z") })).toBe("mañana");
    expect(lembrete("{{dia_semana}}", { idioma: "es" })).toBe("lunes");
  });
});

describe("variáveis vazias somem sem deixar chave nem espaço sobrando", () => {
  it("sem nome, o cumprimento não fica com vírgula pendurada", () => {
    expect(lembrete("Oi {{primeiro_nome}}, tudo bem?", { nomeDoContato: null })).toBe("Oi, tudo bem?");
    expect(lembrete("Oi {{nome}}! Até {{quando}}.", { nomeDoContato: null })).toBe("Oi! Até hoje.");
  });

  it("sem nome, a vírgula ANTES da variável não fica órfã ('Olá,!')", () => {
    // O molde mais natural de quem copia a frase padrão. Medido na revisão:
    // saía "Olá,! Sua consulta é hoje às 14:30." para o WhatsApp do paciente.
    expect(lembrete("Olá, {{primeiro_nome}}! Sua consulta é {{quando}} às {{hora}}.", { nomeDoContato: null })).toBe(
      "Olá! Sua consulta é hoje às 14:30.",
    );
    expect(lembrete("Unidade: {{unidade}}. Endereço: {{endereco}}.", { unidade: null, local: null })).toBe(
      "Unidade. Endereço.",
    );
  });

  it("controle: pontuação que não encosta em outra continua onde estava", () => {
    expect(lembrete("Olá, {{primeiro_nome}}! Às {{hora}}: até lá; obrigado.")).toBe(
      "Olá, Maria! Às 14:30: até lá; obrigado.",
    );
  });

  it("primeiro nome é a primeira palavra", () => {
    expect(lembrete("Oi {{primeiro_nome}}", { nomeDoContato: "Maria  Silva" })).toBe("Oi Maria");
  });

  it("sem unidade e sem endereço, nenhuma chave chega ao paciente", () => {
    const texto = lembrete("Local: {{unidade}} {{endereco}}", { local: null });
    expect(texto).not.toMatch(/[{}]/);
    expect(texto).toBe("Local:");
  });

  it("sem unidade, {{unidade}} fica vazia — e o endereço não aparece duas vezes", () => {
    const texto = lembrete("{{unidade}} — {{endereco}}", { unidade: null });
    expect(texto).toBe("— Rua das Flores, 100");
    expect(texto.split("Rua das Flores").length).toBe(2);
  });

  it("com unidade, cada variável traz a sua parte", () => {
    expect(lembrete("{{unidade}}: {{endereco}}", { unidade: "Unidade Centro" })).toBe(
      "Unidade Centro: Rua das Flores, 100",
    );
  });

  it("molde de três linhas sai com as três linhas", () => {
    const molde = "Oi {{primeiro_nome}}!\nSua consulta é {{quando}} às {{hora}}.\nEndereço: {{endereco}}";
    expect(lembrete(molde)).toBe("Oi Maria!\nSua consulta é hoje às 14:30.\nEndereço: Rua das Flores, 100");
    expect(lembrete(molde, { nomeDoContato: null }).split("\n")).toHaveLength(3);
  });
});

describe("as outras variáveis", () => {
  it("profissional e tipo, sem diferenciar maiúsculas", () => {
    expect(lembrete("com {{Profissional}} ({{ TIPO }})", { profissional: "Dr. André", tipoNome: "Consulta" })).toBe(
      "com Dr. André (Consulta)",
    );
  });

  it("compatibilidade com o original: {{titulo}} e {{dia}}", () => {
    expect(lembrete("{{titulo}} {{dia}}")).toBe("Consulta — Dr. André segunda-feira, 12/10");
  });

  it("variável desconhecida fica literal no cron — o PATCH é quem recusa", () => {
    expect(lembrete("Oi {{foo}}")).toBe("Oi {{foo}}");
  });
});

describe("sem molde, a frase padrão de antes, byte a byte", () => {
  it("com nome e endereço", () => {
    expect(lembrete(null)).toBe(
      "Oi, Maria Silva! Passando pra lembrar do seu compromisso: Consulta — Dr. André, segunda-feira, 12/10 às 14:30. Endereço: Rua das Flores, 100.",
    );
  });

  it("molde em branco é o mesmo que nenhum", () => {
    expect(lembrete("   ")).toBe(lembrete(null));
  });
});

describe("variaveisDesconhecidas", () => {
  it.each([
    ["{{foo}}", ["foo"]],
    ["{nome}", ["{", "}"]],
    ["{{primeiro nome}}", ["primeiro nome"]],
    ["{{primeiro-nome}}", ["primeiro-nome"]],
    ["{{nome}} }", ["}"]],
    ["{{ Nome }} e {{HORA}}", []],
    ["Oi\n{{quando}}", []],
  ])("%s → %j", (texto, esperado) => {
    expect(variaveisDesconhecidas(texto)).toEqual(esperado);
  });
});
