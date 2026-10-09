/**
 * O lembrete só é útil se acertar a HORA e não vazar entre organizações.
 *
 * As duas regras são testadas de formas diferentes de propósito:
 *
 * - `estaNaHora` e `montarLembrete` são puras, então o teste as exercita de
 *   verdade, inclusive nas bordas (cedo demais, tarde demais, exatamente na
 *   hora) — que é onde um lembrete deixa de ser lembrete.
 *
 * - O isolamento entre organizações é ESTRUTURAL: ele não vive numa função, vive
 *   no encadeamento da consulta. Montar um dublê de Supabase para provar isso
 *   testaria o dublê. O que prende é ler a fonte e cobrar o filtro — o mesmo
 *   estilo de `tests/unit/cron-audita-so-quando-ha-efeito.test.ts`, que varre o
 *   AST das rotas deste diretório.
 *
 * O medo é explícito no código que criou a coluna
 * (`app/api/v1/agenda/agendamentos/_handler.ts`): "no dia em que o worker de
 * lembrete nascer, esta linha vira a organização A mandando WhatsApp para o
 * cliente da B". Este é o dia, e esta é a cerca.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { providersDeEnvioAutomatico } from "@/lib/channels";
import { CHANNEL_PROVIDER_INSTAGRAM } from "@/lib/channels/capabilities";

import { degrausPendentes, escolherCanalDoLembrete, estaNaHora, montarLembrete } from "./route";

const MIN = 60_000;

describe("estaNaHora", () => {
  const agora = new Date("2026-08-31T12:00:00Z");

  it("não avisa cedo demais", () => {
    // compromisso em 3h, antecedência de 60 min: ainda não.
    const comeca = new Date(agora.getTime() + 180 * MIN);
    expect(estaNaHora(agora, comeca, 60)).toBe(false);
  });

  it("avisa quando a antecedência é alcançada", () => {
    const comeca = new Date(agora.getTime() + 59 * MIN);
    expect(estaNaHora(agora, comeca, 60)).toBe(true);
  });

  it("avisa no instante exato da fronteira", () => {
    const comeca = new Date(agora.getTime() + 60 * MIN);
    expect(estaNaHora(agora, comeca, 60)).toBe(true);
  });

  it("NÃO avisa compromisso que já começou", () => {
    // Lembrar às 15h de uma retirada das 14h não é lembrete, é ruído.
    const comeca = new Date(agora.getTime() - 1 * MIN);
    expect(estaNaHora(agora, comeca, 1440)).toBe(false);
  });

  it("NÃO avisa compromisso que começa exatamente agora", () => {
    expect(estaNaHora(agora, new Date(agora.getTime()), 1440)).toBe(false);
  });

  it("antecedência longa não antecipa o que ainda está longe", () => {
    // 30 dias de antecedência (o teto da coluna) com compromisso em 31 dias.
    const comeca = new Date(agora.getTime() + 31 * 24 * 60 * MIN);
    expect(estaNaHora(agora, comeca, 43_200)).toBe(false);
  });
});

describe("montarLembrete", () => {
  const quando = new Date("2026-08-31T12:45:00Z"); // 09:45 em São Paulo

  it("diz o quê, quando e onde", () => {
    const texto = montarLembrete({
      nomeDoContato: "Rose",
      titulo: "Retirada de manipulado — Poços de Caldas",
      quando,
      timezone: "America/Sao_Paulo",
      local: "R. Ceará, 300 — Centro",
    });

    expect(texto).toContain("Rose");
    expect(texto).toContain("Retirada de manipulado — Poços de Caldas");
    expect(texto).toContain("09:45");
    expect(texto).toContain("R. Ceará, 300 — Centro");
  });

  it("respeita o fuso da organização", () => {
    const emManaus = montarLembrete({
      nomeDoContato: null,
      titulo: "Retirada",
      quando,
      timezone: "America/Manaus", // uma hora atrás de São Paulo
      local: null,
    });
    expect(emManaus).toContain("08:45");
    expect(emManaus).not.toContain("09:45");
  });

  it("sem nome, cumprimenta sem inventar", () => {
    const texto = montarLembrete({
      nomeDoContato: null,
      titulo: "Retirada",
      quando,
      timezone: "America/Sao_Paulo",
      local: null,
    });
    expect(texto.startsWith("Oi!")).toBe(true);
    expect(texto).not.toContain("null");
    expect(texto).not.toContain("undefined");
  });

  it("sem endereço, não promete um", () => {
    const texto = montarLembrete({
      nomeDoContato: "Ana",
      titulo: "Retirada",
      quando,
      timezone: "America/Sao_Paulo",
      local: null,
    });
    expect(texto).not.toContain("Endereço");
  });
});

describe("isolamento entre organizações (estrutural)", () => {
  const fonte = readFileSync(join(__dirname, "route.ts"), "utf8");

  it("resolve o contato DENTRO da organização do compromisso", () => {
    // O trecho tem de conter a busca em `contacts` filtrada por organization_id.
    // Sem isso, um contact_id de outra organização viraria WhatsApp enviado ao
    // cliente dela — o defeito que o handler de agendamentos antecipa.
    const buscaDeContato = fonte.slice(fonte.indexOf('.from("contacts")'));
    expect(fonte).toContain('.from("contacts")');
    expect(buscaDeContato.slice(0, 400)).toContain('.eq("organization_id", org)');
  });

  it("resolve o canal DENTRO da organização do compromisso", () => {
    const buscaDeCanal = fonte.slice(fonte.indexOf('.from("channel_sessions")'));
    expect(fonte).toContain('.from("channel_sessions")');
    expect(buscaDeCanal.slice(0, 400)).toContain('.eq("organization_id", org)');
  });

  it("carimba o compromisso DENTRO da organização dele", () => {
    const carimbo = fonte.slice(fonte.indexOf("reminder_sent_at: new Date()"));
    expect(carimbo.slice(0, 400)).toContain('.eq("organization_id", org)');
  });

  it("a organização vem da linha do compromisso, nunca de parâmetro", () => {
    expect(fonte).toContain("const org = linha.organization_id");
    // controle: se alguém trocar por leitura de query string, isto reprova.
    expect(fonte).not.toContain("searchParams.get(\"organization_id\")");
  });
});

describe("degrausPendentes — o lembrete que tem mais de um degrau", () => {
  const comeca = new Date("2026-09-20T14:00:00.000Z");
  const base = { comeca, principal: 1440, extras: [180], jaEnviados: null as number[] | null };

  it("dois dias antes não deve nada — nem o degrau mais antecipado venceu", () => {
    expect(degrausPendentes({ ...base, agora: new Date("2026-09-18T14:00:00.000Z") })).toEqual([]);
  });

  it("um dia antes deve só o degrau de um dia", () => {
    expect(degrausPendentes({ ...base, agora: new Date("2026-09-19T15:00:00.000Z") })).toEqual([1440]);
  });

  it("três horas antes, com o de um dia já enviado, deve o de três horas", () => {
    expect(
      degrausPendentes({ ...base, agora: new Date("2026-09-20T11:30:00.000Z"), jaEnviados: [1440] }),
    ).toEqual([180]);
  });

  it("com os dois já enviados não deve nada — é o que impede a mensagem repetida", () => {
    expect(
      degrausPendentes({ ...base, agora: new Date("2026-09-20T13:00:00.000Z"), jaEnviados: [1440, 180] }),
    ).toEqual([]);
  });

  it("cron parado: dois degraus vencidos saem JUNTOS, para virarem uma mensagem só", () => {
    // Quem chama manda um texto e carimba os dois. Se esta função devolvesse um
    // por rodada, a pessoa receberia o mesmo aviso duas vezes seguidas.
    expect(degrausPendentes({ ...base, agora: new Date("2026-09-20T13:00:00.000Z") })).toEqual([1440, 180]);
  });

  it("depois de começar não deve nada — lembrete atrasado não é lembrete", () => {
    expect(degrausPendentes({ ...base, agora: new Date("2026-09-20T14:00:00.000Z") })).toEqual([]);
  });

  it("sem extras se comporta exatamente como antes", () => {
    const so = { ...base, extras: null };
    expect(degrausPendentes({ ...so, agora: new Date("2026-09-19T15:00:00.000Z") })).toEqual([1440]);
    expect(degrausPendentes({ ...so, agora: new Date("2026-09-19T15:00:00.000Z"), jaEnviados: [1440] })).toEqual([]);
  });

  it("extra igual ao principal não duplica o aviso", () => {
    expect(
      degrausPendentes({ ...base, extras: [1440], agora: new Date("2026-09-19T15:00:00.000Z") }),
    ).toEqual([1440]);
  });
});

describe("o cron NÃO pode filtrar por reminder_sent_at", () => {
  it("o filtro antigo não voltou — com ele o segundo degrau nunca sairia", () => {
    // Guarda estrutural: este filtro passou a ser errado quando o lembrete ganhou
    // degraus, e o erro não daria sinal nenhum — o compromisso simplesmente não
    // receberia o segundo aviso, em silêncio.
    //
    // Os comentários saem antes: o texto que EXPLICA o filtro é o mais parecido
    // com o filtro, e é ele que faria a asserção passar com o código removido.
    const fonte = readFileSync(join(__dirname, "route.ts"), "utf8").replace(/--[^\n]*|\/\/[^\n]*/g, "");
    expect(fonte).not.toMatch(/\.is\(\s*["']reminder_sent_at["']/);
    expect(fonte).toMatch(/reminder_sent_offsets_minutes/);
  });
});

