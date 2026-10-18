/**
 * O NOME DA PÁGINA "SOBRE": coluna própria, e NUNCA LANÇA.
 *
 * `/legal/about` é pública e é a página que o Google lê na verificação do
 * aplicativo (tela de consentimento OAuth). O que este arquivo guarda:
 *
 *  1. o valor de `platform_branding.nome_da_apresentacao` vence, sem os espaços
 *     das pontas;
 *  2. a leitura é PRÓPRIA: pede só essa coluna, e o `COLUNAS` de
 *     `lib/branding/instalacao.ts` (tudo-ou-nada) não ganha a coluna nova. Se
 *     ganhasse, um app que sobe antes do apêndice do baseline perderia a marca do
 *     banco inteira, em toda tela;
 *  3. vazio, só espaço, nulo ou tipo errado cai no nome da marca da instalação;
 *  4. banco fora do ar, coluna ainda inexistente (app novo antes do apêndice do
 *     baseline: código 42703) e instalação sem linha NÃO lançam. Quem chama é uma
 *     página pública: uma exceção aqui é erro 500 para o revisor do Google;
 *  5. o memo de 30s existe, e uma FALHA não vira fato memoizado;
 *  6. o pior caso inteiro, com a pilha de marca de verdade (sem mock de
 *     `marcaDaSaida`): coluna inexistente, banco sem marca e `.env` sem nome. O
 *     nome é o padrão do produto, e a página abre.
 *
 * O banco é mockado por arquivo (é a fronteira de I/O) e `marcaDaSaida` também,
 * exceto no caso 6: a pilha de marca tem testes próprios (`branding-saida.test.ts`).
 * As asserções são sobre a DECISÃO (qual nome sai); a forma da consulta só é
 * medida no caso 2, porque ali a forma É a decisão.
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APP_NAME } from "@/lib/branding";

const banco = vi.hoisted(() => ({
  resposta: { data: null, error: null } as { data: unknown; error: unknown },
  /** Quando ligado, `createAdminClient()` explode: a simulação do banco fora. */
  explode: false,
  leituras: 0,
  consultas: [] as { tabela: string; colunas: string; id: unknown }[],
}));
const marcaDaSaida = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (banco.explode) throw new Error("conexão recusada");
    return {
      from: (tabela: string) => ({
        select: (colunas: string) => ({
          eq: (_coluna: string, id: unknown) => ({
            maybeSingle: async () => {
              banco.leituras += 1;
              banco.consultas.push({ tabela, colunas, id });
              return banco.resposta;
            },
          }),
        }),
      }),
    };
  },
}));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const MARCA = "Clínica Exemplo";
const APRESENTACAO = "Apresentação Exemplo";

/**
 * Uma instância NOVA do módulo por caso. O memo mora em `globalThis` (como o de
 * `lib/branding/icone-versao.ts`) e sobrevive ao `resetModules`: zera pela PORTA
 * do produto, e não apagando a chave interna na mão.
 */
async function carregar() {
  vi.resetModules();
  const modulo = await import("@/lib/legal/nome-da-apresentacao");
  modulo.invalidarNomeDaApresentacao();
  return modulo;
}

beforeEach(() => {
  banco.resposta = { data: null, error: null };
  banco.explode = false;
  banco.leituras = 0;
  banco.consultas = [];
  marcaDaSaida.mockReset();
  marcaDaSaida.mockResolvedValue({ nome: MARCA });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("nomeDaApresentacao: o que a coluna diz", () => {
  it("devolve o valor da coluna, sem os espaços das pontas", async () => {
    const { nomeDaApresentacao } = await carregar();
    banco.resposta = { data: { nome_da_apresentacao: `  ${APRESENTACAO}  ` }, error: null };

    expect(await nomeDaApresentacao()).toBe(APRESENTACAO);
    // Quando a coluna fala, a marca nem é consultada.
    expect(marcaDaSaida).not.toHaveBeenCalled();
  });

  it.each([
    ["vazia", ""],
    ["só com espaços", "   \n\t "],
    ["nula", null],
    ["de tipo errado", 42],
  ])("coluna %s cai no nome da marca da instalação", async (_rotulo, valor) => {
    const { nomeDaApresentacao } = await carregar();
    banco.resposta = { data: { nome_da_apresentacao: valor }, error: null };

    expect(await nomeDaApresentacao()).toBe(MARCA);
    // `null` = a classe B de `marcaDaSaida`: instalação, depois `.env`, depois o
    // padrão do produto (não há organização numa página pública).
    expect(marcaDaSaida).toHaveBeenCalledWith(null);
  });

  it("instalação sem linha em platform_branding cai no nome da marca", async () => {
    const { nomeDaApresentacao } = await carregar();
    banco.resposta = { data: null, error: null };

    expect(await nomeDaApresentacao()).toBe(MARCA);
  });
});

describe("nomeDaApresentacao: a leitura é própria", () => {
  it("pede só a coluna nova, da linha única da tabela", async () => {
    const { nomeDaApresentacao } = await carregar();
    banco.resposta = { data: { nome_da_apresentacao: APRESENTACAO }, error: null };

    await nomeDaApresentacao();

    // Uma coluna só: se faltar no banco, só esta leitura degrada.
    expect(banco.consultas).toEqual([
      { tabela: "platform_branding", colunas: "nome_da_apresentacao", id: 1 },
    ]);
  });

  it("o COLUNAS de instalacao.ts (tudo-ou-nada) não ganhou a coluna nova", () => {
    const fonte = fs.readFileSync(path.join(process.cwd(), "lib/branding/instalacao.ts"), "utf8");
    const casada = /const COLUNAS =\s*"([^"]+)"/.exec(fonte);

    // Controle: sem achar o `COLUNAS`, o caso de baixo passaria olhando para o nada.
    expect(casada, "não achei o COLUNAS em instalacao.ts; ajuste este caso à forma nova").not.toBeNull();
    expect(
      casada?.[1],
      "nome_da_apresentacao entrou no select da marca da instalação: coluna ausente (42703) " +
        "derruba a linha inteira e a instalação perde a marca do banco em TODA tela. " +
        "A coluna tem leitura própria em lib/legal/nome-da-apresentacao.ts.",
    ).not.toContain("nome_da_apresentacao");
  });
});

