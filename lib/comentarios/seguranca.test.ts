import { describe, expect, it } from "vitest";
import { ehObviamenteSeguro, ehTokenDeGatilho } from "./seguranca";

const inseguros: [string, string][] = [
  ["quanto custa?", "preço"], ["qual o valor da consulta", "preço"], ["tem desconto?", "preço"],
  ["posso tomar mounjaro?", "medicação"], ["qual a dose de tirzepatida", "medicação"],
  ["serve pra quem tem tireoide?", "sintoma"], ["senti tontura, é normal?", "sintoma"],
  ["como agendo?", "agendamento"], ["tem horário amanhã?", "agendamento"],
  ["paguei e ninguém me respondeu", "reclamação"], ["que golpe é esse", "reclamação"],
  ["você é nutrólogo?", "especialidade"], ["qual sua especialidade?", "especialidade"],
];

it.each(inseguros)("%s precisa de você (%s)", (texto, categoria) => {
  expect(ehObviamenteSeguro(texto)).toEqual({ seguro: false, gatilho: categoria });
});

// Prova de mutação (mantida): elogio na frente não muda o veredito — mata o
// mutante que fazia "obviamente seguro" casar SUBSTRING em vez do texto
// inteiro. Sem o ancoramento ao texto todo, "amei, quanto custa?" passaria.
it.each(inseguros)('"amei, %s" continua inseguro (elogio não desarma o gatilho)', (texto) => {
  expect(ehObviamenteSeguro(`amei, ${texto}`).seguro).toBe(false);
});

const seguros = ["top!", "amei 😍", "🔥🔥🔥", "parabéns doutor", "que vídeo bom"];
it.each(seguros)("%s é obviamente seguro", (texto) => {
  expect(ehObviamenteSeguro(texto)).toEqual({ seguro: true });
});

it("na dúvida, é inseguro: pergunta que não é elogio não passa", () => {
  expect(ehObviamenteSeguro("e para quem tem 60 anos?").seguro).toBe(false);
});

it("texto vazio ou nulo não é publicável", () => {
  expect(ehObviamenteSeguro(null).seguro).toBe(false);
  expect(ehObviamenteSeguro("   ").seguro).toBe(false);
});

it("elogio com pergunta retórica continua inseguro (a régua é conservadora)", () => {
  expect(ehObviamenteSeguro("amei! onde compro?").seguro).toBe(false);
});

// ── casos que a revisão pegou na ronda 1 (não podem voltar a passar) ────────
const naoPodemVoltarAPassar = [
  "top! estou amamentando, posso usar a caneta",
  "amei, sou diabético tipo 1, posso aplicar",
  "show! tomo losartana, tem interação",
  "amei! onde compro",
  "top, quais os preços",
  "top, cuánto cuesta",
  "parabéns, o senhor trata obesidade infantil",
];

it.each(naoPodemVoltarAPassar)("%s não pode ser publicado sozinho", (texto) => {
  expect(ehObviamenteSeguro(texto).seguro).toBe(false);
});

// ── espanhol: vocabulário inequívoco também precisa de humano ───────────────
const inegurosEmEspanhol: [string, string][] = [
  ["cuánto cuesta?", "preço"],
  ["cual es el precio?", "preço"],
  ["puedo tomar ozempic?", "medicação"],
  ["eres nutriologo?", "especialidade"],
  ["tienes cita manana?", "agendamento"],
];

it.each(inegurosEmEspanhol)("%s precisa de você em espanhol (%s)", (texto, categoria) => {
  expect(ehObviamenteSeguro(texto)).toEqual({ seguro: false, gatilho: categoria });
});

// ── texto longo não é "obviamente seguro", mesmo sendo TODO vocabulário seguro ─
it("texto longo demais não é obviamente seguro, mesmo com todo token conhecido", () => {
  const longo =
    "muito obrigada doutor, que aula maravilhosa, perfeito, excelente, adorei o video, top demais, parabens, show de bola, sucesso";
  expect(longo.length).toBeGreaterThan(120);
  expect(ehObviamenteSeguro(longo)).toEqual({ seguro: false, gatilho: "texto longo demais" });
});

// ── emoji com variation selector e ZWJ também é "só emoji" ──────────────────
it.each(["❤️", "👨🏽‍⚕️"])("%s (emoji com modificador) é obviamente seguro", (texto) => {
  expect(ehObviamenteSeguro(texto)).toEqual({ seguro: true });
});

