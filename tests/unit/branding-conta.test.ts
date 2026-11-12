import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  contaUrlDaMarca,
  lerMarcaDaConta,
  paresDoGuiaQueFalham,
  type RodadaDaConta,
} from "@/lib/branding/conta";

/**
 * Leitor da marca da Conta Eva Link (Plano 6, Tarefa 1). Cada caso responde por URL
 * com um `fetch` falso — o leitor não conhece rede, só o contrato
 * `GET {CONTA_URL}/api/marca` + `GET {CONTA_URL}/marca/logo/{escuro|claro}`.
 */

const CONTA = "https://conta.exemplo.test";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_CLARO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
const WEBP = new TextEncoder().encode("RIFF\x00\x00\x00\x00WEBPVP8 ");
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function corpo(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    versao: 1,
    nome_clinica: "  Clínica Exemplo  ",
    frase_clinica: null,
    paleta: { id: "verde-dourado" },
    cores: { principal: "#27463B", funda: "#1d352c", destaque: "#d8b45a" },
    logos: { escuro: sha(PNG), claro: sha(PNG_CLARO) },
    atualizado_em: "2026-11-10T12:00:00Z",
    ...extra,
  };
}

type Rota = (init?: RequestInit) => Response | Promise<Response>;

function fetchFalso(rotas: Record<string, Rota>) {
  const chamadas: { url: string; init?: RequestInit }[] = [];
  const f = (async (entrada: RequestInfo | URL, init?: RequestInit) => {
    const url = String(entrada);
    chamadas.push({ url, init });
    const rota = rotas[url];
    if (!rota) return new Response("nada", { status: 404 });
    return rota(init);
  }) as typeof fetch;
  return { f, chamadas };
}

const json = (b: unknown, etag = '"v1"') =>
  new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json", etag } });
const bytes = (b: Uint8Array) => new Response(b.slice(), { status: 200 });

function padrao(b = corpo(), extra: Record<string, Rota> = {}) {
  return fetchFalso({
    [`${CONTA}/api/marca`]: () => json(b),
    [`${CONTA}/marca/logo/escuro`]: () => bytes(PNG),
    [`${CONTA}/marca/logo/claro`]: () => bytes(PNG_CLARO),
    ...extra,
  });
}

function nova(r: RodadaDaConta) {
  if (r.tipo !== "nova") throw new Error(`esperava nova, veio ${JSON.stringify(r)}`);
  return r;
}

