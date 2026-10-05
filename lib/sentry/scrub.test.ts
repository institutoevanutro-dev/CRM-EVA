import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { scrubMessage, scrubUrl, sentryScrubHooks } from "./scrub";

// Issue #100. O que estes testes travam: com `tracesSampleRate: 1` e sem
// `beforeSendTransaction`/`beforeSendSpan`/`beforeBreadcrumb`, a URL crua saía do
// servidor do self-hoster em 6 campos (transaction, request.url, url.full,
// http.url, url.path, http.target). As rotas de webhook por tenant têm CREDENCIAL
// no path, e na instalação padrão esse token é a credencial inteira da rota,
// porque a exigência de assinatura nasce desligada.

const TOKEN = "wht_9f3a1c8b2e4d6a0f";

describe("scrubUrl", () => {
  it("redige o token das rotas em que ele é credencial, inclusive canal novo", () => {
    for (const path of [
      `/api/v1/webhooks/in/${TOKEN}`,
      `/api/v1/webhooks/canal-qualquer/${TOKEN}`,
      `/team/accept-invite/${TOKEN}`,
    ]) {
      const out = scrubUrl(`https://crm.exemplo.com${path}`);
      expect(out).not.toContain(TOKEN);
      expect(out).toContain("[TOKEN]");
    }
  });

  it("NÃO redige os segmentos [id], que são UUID e servem pra depurar", () => {
    const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const out = scrubUrl(`https://crm.exemplo.com/api/v1/ai/agents/${uuid}/runs`);
    // Redigir tudo cegamente tornaria o Sentry inútil — o oposto do objetivo.
    expect(out).toContain(uuid);
  });

  it("apaga o VALOR da query preservando a CHAVE", () => {
    const out = scrubUrl("https://crm.exemplo.com/api/v1/leads?cursor=abc123&limit=50");
    expect(out).toContain("cursor=[REDACTED]");
    expect(out).toContain("limit=[REDACTED]");
    expect(out).not.toContain("abc123");
  });

  it("redige query CRUA, sem `?` na frente — é assim que vem em request.query_string", () => {
    // Regressão: a primeira versão exigia `?` ou `&` antes da chave, e a assinatura
    // sobrevivia neste campo. Só apareceu ao rodar o envelope inteiro.
    expect(scrubUrl("sig=ASSINATURA123&t=9")).toBe("sig=[REDACTED]&t=[REDACTED]");
  });

  it("não estraga texto que não é query", () => {
    expect(scrubUrl("GET https://crm.exemplo.com/api/v1/leads")).toBe(
      "GET https://crm.exemplo.com/api/v1/leads",
    );
  });

  it("pega o token mesmo com query junto", () => {
    const out = scrubUrl(`https://crm.exemplo.com/api/v1/webhooks/in/${TOKEN}?sig=deadbeef`);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("deadbeef");
  });
});

describe("scrubMessage", () => {
  it("substitui CPF, telefone e e-mail", () => {
    const out = scrubMessage("falha para 123.456.789-01, +55 11 98765-4321, joao@exemplo.com");
    expect(out).toContain("[CPF]");
    expect(out).toContain("[PHONE]");
    expect(out).toContain("[EMAIL]");
    expect(out).not.toContain("123.456.789-01");
    expect(out).not.toContain("joao@exemplo.com");
  });
});