describe("o carimbo vem ANTES do envio e é condicional (#2223, spec 3.9)", () => {
  const fonte = readFileSync(join(__dirname, "route.ts"), "utf8");
  const carimbo = fonte.slice(fonte.indexOf("reminder_sent_at: new Date()"));

  it("carimba antes de chamar o envio, e o erro do carimbo impede o envio", () => {
    expect(fonte.indexOf("reminder_sent_at: new Date()")).toBeGreaterThan(0);
    expect(fonte.indexOf("reminder_sent_at: new Date()")).toBeLessThan(fonte.indexOf("sendMessageHandler("));
    expect(fonte).toContain('pular("carimbo_falhou")');
  });

  it("só carimba a linha como foi LIDA — cancelada, remarcada ou carimbada por outra rodada não envia", () => {
    // Sem a condição, uma linha cancelada no meio da rodada (até 200 linhas,
    // 1,2 s + jitter cada) ou carimbada por uma rodada sobreposta seria
    // carimbada de novo e enviada: em dobro, ou com a data antiga.
    const update = carimbo.slice(0, 1600);
    expect(update).toContain('.eq("status", "confirmed")');
    expect(update).toContain('.eq("starts_at", linha.starts_at)');
    expect(update).toContain('.filter("reminder_sent_offsets_minutes", "eq"');
    expect(update).toContain('.eq("reminder_sent_at", linha.reminder_sent_at)');
    expect(update).toContain('.select("id")');
    expect(fonte).toContain('pular("mudou_na_rodada")');
  });
});