describe("lerMarcaDaConta", () => {
  it("200 válido com as duas logos → nova, cor minúscula, nome aparado, bytes e sha conferidos", async () => {
    const { f } = padrao();
    const r = nova(await lerMarcaDaConta(CONTA, null, { fetch: f }));
    expect(r.etag).toBe('"v1"');
    expect(r.marca).toEqual({
      nomeClinica: "Clínica Exemplo",
      corPrincipal: "#27463b",
      logos: { escuro: sha(PNG), claro: sha(PNG_CLARO) },
      atualizadoEm: "2026-11-10T12:00:00Z",
    });
    expect(r.logos.escuro).toEqual({ sha: sha(PNG), tipo: "png", bytes: PNG });
    expect(r.logos.claro).toEqual({ sha: sha(PNG_CLARO), tipo: "png", bytes: PNG_CLARO });
    expect(r.avisos).toEqual([]);
  });

  it("304 com If-None-Match enviado → igual", async () => {
    const { f, chamadas } = fetchFalso({
      [`${CONTA}/api/marca`]: () => new Response(null, { status: 304, headers: { etag: '"v1"' } }),
    });
    const r = await lerMarcaDaConta(CONTA, { etag: '"v1"', logos: { escuro: null, claro: null } }, { fetch: f });
    expect(r).toEqual({ tipo: "igual", etag: '"v1"' });
    expect(new Headers(chamadas[0]!.init?.headers).get("if-none-match")).toBe('"v1"');
  });

  it("sem etag anterior não manda If-None-Match", async () => {
    const { f, chamadas } = padrao();
    await lerMarcaDaConta(CONTA, null, { fetch: f });
    expect(new Headers(chamadas[0]!.init?.headers).get("if-none-match")).toBeNull();
  });

  it("prazo: o corpo nunca chega e o fetch ignora o sinal → falha", async () => {
    const { f } = fetchFalso({
      [`${CONTA}/api/marca`]: () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
    });
    const inicio = Date.now();
    const r = await lerMarcaDaConta(CONTA, null, { fetch: f, prazoMs: 50 });
    expect(r.tipo).toBe("falha");
    expect(Date.now() - inicio).toBeLessThan(1000);
  });

  it("prazo também cobre a logo", async () => {
    const { f } = padrao(corpo(), {
      [`${CONTA}/marca/logo/escuro`]: () => new Promise<Response>(() => {}),
    });
    const r = await lerMarcaDaConta(CONTA, null, { fetch: f, prazoMs: 50 });
    expect(r.tipo).toBe("falha");
  });

  it.each([
    ["503", () => new Response("fora", { status: 503 })],
    ["JSON inválido", () => new Response("{nao é json", { status: 200 })],
    ["versao 2", () => json(corpo({ versao: 2 }))],
    ["cor que não é hex", () => json(corpo({ cores: { principal: "verde", funda: "#1d352c", destaque: "#d8b45a" } }))],
  ])("%s → falha", async (_nome, rota) => {
    const { f } = fetchFalso({ [`${CONTA}/api/marca`]: rota });
    const r = await lerMarcaDaConta(CONTA, null, { fetch: f });
    expect(r.tipo).toBe("falha");
  });

  it("fetch que lança → falha, nunca lança", async () => {
    const f = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await expect(lerMarcaDaConta(CONTA, null, { fetch: f })).resolves.toMatchObject({ tipo: "falha" });
  });

  it("nome_clinica null → nomeClinica null; nome só de espaços também; nome longo corta em 80", async () => {
    for (const [entrada, esperado] of [
      [null, null],
      ["   ", null],
      ["x".repeat(100), "x".repeat(80)],
    ] as const) {
      const { f } = padrao(corpo({ nome_clinica: entrada }));
      const r = nova(await lerMarcaDaConta(CONTA, null, { fetch: f }));
      expect(r.marca.nomeClinica).toBe(esperado);
    }
  });

  it("paleta {principal} sem destaque → aceita", async () => {
    const { f } = padrao(corpo({ paleta: { principal: "#27463b" } }));
    nova(await lerMarcaDaConta(CONTA, null, { fetch: f }));
  });

  it("contraste reprovado → falha", async () => {
    const { f } = padrao(corpo({ cores: { principal: "#f0f0f0", funda: "#1d352c", destaque: "#d8b45a" } }));
    const r = await lerMarcaDaConta(CONTA, null, { fetch: f });
    expect(r).toMatchObject({ tipo: "falha" });
  });

  it("atualizado_em null → padrao", async () => {
    const { f } = padrao(corpo({ atualizado_em: null }));
    expect(await lerMarcaDaConta(CONTA, null, { fetch: f })).toEqual({ tipo: "padrao" });
  });

  it.each([
    ["sha divergente", () => bytes(PNG_CLARO)],
    ["404 com sha anunciado", () => new Response("x", { status: 404 })],
    ["WebP", () => bytes(WEBP)],
    ["SVG", () => bytes(SVG)],
    ["maior que 1 MiB", () => bytes(new Uint8Array(1024 * 1024 + 1).fill(0x89))],
  ])("logo escura com %s → nova, logo null e motivo", async (_nome, rota) => {
    const { f } = padrao(corpo(), { [`${CONTA}/marca/logo/escuro`]: rota });
    const r = nova(await lerMarcaDaConta(CONTA, null, { fetch: f }));
    expect(r.logos.escuro).toBeNull();
    expect(r.logos.claro).toMatchObject({ sha: sha(PNG_CLARO) });
    expect(r.marca.corPrincipal).toBe("#27463b");
    expect(r.avisos).toHaveLength(1);
    expect(r.avisos[0]).toMatch(/escuro/);
  });

  it("logo recusada → etag null, e a rodada seguinte pede a logo de novo em vez de cair no 304", async () => {
    let webp = true;
    const { f, chamadas } = fetchFalso({
      [`${CONTA}/api/marca`]: (init) =>
        new Headers(init?.headers).get("if-none-match") === '"v1"'
          ? new Response(null, { status: 304, headers: { etag: '"v1"' } })
          : json(corpo()),
      [`${CONTA}/marca/logo/escuro`]: () => bytes(webp ? WEBP : PNG),
      [`${CONTA}/marca/logo/claro`]: () => bytes(PNG_CLARO),
    });
    const r1 = nova(await lerMarcaDaConta(CONTA, null, { fetch: f }));
    expect(r1.logos.escuro).toBeNull();
    expect(r1.etag).toBeNull();

    webp = false;
    chamadas.length = 0;
    const r2 = nova(
      await lerMarcaDaConta(CONTA, { etag: r1.etag, logos: { escuro: null, claro: sha(PNG_CLARO) } }, { fetch: f }),
    );
    expect(chamadas.map((c) => c.url)).toContain(`${CONTA}/marca/logo/escuro`);
    expect(r2.logos.escuro).toMatchObject({ sha: sha(PNG) });
    expect(r2.logos.claro).toBe("mesma");
    expect(r2.etag).toBe('"v1"');
  });

  it("logo de 1 MiB exato passa", async () => {
    const grande = new Uint8Array(1024 * 1024);
    grande.set(PNG);
    const { f } = padrao(corpo({ logos: { escuro: sha(grande), claro: null } }), {
      [`${CONTA}/marca/logo/escuro`]: () => bytes(grande),
    });
    const r = nova(await lerMarcaDaConta(CONTA, null, { fetch: f }));
    expect(r.logos.escuro).toMatchObject({ sha: sha(grande) });
  });

  it("logo null de um tipo → pede uma só e usa para os dois", async () => {
    const { f, chamadas } = padrao(corpo({ logos: { escuro: sha(PNG), claro: null } }));
    const r = nova(await lerMarcaDaConta(CONTA, null, { fetch: f }));
    expect(chamadas.filter((c) => c.url.includes("/marca/logo/")).map((c) => c.url)).toEqual([
      `${CONTA}/marca/logo/escuro`,
    ]);
    expect(r.logos.escuro).toMatchObject({ sha: sha(PNG) });
    expect(r.logos.claro).toMatchObject({ sha: sha(PNG) });
  });

  it("as duas logos null → nada baixado", async () => {
    const { f, chamadas } = padrao(corpo({ logos: { escuro: null, claro: null } }));
    const r = nova(await lerMarcaDaConta(CONTA, null, { fetch: f }));
    expect(chamadas).toHaveLength(1);
    expect(r.logos).toEqual({ escuro: null, claro: null });
  });

  it('mesmo sha que anterior.logos → não baixa e devolve "mesma"', async () => {
    const { f, chamadas } = padrao();
    const r = nova(
      await lerMarcaDaConta(CONTA, { etag: '"v0"', logos: { escuro: sha(PNG), claro: null } }, { fetch: f }),
    );
    expect(r.logos.escuro).toBe("mesma");
    expect(r.logos.claro).toMatchObject({ sha: sha(PNG_CLARO) });
    expect(chamadas.map((c) => c.url)).not.toContain(`${CONTA}/marca/logo/escuro`);
  });
});