describe("nomeDaApresentacao: NUNCA LANÇA", () => {
  it("coluna ainda inexistente (app novo antes do apêndice) cai no nome da marca", async () => {
    const { nomeDaApresentacao } = await carregar();
    banco.resposta = {
      data: null,
      error: {
        code: "42703",
        message: "column platform_branding.nome_da_apresentacao does not exist",
      },
    };

    await expect(nomeDaApresentacao()).resolves.toBe(MARCA);
  });

  it("erro do PostgREST (banco fora, pooler sem resposta) cai no nome da marca", async () => {
    const { nomeDaApresentacao } = await carregar();
    banco.resposta = { data: null, error: { code: "08006", message: "connection failure" } };

    await expect(nomeDaApresentacao()).resolves.toBe(MARCA);
  });

  it("cliente que lança ao ser criado (conexão recusada) cai no nome da marca", async () => {
    const { nomeDaApresentacao } = await carregar();
    banco.explode = true;

    await expect(nomeDaApresentacao()).resolves.toBe(MARCA);
  });
});

describe("nomeDaApresentacao: o memo de 30s", () => {
  it("duas leituras seguidas vão ao banco uma vez só; invalidar força a seguinte", async () => {
    const { nomeDaApresentacao, invalidarNomeDaApresentacao } = await carregar();
    banco.resposta = { data: { nome_da_apresentacao: "Primeiro" }, error: null };
    expect(await nomeDaApresentacao()).toBe("Primeiro");

    banco.resposta = { data: { nome_da_apresentacao: "Segundo" }, error: null };
    expect(await nomeDaApresentacao(), "ainda dentro dos 30s: vem do memo").toBe("Primeiro");
    expect(banco.leituras).toBe(1);

    invalidarNomeDaApresentacao();
    expect(await nomeDaApresentacao()).toBe("Segundo");
    expect(banco.leituras).toBe(2);
  });

  it("passados os 30s o banco é perguntado de novo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { nomeDaApresentacao } = await carregar();
    banco.resposta = { data: { nome_da_apresentacao: "Primeiro" }, error: null };
    expect(await nomeDaApresentacao()).toBe("Primeiro");

    banco.resposta = { data: { nome_da_apresentacao: "Segundo" }, error: null };
    vi.setSystemTime(Date.now() + 31_000);
    expect(await nomeDaApresentacao()).toBe("Segundo");
    expect(banco.leituras).toBe(2);
  });

  it("uma FALHA não vira fato memoizado: o banco volta e o nome certo aparece", async () => {
    const { nomeDaApresentacao } = await carregar();
    banco.resposta = { data: null, error: { code: "08006", message: "connection failure" } };
    expect(await nomeDaApresentacao()).toBe(MARCA);

    banco.resposta = { data: { nome_da_apresentacao: APRESENTACAO }, error: null };
    expect(
      await nomeDaApresentacao(),
      "a falha foi servida do memo como se fosse leitura",
    ).toBe(APRESENTACAO);
  });
});

describe("nomeDaApresentacao: o pior caso, com a pilha de marca de verdade", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/branding/saida");
    vi.doUnmock("@/lib/branding/instalacao");
    vi.unstubAllEnvs();
  });

  it("sem coluna, sem marca no banco e sem nome no `.env`: o nome padrão do produto", async () => {
    // `marcaDaSaida` volta a ser a de verdade; só a leitura do banco da marca é
    // substituída (a instalação sem linha), e o `.env` fica sem `APP_NAME`.
    vi.stubEnv("APP_NAME", "");
    vi.doUnmock("@/lib/branding/saida");
    vi.doMock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => null }));
    banco.resposta = {
      data: null,
      error: {
        code: "42703",
        message: "column platform_branding.nome_da_apresentacao does not exist",
      },
    };

    const { nomeDaApresentacao } = await carregar();

    await expect(nomeDaApresentacao()).resolves.toBe(DEFAULT_APP_NAME);
  });
});