// ── RONDA 2 (revisão): critério trocado de "frase fechada" pra "todo token no
// vocabulário" — elogio de verdade não sai só nas frases prontas da ronda 1.
// Estes dez são exatamente os que a medição da revisão marcou como recusados
// indevidamente; agora precisam ser seguros. ──────────────────────────────────
const elogiosReaisQuePrecisamPassar = [
  "muito bom esse conteúdo",
  "adorei o vídeo",
  "excelente explicação",
  "que aula!",
  "obrigada doutor 🙏",
  "top demais",
  "amei o conteúdo",
  "perfeito",
  "show de bola",
  "melhor explicação que já vi",
];

it.each(elogiosReaisQuePrecisamPassar)("%s é elogio real e tem de ser seguro", (texto) => {
  expect(ehObviamenteSeguro(texto)).toEqual({ seguro: true });
});

// O princípio da ronda 2: mesmo começo, um token desconhecido no fim já vira
// tudo inseguro — é o que faz o vocabulário seguro compor frase sem abrir mão
// do deny-by-default.
it("mesmo começo, um token desconhecido no fim reprova o texto inteiro", () => {
  expect(ehObviamenteSeguro("amei o conteúdo")).toEqual({ seguro: true });
  expect(ehObviamenteSeguro("amei o conteúdo, qual a dose").seguro).toBe(false);
});

describe("marcação de perfil sai da análise", () => {
  it("marcação mais emoji passa: o que decide é o resto da frase", () => {
    expect(ehObviamenteSeguro("@dr.andreluisc 💪💪💪")).toEqual({ seguro: true });
  });

  it("marcação mais elogio conhecido passa", () => {
    expect(ehObviamenteSeguro("@fulano @ciclano top demais")).toEqual({ seguro: true });
  });

  it("o gatilho continua vencendo: o resto da frase é que decide", () => {
    const v = ehObviamenteSeguro("@fulano quanto custa?");
    expect(v.seguro).toBe(false);
    if (!v.seguro) expect(v.gatilho).toBe("preço");
  });

  // Review Focus 1: sobrar vazio não é "todos os tokens são seguros".
  it("comentário que é SÓ marcação continua inseguro, com gatilho vazio", () => {
    const v = ehObviamenteSeguro("@fulano");
    expect(v.seguro).toBe(false);
    if (!v.seguro) expect(v.gatilho).toBe("vazio");
  });

  it("só marcação com espaços em volta também", () => {
    const v = ehObviamenteSeguro("  @fulano  @ciclano ");
    expect(v.seguro).toBe(false);
    if (!v.seguro) expect(v.gatilho).toBe("vazio");
  });

  // Review Focus 2: a remoção não pode emendar palavras nem comer pontuação.
  it("marcação colada em pontuação não emenda o resto", () => {
    expect(ehObviamenteSeguro("@fulano, top!")).toEqual({ seguro: true });
    expect(ehObviamenteSeguro("(@fulano) show")).toEqual({ seguro: true });
  });

  // I-7: o caso anterior era "fale com joao@clinica.com", e ele reprovava com
  // ou sem a guarda do `@` colado ("fale"/"com" já são desconhecidos). Com
  // "top@clinica.com" o teste MORDE: sem a guarda, `semMarcacoes` comeria
  // "@clinica.com" inteiro, sobraria "top", e o e-mail sairia publicado.
  it("e-mail não é marcação: o texto continua sendo julgado inteiro", () => {
    const v = ehObviamenteSeguro("top@clinica.com");
    expect(v.seguro).toBe(false);
  });
});

describe("palavras aprovadas pelo dono", () => {
  it("palavra desconhecida reprova; a mesma palavra aprovada libera", () => {
    expect(ehObviamenteSeguro("conteudo fantastico").seguro).toBe(false);
    expect(ehObviamenteSeguro("conteudo fantastico", new Set(["fantastico"]))).toEqual({
      seguro: true,
    });
  });

  // Review Focus 4: gatilho vence aprovação, hoje e numa versão futura que
  // acrescente radicais à lista de gatilhos.
  it("gatilho vence palavra aprovada, mesmo que o dono a tenha liberado", () => {
    const v = ehObviamenteSeguro("otimo, quanto custa?", new Set(["custa", "quanto"]));
    expect(v.seguro).toBe(false);
    if (!v.seguro) expect(v.gatilho).toBe("preço");
  });

  it("aprovar não desarma o teto de tamanho nem a interrogação final", () => {
    const longo = `${"otimo ".repeat(40)}fantastico`;
    expect(ehObviamenteSeguro(longo, new Set(["fantastico"])).seguro).toBe(false);
    expect(ehObviamenteSeguro("fantastico?", new Set(["fantastico"])).seguro).toBe(false);
  });

  it("palavra aprovada FORA da forma normalizada não libera nada, e é por isso que quem grava normaliza", () => {
    expect(ehObviamenteSeguro("fantastico demais", new Set(["Fantástico"])).seguro).toBe(false);
    expect(ehObviamenteSeguro("fantastico demais", new Set(["fantastico"])).seguro).toBe(true);
  });

  it("conjunto vazio ou ausente se comporta igual ao de hoje", () => {
    expect(ehObviamenteSeguro("top", new Set())).toEqual({ seguro: true });
    expect(ehObviamenteSeguro("fantastico", new Set())).toEqual(
      ehObviamenteSeguro("fantastico"),
    );
  });
});