describe("contaUrlDaMarca", () => {
  it.each([
    [undefined, null],
    ["", null],
    ["   ", null],
    ["ftp://conta.x/", null],
    ["não é url", null],
    ["https://conta.x/", "https://conta.x"],
    ["http://localhost:3001", "http://localhost:3001"],
  ])("%j → %j", (valor, esperado) => {
    expect(contaUrlDaMarca({ CONTA_URL: valor })).toBe(esperado);
  });
});

describe("paresDoGuiaQueFalham", () => {
  it("verde-dourado passa nos três pares", () => {
    expect(paresDoGuiaQueFalham({ principal: "#27463b", funda: "#1d352c", destaque: "#d8b45a" })).toEqual([]);
  });

  it("nomeia o par que reprova", () => {
    const falhas = paresDoGuiaQueFalham({ principal: "#f0f0f0", funda: "#1d352c", destaque: "#1d352c" });
    expect(falhas).toHaveLength(2);
  });
});

describe("ícone da aba (Plano 7)", () => {
  const ICONE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
  const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const comIcone = (b: Uint8Array, anunciado = sha(b)) =>
    padrao(corpo({ icone: anunciado }), { [`${CONTA}/marca/icone`]: () => bytes(b) });

  it("campo ausente (Conta antiga) → nem marca.icone nem icone na rodada; não pede /marca/icone", async () => {
    const { f, chamadas } = padrao();
    const r = nova(await lerMarcaDaConta(CONTA, null, { fetch: f }));
    expect("icone" in r.marca).toBe(false);
    expect("icone" in r).toBe(false);
    expect(chamadas.some((c) => c.url.endsWith("/marca/icone"))).toBe(false);
  });

  it("sha anunciado → baixa /marca/icone e confere o sha", async () => {
    const { f } = comIcone(ICONE);
    const r = nova(await lerMarcaDaConta(CONTA, null, { fetch: f }));
    expect(r.marca.icone).toBe(sha(ICONE));
    expect(r.icone).toEqual({ sha: sha(ICONE), tipo: "png", bytes: ICONE });
    expect(r.etag).toBe('"v1"');
  });

  it("mesmo sha que o anterior → \"mesma\", sem baixar", async () => {
    const { f, chamadas } = comIcone(ICONE);
    const anterior = { etag: null, logos: { escuro: sha(PNG), claro: sha(PNG_CLARO), icone: sha(ICONE) } };
    const r = nova(await lerMarcaDaConta(CONTA, anterior, { fetch: f }));
    expect(r.icone).toBe("mesma");
    expect(chamadas.some((c) => c.url.endsWith("/marca/icone"))).toBe(false);
  });

  it("icone null → null na rodada (a Conta não tem ícone)", async () => {
    const { f } = padrao(corpo({ icone: null }));
    const r = nova(await lerMarcaDaConta(CONTA, null, { fetch: f }));
    expect(r.marca.icone).toBeNull();
    expect(r.icone).toBeNull();
    expect(r.avisos).toEqual([]);
  });

  it.each([
    ["sha diferente", ICONE, "f".repeat(64), "sha256 não confere"],
    ["JPEG (o apple-touch-icon só aceita PNG)", JPG, undefined, "ícone não é PNG"],
    ["WebP", WEBP, undefined, "não é PNG nem JPEG"],
  ])("%s → recusado: null, aviso e sem ETag", async (_, b, anunciado, motivo) => {
    const { f } = comIcone(b, anunciado ?? sha(b));
    const r = nova(await lerMarcaDaConta(CONTA, null, { fetch: f }));
    expect(r.icone).toBeNull();
    expect(r.marca.icone).not.toBeNull();
    expect(r.avisos).toEqual([`ícone recusado: ${motivo}`]);
    expect(r.etag).toBeNull();
  });

  it("404 do ícone anunciado → recusado, a rodada segue", async () => {
    const { f } = padrao(corpo({ icone: sha(ICONE) }));
    const r = nova(await lerMarcaDaConta(CONTA, null, { fetch: f }));
    expect(r.icone).toBeNull();
    expect(r.avisos).toEqual(["ícone recusado: HTTP 404"]);
  });
});