describe("a rota lê a régua da remarcação (#2230)", () => {
  const fonte = readFileSync(join(__dirname, "route.ts"), "utf8");

  it("seleciona starts_at_marked_at — sem a coluna na consulta não há por onde saber que a data mudou", () => {
    // Estrutural, como as de cima: o que a rota PEDE ao banco é propriedade do
    // texto, e um dublê de Supabase provaria o dublê. Sem a coluna no SELECT,
    // `linha.starts_at_marked_at` seria `undefined` e a régua voltaria a ser
    // `created_at` sem erro nenhum — o defeito nasceria calado.
    const consulta = fonte.slice(fonte.indexOf(".select("), fonte.indexOf('.eq("status"'));
    expect(consulta).toContain("starts_at_marked_at");
  });

  it("repassa os dois instantes para degrausPendentes e deixa a função decidir", () => {
    expect(fonte).toContain("remarcadoEm: linha.starts_at_marked_at");
    expect(fonte).toContain("criadoEm: linha.created_at");
    // A precedência mora na função, não na rota: `remarcadoEm` sabe do
    // movimento e `criadoEm` é o fallback da linha nunca remarcada.
    expect(fonte).toContain("input.remarcadoEm ?? input.criadoEm");
  });
});

describe("a rota repassa o instante do último carimbo (#2243)", () => {
  const fonte = readFileSync(join(__dirname, "route.ts"), "utf8");

  it("seleciona reminder_sent_at — a lista diz QUAIS degraus saíram, mas não QUANDO", () => {
    // Estrutural, como as acima: sem a coluna na consulta `linha.reminder_sent_at`
    // seria `undefined`, a limpeza ficaria fora do caminho em toda instalação e
    // o rearma nasceria calado — o defeito da #2243 voltaria sem erro nenhum.
    const consulta = fonte.slice(fonte.indexOf(".select("), fonte.indexOf('.eq("status"'));
    expect(consulta).toContain("reminder_sent_at");
  });

  it("repassa enviadoEm e deixa a limpeza morar na regra, não na rota", () => {
    expect(fonte).toContain("enviadoEm: linha.reminder_sent_at");
    expect(fonte).toContain("input.enviadoEm");
    // E o filtro de recebimento continua sendo a LISTA — `reminder_sent_at`
    // não volta a ser critério de quem recebe (a 0254 proíbe, prende o teste
    // "o cron NÃO pode filtrar por reminder_sent_at").
    expect(fonte).not.toMatch(/\.is\(\s*["']reminder_sent_at["']/);
  });
});

describe("a ferramenta de remarcar descreve o lembrete como esta rota o manda", () => {
  // A descrição é o que a IA repete ao cliente. Ela prometia "o lembrete é
  // refeito sozinho" quando nada refazia; depois da régua da remarcação a data
  // nova ganha o lembrete dela, MAS não o degrau que já venceu na remarcação.
  const ferramenta = readFileSync(join(process.cwd(), "lib/mcp/tools/agendamento.ts"), "utf8");
  const descricao = ferramenta.slice(ferramenta.indexOf('name: "crm_reschedule_appointment"'), ferramenta.indexOf("inputSchema: remarcarShape"));

  it("não promete mais do que o cron cumpre", () => {
    expect(descricao.length).toBeGreaterThan(0);
    expect(descricao).not.toContain("o lembrete é refeito sozinho");
    expect(descricao).toContain("lembrete da data nova");
  });

  it("diz as DUAS exceções do rearme — e o que fazer nelas", () => {
    // A guarda de meio intervalo (`degrausPendentes`, porte de e174c8484) segura
    // o aviso da data nova que cairia pouco depois de um lembrete já enviado —
    // de qualquer degrau. A descrição prometia o envio nesse caso, e a IA
    // dizia ao paciente que ele receberia um aviso que não sai.
    expect(descricao).toContain("dentro da antecedência do aviso");
    expect(descricao).toContain("pouco depois de um lembrete que já saiu");
    expect(descricao).toContain("na própria conversa");
  });
});

describe("o lembrete usa o texto do tipo, o fuso, a unidade e o profissional DO COMPROMISSO", () => {
  const fonte = readFileSync(join(__dirname, "route.ts"), "utf8");
  const consulta = fonte.slice(fonte.indexOf(".select("), fonte.indexOf('.eq("status"'));

  it("a varredura traz o fuso, o dono, a unidade embutida e o texto do tipo", () => {
    expect(consulta).toContain("time_zone");
    expect(consulta).toContain("owner_user_id");
    expect(consulta).toContain("reminder_body");
    // A unidade vem pela FK composta (organization_id, unit_id): ela só casa
    // unidade da MESMA organização, e o embed tira a consulta por linha.
    expect(consulta).toContain("calendar_units!calendar_appointments_unit_fk(name)");
    expect(fonte).not.toContain('.from("calendar_units")');
  });

  it("o fuso é o do compromisso, não o da organização", () => {
    expect(fonte).toContain("timezone: linha.time_zone,");
    expect(fonte).not.toMatch(/timezone: organizacao\?\.timezone/);
  });

  it("o GoTrue só é consultado quando o molde usa {{profissional}}, pela mesma extração da validação", () => {
    // `molde.includes("profissional")` cru deixaria `{{Profissional}}` passar
    // no PATCH e sair vazio em silêncio.
    const chamada = fonte.indexOf("nomesDosAtendentes(");
    expect(chamada).toBeGreaterThan(0);
    expect(fonte.slice(Math.max(0, chamada - 300), chamada)).toContain(
      'variaveisDoMolde(molde).includes("profissional")',
    );
  });

  it("o modelo legado continua saindo cru — o molde só vale para reminder_body", () => {
    const legado = fonte.slice(fonte.indexOf('.from("message_templates")'));
    expect(legado.slice(0, 600)).toContain("corpo = modelo.body");
    expect(fonte).toContain("if (!molde && tipo.reminder_template_name)");
  });
});

describe("escolherCanalDoLembrete — sempre um canal de envio automático, de preferência o da conversa", () => {
  const ZAP = providersDeEnvioAutomatico()[0] as string;
  // O Instagram não é de envio automático (a IA não responde por ele): é o
  // provider que o lembrete NUNCA pode escolher.
  const INSTA = CHANNEL_PROVIDER_INSTAGRAM as string;

  it("o controle do teste: o Instagram não está entre os de envio automático", () => {
    expect(ZAP).toBeTruthy();
    expect(providersDeEnvioAutomatico() as readonly string[]).not.toContain(INSTA);
  });

  it("prefere o número da conversa mais recente, mesmo que não seja o mais antigo", () => {
    const sessoes = [
      { id: "zap-antigo", provider: ZAP },
      { id: "zap-novo", provider: ZAP },
    ];
    expect(escolherCanalDoLembrete(sessoes, [{ channel_session_id: "zap-novo" }])).toBe("zap-novo");
  });

  it("conversa mais recente no Instagram: vale o WhatsApp da conversa mais antiga", () => {
    const sessoes = [
      { id: "zap-1", provider: ZAP },
      { id: "zap-2", provider: ZAP },
      { id: "insta", provider: INSTA },
    ];
    const conversas = [{ channel_session_id: "insta" }, { channel_session_id: "zap-2" }];
    expect(escolherCanalDoLembrete(sessoes, conversas)).toBe("zap-2");
  });

  it("sem conversa, o primeiro da lista — a ordem é de quem consulta", () => {
    expect(
      escolherCanalDoLembrete(
        [
          { id: "zap-1", provider: ZAP },
          { id: "zap-2", provider: ZAP },
        ],
        [],
      ),
    ).toBe("zap-1");
  });

  it("só Instagram conectado: nenhum canal — o lembrete pula, não sai pelo Instagram", () => {
    expect(escolherCanalDoLembrete([{ id: "insta", provider: INSTA }], [{ channel_session_id: "insta" }])).toBeNull();
  });

  it("conversa num número fora da lista (desconectado): cai no primeiro da lista", () => {
    expect(
      escolherCanalDoLembrete([{ id: "zap-1", provider: ZAP }], [{ channel_session_id: "zap-desconectado" }]),
    ).toBe("zap-1");
  });
});

describe("as consultas do canal (estrutural)", () => {
  const fonte = readFileSync(join(__dirname, "route.ts"), "utf8");

  it("sessões: da organização, WORKING, de envio automático, não arquivadas, em ordem fixa", () => {
    const sessoes = fonte.slice(fonte.indexOf('.from("channel_sessions")')).slice(0, 500);
    expect(sessoes).toContain('.eq("organization_id", org)');
    expect(sessoes).toContain('.eq("status", "WORKING")');
    expect(sessoes).toContain('.in("provider", [...providersDeEnvioAutomatico()])');
    expect(sessoes).toContain('.is("archived_at", null)');
    expect(sessoes).toContain('.order("created_at"');
    expect(sessoes).not.toContain(".limit(1)");
  });

  it("conversas: do contato, na organização, da mais recente para a mais antiga", () => {
    const conversas = fonte.slice(fonte.indexOf('.from("conversations")')).slice(0, 500);
    expect(fonte).toContain('.from("conversations")');
    expect(conversas).toContain('.eq("organization_id", org)');
    expect(conversas).toContain('.eq("contact_id", contato.id)');
    expect(conversas).toContain('.order("last_message_at"');
  });
});

describe("degrausPendentes — a véspera não sai no dia em que a reunião foi marcada", () => {
  // Amanhã 14h em São Paulo (17h UTC); avisos de 1 dia e de 1 hora.
  const comeca = new Date("2026-10-06T17:00:00.000Z");
  const base = { comeca, principal: 1440, extras: [60], jaEnviados: null as number[] | null, timezone: "America/Sao_Paulo" };

  it("marcou hoje às 9h para amanhã às 14h: a véspera de hoje às 14h não sai", () => {
    const criadoEm = new Date("2026-10-05T12:00:00.000Z");
    expect(degrausPendentes({ ...base, criadoEm, agora: new Date("2026-10-05T17:00:00.000Z") })).toEqual([]);
  });

  it("o aviso de 1 hora continua saindo amanhã", () => {
    const criadoEm = new Date("2026-10-05T12:00:00.000Z");
    expect(degrausPendentes({ ...base, criadoEm, agora: new Date("2026-10-06T16:00:00.000Z") })).toEqual([60]);
  });

  it("marcou ontem para amanhã: a véspera sai normalmente hoje", () => {
    const criadoEm = new Date("2026-10-04T12:00:00.000Z");
    expect(degrausPendentes({ ...base, criadoEm, agora: new Date("2026-10-05T17:00:00.000Z") })).toEqual([1440]);
  });

  it("o dia é o do fuso da organização, não o UTC", () => {
    // 22h de SP já é o dia seguinte em UTC; para SP a véspera (dia 5, 14h) é o mesmo dia.
    const criadoEm = new Date("2026-10-05T01:00:00.000Z"); // dia 4, 22h em SP
    expect(degrausPendentes({ ...base, criadoEm, agora: new Date("2026-10-05T17:00:00.000Z") })).toEqual([1440]);
  });

  it("aviso curto no dia da marcação não é afetado", () => {
    // Marcou hoje às 10h para hoje às 18h: o aviso das 17h sai.
    const hoje18 = new Date("2026-10-05T21:00:00.000Z");
    expect(
      degrausPendentes({ ...base, comeca: hoje18, criadoEm: new Date("2026-10-05T13:00:00.000Z"), agora: new Date("2026-10-05T20:00:00.000Z") }),
    ).toEqual([60]);
  });

  it("sem fuso a guarda fica fora do caminho", () => {
    const criadoEm = new Date("2026-10-05T12:00:00.000Z");
    expect(degrausPendentes({ ...base, timezone: null, criadoEm, agora: new Date("2026-10-05T17:00:00.000Z") })).toEqual([1440]);
  });
});

describe("vesperaNoDiaDaMarcacao — fuso ilegível não derruba a rodada", () => {
  it("fuso inválido devolve false em vez de lançar (o cron é de todas as organizações)", async () => {
    const { vesperaNoDiaDaMarcacao } = await import("./route");
    const marcadoEm = new Date("2026-10-05T12:00:00Z");
    const comeca = new Date("2026-10-06T17:00:00Z");
    expect(() => vesperaNoDiaDaMarcacao(comeca, 1440, marcadoEm, "Brasilia")).not.toThrow();
    expect(vesperaNoDiaDaMarcacao(comeca, 1440, marcadoEm, "Brasilia")).toBe(false);
  });
});