describe("pontuação e gatilhos multipalavra", () => {
  it("pontuação NÃO desarma gatilho multipalavra, nem com os componentes aprovados", () => {
    const a = new Set(["efeito", "colateral", "voce", "medico", "normal", "puedo", "tomar"]);
    for (const t of ["efeito, colateral", "voce, e medico", "voce... e medico", "normal, isso", "puedo, tomar"]) {
      expect(ehObviamenteSeguro(t, a).seguro, t).toBe(false);
    }
  });

  it("a interrogação final continua valendo: o colapso de pontuação é só para os gatilhos", () => {
    expect(ehObviamenteSeguro("top?").seguro).toBe(false);
  });
});


// ── C-2 (revisão final): a marcação apagava o gatilho ───────────────────────
//
// `semMarcacoes` rodava antes de tudo e os gatilhos julgavam o texto já
// podado, então um `@` na frente de QUALQUER palavra desarmava a trava. É
// regressão desta branch: antes dela, `\bmounjaro\b` casava o texto cru.
describe("C-2: @ na frente da palavra não apaga o gatilho", () => {
  const comArroba: [string, string][] = [
    ["@mounjaro top demais", "medicação"],
    ["@ozempic amei", "medicação"],
    ["top @dose", "medicação"],
    ["doutor @nutrologo top", "especialidade"],
    ["@valor show", "preço"],
    ["amei @agendamento", "agendamento"],
  ];

  it.each(comArroba)("%s continua barrado (%s)", (texto, categoria) => {
    expect(ehObviamenteSeguro(texto)).toEqual({ seguro: false, gatilho: categoria });
  });

  // Os quatro da spec §2 não podem ter sido sacrificados pelo conserto: a
  // marcação continua saindo da ANÁLISE DE TOKEN, só não sai dos gatilhos.
  it("marcação comum continua passando: @perfil não é conteúdo", () => {
    expect(ehObviamenteSeguro("@dr.andreluisc 💪💪💪")).toEqual({ seguro: true });
    expect(ehObviamenteSeguro("@fulano @ciclano top demais")).toEqual({ seguro: true });
    expect(ehObviamenteSeguro("@fulano quanto custa?")).toEqual({ seguro: false, gatilho: "preço" });
    expect(ehObviamenteSeguro("@fulano")).toEqual({ seguro: false, gatilho: "vazio" });
  });
});

// ── C-1 (revisão final): a oferta ao dono era cega a flexão ─────────────────
describe("C-1: ehTokenDeGatilho casa por RADICAL", () => {
  // Estas sete subiam ao TOPO da tela de aprovação, por frequência.
  it.each(["valores", "doses", "dores", "horarios", "especialistas", "nutrologos", "medicamentos"])(
    "%s NUNCA pode ser oferecida ao dono",
    (token) => {
      expect(ehTokenDeGatilho(token)).toBe(true);
    },
  );

  it.each(["quais", "didatico", "fantastico", "atendimento", "esclarecedor", "zebra"])(
    "%s continua sendo oferecida (o radical não pode comer a tela inteira)",
    (token) => {
      expect(ehTokenDeGatilho(token)).toBe(false);
    },
  );

  // A direção do erro é decidida: sobre-recusar custa uma palavra não
  // oferecida; sub-recusar custa a trava.
  it("sobre-recusa aceita: 'dormir' começa com o radical 'dor'", () => {
    expect(ehTokenDeGatilho("dormir")).toBe(true);
  });

  // NÃO radicalizamos os GATILHOS em si (seria PR próprio): "quais os
  // valores" reprova por vocabulário, não por gatilho de preço. Este teste
  // existe para que a troca dessa decisão seja deliberada.
  it("os GATILHOS continuam com \\b nos dois lados: a flexão reprova pelo vocabulário", () => {
    const v = ehObviamenteSeguro("quais os valores");
    expect(v.seguro).toBe(false);
    if (!v.seguro) expect(v.gatilho).toBe("sem padrão seguro reconhecido");
  });
});