describe("sentryScrubHooks", () => {
  const urlComToken = `https://crm.exemplo.com/api/v1/webhooks/in/${TOKEN}?sig=deadbeef`;

  it("limpa header sensível por padrão, inclusive de integração que ainda não existe", () => {
    const event = sentryScrubHooks.beforeSend({
      request: {
        url: urlComToken,
        headers: {
          authorization: "Bearer segredo",
          "x-canal-novo-api-key": "chave-de-integracao-futura",
          "x-algum-token": "outro-segredo",
          "content-type": "application/json",
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(event.request?.headers).not.toHaveProperty("authorization");
    // O ponto do padrão: header de integração nova já nasce coberto.
    expect(event.request?.headers).not.toHaveProperty("x-canal-novo-api-key");
    expect(event.request?.headers).not.toHaveProperty("x-algum-token");
    expect(event.request?.headers).toHaveProperty("content-type");
    expect(JSON.stringify(event)).not.toContain(TOKEN);
  });

  it("beforeSendTransaction limpa os atributos de trace — o canal que não tinha guarda", () => {
    const event = sentryScrubHooks.beforeSendTransaction({
      transaction: `GET /api/v1/webhooks/in/${TOKEN}`,
      request: { url: urlComToken },
      contexts: {
        trace: {
          data: {
            "url.full": urlComToken,
            "http.url": urlComToken,
            "url.path": `/api/v1/webhooks/in/${TOKEN}`,
            "http.target": `/api/v1/webhooks/in/${TOKEN}?sig=deadbeef`,
          },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // O teste que importa: o token não sobrevive em NENHUM campo do envelope.
    expect(JSON.stringify(event)).not.toContain(TOKEN);
    expect(JSON.stringify(event)).not.toContain("deadbeef");
  });

  it("beforeSendSpan limpa description e data", () => {
    const span = sentryScrubHooks.beforeSendSpan({
      description: `GET ${urlComToken}`,
      data: { "url.full": urlComToken },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(JSON.stringify(span)).not.toContain(TOKEN);
  });

  it("beforeBreadcrumb limpa a URL — o README prometia isso sem mecanismo", () => {
    const crumb = sentryScrubHooks.beforeBreadcrumb({
      message: `fetch ${urlComToken}`,
      data: { url: urlComToken },
    });
    expect(JSON.stringify(crumb)).not.toContain(TOKEN);
  });
});

// M5 (auditoria 2026-09-29): o scrub não cobria `extra`, `user`, breadcrumb de
// console nem telefone formatado.
describe("scrub — o que ainda vazava", () => {
  it.each([
    "(11) 98765-4321",
    "+55 (11) 9 8765-4321",
    "11 9 8765 4321",
    "5511987654321",
    "+5511987654321",
    "11987654321",
    "(21) 3456-7890",
  ])("telefone formatado %s vira [PHONE] inteiro", (tel) => {
    const out = scrubMessage(`falha ao enviar para ${tel} agora`);
    expect(out).toBe("falha ao enviar para [PHONE] agora");
  });

  it("não come UUID nem data", () => {
    const txt = "lead 12345678-1234-4123-8123-123456789012 em 2026-09-29T10:00:00Z";
    expect(scrubMessage(txt)).toBe(txt);
  });

  it("beforeSend apaga extra e user", () => {
    const ev = sentryScrubHooks.beforeSend({
      message: "x", extra: { telefone: "11987654321" }, user: { email: "a@b.com", ip_address: "1.2.3.4" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(ev.extra).toBeUndefined();
    expect(ev.user).toBeUndefined();
  });

  it("breadcrumb de console é descartado (console.error carrega dado de paciente)", () => {
    expect(sentryScrubHooks.beforeBreadcrumb({ category: "console", message: "Joana 11987654321" })).toBeNull();
    expect(sentryScrubHooks.beforeBreadcrumb({ category: "fetch", message: "GET /x" })).not.toBeNull();
  });
});


// Porte de melgarafael/DeskcommCRM 126efd2e3, bb2469f90 e c6bee7d6a — a ideia e os
// casos, não o diff (o `scrubMessage` daqui foi reescrito na auditoria M5). O
// mesmo texto é o `error_message` que a tela IA › Execuções mostra. O critério é
// o número SUMIR, não o rótulo: 11 dígitos crus são CPF ou celular.
describe("scrubMessage — os formatos que ainda passavam", () => {
  it("apaga telefone nos jeitos em que se escreve no Brasil, com ou sem DDD", () => {
    for (const tel of [
      "(11) 98765-4321",
      "(11)98765-4321",
      "(11) 3456-7890",
      "11 98765-4321",
      "11 98765 4321",
      "11987654321",
      "5511987654321",
      "+55 11 98765-4321",
      "+55 (11) 98765-4321",
      "98765-4321",
      "98765 4321",
      "3456-7890",
      "11-98765-4321",
      "11.98765.4321",
      "(11)-98765-4321",
      "98765.4321",
      "(11) 9 8765-4321",
      "+55 (11) 9 8765-4321",
    ]) {
      const out = scrubMessage(`meu zap ${tel}, obrigado`);
      expect(out, tel).not.toMatch(/\d{3}/);
      expect(out, tel).toMatch(/^meu zap \[(PHONE|CPF)\], obrigado$/);
    }
  });

  // Quem digita rápido não segue a máscara.
  it("apaga CPF com qualquer separador entre os blocos", () => {
    for (const cpf of [
      "123.456.789-09",
      "123 456 789 09",
      "123.456.789.09",
      "123-456-789-09",
      "123.456.789 09",
      "12345678909",
    ]) {
      const out = scrubMessage(`meu cpf ${cpf}, obrigado`);
      expect(out, cpf).not.toMatch(/\d{3}/);
      expect(out, cpf).toMatch(/^meu cpf \[(PHONE|CPF)\], obrigado$/);
    }
  });

  it("dois telefones na mesma frase saem os dois", () => {
    expect(scrubMessage("98765-4321 ou (21) 3456-7890")).toBe("[PHONE] ou [PHONE]");
  });

  // Uma borda de letra/hífen nos padrões (posta para poupar UUID) deixava sair
  // inteiro o número grudado justamente nos rótulos que alguém digita colado.
  it("apaga CPF e telefone grudados no rótulo, inclusive por hífen", () => {
    for (const [texto, rotulo] of [
      ["zap11987654321", "zap"],
      ["cpf12345678909", "cpf"],
      ["CPF123.456.789-09", "CPF"],
      ["doc12345678909", "doc"],
      ["fone11987654321", "fone"],
      ["telefone11987654321", "telefone"],
      ["tel-11987654321", "tel-"],
      ["lead-123.456.789-09", "lead-"],
      // Só no fork: fixo (10 dígitos) e número com o 55 na frente.
      ["fixo1134567890", "fixo"],
      ["zap5511987654321", "zap"],
    ] as const) {
      const out = scrubMessage(texto);
      expect(out, texto).not.toMatch(/\d{3}/);
      expect(out, texto).toMatch(new RegExp(`^${rotulo}\\[(PHONE|CPF)\\]$`));
    }
    expect(scrubMessage("12345678909-joao")).toMatch(/^\[(PHONE|CPF)\]-joao$/);
  });

  it("apaga o CPF e poupa o UUID na mesma frase", () => {
    const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const out = scrubMessage(`cpf12345678909 no agente ${uuid}`);
    expect(out).toMatch(/^cpf\[(PHONE|CPF)\] no agente /);
    expect(out).toContain(uuid);
  });

  // Um UUID fixo passa por sorte. Por isso milhares, gerados de forma
  // determinística (sha256 do índice): a mesma amostra em toda execução, e uma
  // falha reproduzível pelo índice.
  it("não come pedaço de UUID — em milhares deles", () => {
    const alterados: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const h = createHash("sha256").update(`uuid-${i}`).digest("hex");
      const variante = "89ab"[parseInt(h[16]!, 16) % 4];
      const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variante}${h.slice(17, 20)}-${h.slice(20, 32)}`;
      const texto = `agente ${uuid} falhou`;
      if (scrubMessage(texto) !== texto) alterados.push(`${i}: ${uuid} -> ${scrubMessage(texto)}`);
    }
    expect(alterados.slice(0, 5)).toEqual([]);
  });

  // Só no fork: sem borda de letra, um trecho de 10 ou 11 dígitos entre letras
  // de um hash casava como telefone ou CPF — medido, 597 de 5.000 sha256, 337 de
  // 5.000 sha1 e 281 de 5.000 ids de 32 saíam alterados.
  it("não come pedaço de hash em hexadecimal — em milhares deles", () => {
    const alterados: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const sha256 = createHash("sha256").update(`hash-${i}`).digest("hex");
      const sha1 = createHash("sha1").update(`hash-${i}`).digest("hex");
      for (const id of [sha256, sha1, sha256.slice(0, 32)]) {
        const texto = `requisição req_${id} recusada`;
        if (scrubMessage(texto) !== texto) alterados.push(`${i}: ${texto} -> ${scrubMessage(texto)}`);
      }
    }
    expect(alterados.slice(0, 5)).toEqual([]);
  });

  it("não come pedaço de hora, de data nem de nome de modelo", () => {
    for (const txt of [
      "em 2026-09-23T18:46:39Z",
      "em 2026-09-23 18:46:39",
      "modelo claude-3-5-sonnet-20241022 recusou",
    ]) {
      expect(scrubMessage(txt), txt).toBe(txt);
    }
  });

  // Só no fork: sem borda de letra, o padrão de 11 dígitos comeria o começo de
  // um código numérico longo e deixaria o resto — nem apaga, nem deixa depurar.
  it("código numérico mais longo que um telefone fica inteiro", () => {
    for (const txt of ["conta 123456789012345 recusada", "arquivo 20260706210000_0027_x.sql"]) {
      expect(scrubMessage(txt), txt).toBe(txt);
    }
  });

  // O e-mail sai ANTES dos números: senão o telefone comia a parte numérica do
  // endereço e o domínio seguia inteiro.
  it("e-mail que começa por número sai inteiro", () => {
    expect(scrubMessage("falha para 11987654321@exemplo.com")).toBe("falha para [EMAIL]");
  });
});
