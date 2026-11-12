import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O ARMAZÉM da marca da Conta (Plano 6, Tarefa 3) — `lib/branding/conta-armazem.ts`,
 * mais o que `marcaDaInstalacao()`, `/icon` e a versão do ícone fazem com ele.
 *
 * O banco e o bucket são falsos e gravam cada operação; o leitor da Conta é o de
 * verdade, com um `fetch` falso por URL. As asserções são sobre o que fica
 * GUARDADO, que é o contrato (última marca boa), não sobre a query montada.
 */

const banco = vi.hoisted(() => ({
  linha: null as Record<string, unknown> | null,
  erroConta: null as { code: string; message: string } | null,
  updates: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
  uploads: [] as { caminho: string; tipo: string }[],
  removidos: [] as string[],
  noBucket: [] as string[],
  uploadFalha: false,
  avisos: [] as string[],
  travar: false,
  aoListar: null as null | (() => void),
  /** Segura o PRIMEIRO upload até ser solto (rodada que trava no bucket). */
  travaDoUpload: null as null | Promise<void>,
}));

const CONTA_COLS = "conta_nome, conta_accent_hex";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: (cols: string) => {
        const consulta = {
          eq: () => consulta,
          abortSignal: () => consulta,
          maybeSingle: async () => {
            if (banco.travar) return new Promise(() => {});
            if (cols.startsWith(CONTA_COLS)) {
              return banco.erroConta ? { data: null, error: banco.erroConta } : { data: banco.linha, error: null };
            }
            // A consulta local (`COLUNAS` de instalacao.ts) não traz conta_*.
            if (!banco.linha) return { data: null, error: null };
            const local = Object.fromEntries(Object.entries(banco.linha).filter(([k]) => !k.startsWith("conta_")));
            return { data: local, error: null };
          },
        };
        return consulta;
      },
      update: (valores: Record<string, unknown>) => ({
        eq: () => ({
          select: async () => {
            banco.updates.push(valores);
            if (!banco.linha) return { data: [], error: null };
            banco.linha = { ...banco.linha, ...valores };
            return { data: [{ id: 1 }], error: null };
          },
        }),
      }),
      insert: async (valores: Record<string, unknown>) => {
        banco.inserts.push(valores);
        banco.linha = { ...valores };
        return { error: null };
      },
    }),
    storage: {
      from: () => ({
        upload: async (caminho: string, _b: unknown, opts: { contentType: string }) => {
          const trava = banco.travaDoUpload;
          banco.travaDoUpload = null;
          if (trava) await trava;
          if (banco.uploadFalha) return { error: { message: "maior que o limite" } };
          banco.uploads.push({ caminho, tipo: opts.contentType });
          banco.noBucket.push(caminho);
          return { error: null };
        },
        list: async () => {
          const data = banco.noBucket.map((c) => ({ name: c.replace("platform/", "") }));
          banco.aoListar?.();
          return { data, error: null };
        },
        remove: async (caminhos: string[]) => {
          banco.removidos.push(...caminhos);
          return { error: null };
        },
        download: async (caminho: string) => ({
          data: { arrayBuffer: async () => new TextEncoder().encode(`bytes:${caminho}`).buffer },
          error: null,
        }),
      }),
    },
  }),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: (m: string) => banco.avisos.push(m),
    error: (m: string) => banco.avisos.push(m),
    info: () => {},
    debug: () => {},
  },
}));

const CONTA = "https://conta.exemplo.test";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7]);
const WEBP = new TextEncoder().encode("RIFF\x00\x00\x00\x00WEBPVP8 ");
const ICONE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5, 5]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function corpo(extra: Record<string, unknown> = {}) {
  return {
    versao: 1,
    nome_clinica: "Clínica Exemplo",
    frase_clinica: null,
    paleta: { id: "verde-dourado" },
    cores: { principal: "#27463B", funda: "#1d352c", destaque: "#d8b45a" },
    logos: { escuro: null, claro: sha(PNG) },
    atualizado_em: "2026-11-10T12:00:00Z",
    ...extra,
  };
}

function contaFalsa(b: unknown, logos: Record<string, Uint8Array> = { claro: PNG }, status = 200) {
  const chamadas: string[] = [];
  const f = (async (u: RequestInfo | URL) => {
    const url = String(u);
    chamadas.push(url);
    if (url === `${CONTA}/api/marca`) {
      if (status !== 200) return new Response("", { status });
      return new Response(JSON.stringify(b), { status: 200, headers: { etag: '"v1"' } });
    }
    const lado = url.split("/").pop() ?? "";
    const bytes = logos[lado];
    return bytes ? new Response(bytes.slice(), { status: 200 }) : new Response("", { status: 404 });
  }) as typeof fetch;
  return { f, chamadas };
}

async function armazem() {
  vi.resetModules();
  return import("@/lib/branding/conta-armazem");
}

const LOCAL = { app_name: "Clínica Local", accent_hex: "#1f4e5f", seeded_from_env: false };

beforeEach(() => {
  banco.linha = { ...LOCAL };
  banco.erroConta = null;
  banco.updates = [];
  banco.inserts = [];
  banco.uploads = [];
  banco.removidos = [];
  banco.noBucket = [];
  banco.uploadFalha = false;
  banco.avisos = [];
  banco.travar = false;
  banco.aoListar = null;
  banco.travaDoUpload = null;
  globalThis.__rodadaDaConta = undefined;
  globalThis.__avisosDaConta = undefined;
  globalThis.__memoDaMarcaDaInstalacao = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("rodada nova", () => {
  it("grava conta_*, envia a logo como platform/conta-<sha>.png e invalida o memo", async () => {
    const { rodarMarcaDaConta } = await armazem();
    const aoGravar = vi.fn();
    const r = await rodarMarcaDaConta(CONTA, aoGravar, { fetch: contaFalsa(corpo()).f });
    expect(r).toBe("gravou");
    expect(aoGravar).toHaveBeenCalledTimes(1);
    expect(banco.uploads).toEqual([{ caminho: `platform/conta-${sha(PNG)}.png`, tipo: "image/png" }]);
    expect(banco.linha).toMatchObject({
      ...LOCAL, // a marca local não é tocada
      conta_nome: "Clínica Exemplo",
      conta_accent_hex: "#27463b",
      conta_logo_path: `platform/conta-${sha(PNG)}.png`,
      conta_logos: { escuro: sha(PNG), claro: sha(PNG) },
      conta_etag: '"v1"',
      conta_atualizado_em: "2026-11-10T12:00:00Z",
    });
    expect(typeof banco.linha?.conta_lida_em).toBe("string");
  });

  it("JPEG vai como .jpg — o CHECK da 0409 não aceita .jpeg", async () => {
    const { rodarMarcaDaConta } = await armazem();
    const b = corpo({ logos: { escuro: null, claro: sha(JPEG) } });
    await rodarMarcaDaConta(CONTA, () => {}, { fetch: contaFalsa(b, { claro: JPEG }).f });
    expect(banco.uploads).toEqual([{ caminho: `platform/conta-${sha(JPEG)}.jpg`, tipo: "image/jpeg" }]);
    expect(banco.linha?.conta_logo_path).toMatch(/^platform\/conta-[0-9a-f]{64}\.(png|jpg)$/);
  });

  it("logo WebP é recusada: a logo anterior fica, nome e cor entram, log uma vez", async () => {
    const antiga = `platform/conta-${"a".repeat(64)}.png`;
    banco.linha = { ...LOCAL, conta_logo_path: antiga, conta_logos: { escuro: "a".repeat(64), claro: "a".repeat(64) }, conta_etag: '"v0"', conta_atualizado_em: "2026-11-01T00:00:00Z" };
    const { rodarMarcaDaConta } = await armazem();
    const b = corpo({ nome_clinica: "Nome Novo", logos: { escuro: null, claro: sha(WEBP) } });
    await rodarMarcaDaConta(CONTA, () => {}, { fetch: contaFalsa(b, { claro: WEBP }).f });
    expect(banco.uploads).toEqual([]);
    expect(banco.linha).toMatchObject({
      conta_nome: "Nome Novo",
      conta_accent_hex: "#27463b",
      conta_logo_path: antiga,
      conta_logos: { escuro: "a".repeat(64), claro: "a".repeat(64) },
      conta_etag: null, // a próxima rodada tenta a logo de novo
    });
    expect(banco.avisos.filter((a) => a.includes("logo recusada"))).toHaveLength(1);
    // A mesma recusa na rodada seguinte: nada muda, nada grava, nada loga.
    banco.updates = [];
    const r = await rodarMarcaDaConta(CONTA, () => {}, { fetch: contaFalsa(b, { claro: WEBP }).f });
    expect(r).toBe("nada");
    expect(banco.updates).toEqual([]);
    expect(banco.avisos.filter((a) => a.includes("logo recusada"))).toHaveLength(1);
  });

  it("logo que o bucket recusa (tamanho) também mantém a anterior", async () => {
    banco.uploadFalha = true;
    const { rodarMarcaDaConta } = await armazem();
    await rodarMarcaDaConta(CONTA, () => {}, { fetch: contaFalsa(corpo()).f });
    expect(banco.linha).toMatchObject({ conta_nome: "Clínica Exemplo", conta_logo_path: null, conta_etag: null });
  });

  it("clínica sem logo na Conta limpa a logo guardada", async () => {
    banco.linha = { ...LOCAL, conta_logo_path: `platform/conta-${"a".repeat(64)}.png`, conta_logos: { escuro: null, claro: "a".repeat(64) }, conta_atualizado_em: "x" };
    const { rodarMarcaDaConta } = await armazem();
    await rodarMarcaDaConta(CONTA, () => {}, { fetch: contaFalsa(corpo({ logos: { escuro: null, claro: null } })).f });
    expect(banco.linha).toMatchObject({ conta_logo_path: null, conta_logos: { escuro: null, claro: null } });
  });

  it("troca de logo apaga só as velhas da Conta, nunca a anterior imediata", async () => {
    const velha = `platform/conta-${"b".repeat(64)}.png`;
    const anterior = `platform/conta-${"a".repeat(64)}.png`;
    banco.noBucket = [velha, anterior, "platform/11111111-1111-4111-8111-111111111111.png"];
    banco.linha = { ...LOCAL, conta_logo_path: anterior, conta_logos: { escuro: null, claro: "a".repeat(64) }, conta_atualizado_em: "x" };
    const { rodarMarcaDaConta } = await armazem();
    await rodarMarcaDaConta(CONTA, () => {}, { fetch: contaFalsa(corpo()).f });
    await new Promise((r) => setTimeout(r, 0));
    expect(banco.removidos).toEqual([velha]);
  });

  it("sem linha id=1, cria com seeded_from_env = true (a semeadura do .env ainda completa)", async () => {
    banco.linha = null;
    const { rodarMarcaDaConta } = await armazem();
    await rodarMarcaDaConta(CONTA, () => {}, { fetch: contaFalsa(corpo()).f });
    expect(banco.inserts).toHaveLength(1);
    expect(banco.inserts[0]).toMatchObject({ id: 1, seeded_from_env: true, conta_nome: "Clínica Exemplo" });
  });
});

describe("limpeza do bucket entre processos", () => {
  it("logo gravada por OUTRO processo durante a limpeza não é apagada", async () => {
    const velha = `platform/conta-${"b".repeat(64)}.png`;
    const anterior = `platform/conta-${"a".repeat(64)}.png`;
    banco.noBucket = [velha, anterior];
    banco.linha = { ...LOCAL, conta_logo_path: anterior, conta_logos: { escuro: null, claro: "a".repeat(64) }, conta_atualizado_em: "x" };
    // Entre o list e o remove, outro processo aponta para a `velha`.
    banco.aoListar = () => {
      banco.linha = { ...banco.linha, conta_logo_path: velha };
    };
    const { rodarMarcaDaConta } = await armazem();
    await rodarMarcaDaConta(CONTA, () => {}, { fetch: contaFalsa(corpo()).f });
    await new Promise((r) => setTimeout(r, 0));
    expect(banco.removidos).toEqual([]);
  });
});

describe("rodadas que não são nova", () => {
  it("igual (304) não grava nada", async () => {
    banco.linha = { ...LOCAL, conta_etag: '"v1"', conta_atualizado_em: "x" };
    const { rodarMarcaDaConta } = await armazem();
    const f = (async () => new Response(null, { status: 304 })) as unknown as typeof fetch;
    const aoGravar = vi.fn();
    expect(await rodarMarcaDaConta(CONTA, aoGravar, { fetch: f })).toBe("igual");
    expect(banco.updates).toEqual([]);
    expect(aoGravar).not.toHaveBeenCalled();
  });

  it("padrao sem nada da Conta guardado não grava — a marca local fica", async () => {
    const { rodarMarcaDaConta } = await armazem();
    const r = await rodarMarcaDaConta(CONTA, () => {}, { fetch: contaFalsa(corpo({ atualizado_em: null })).f });
    expect(r).toBe("nada");
    expect(banco.updates).toEqual([]);
    expect(banco.linha).toEqual(LOCAL);
  });

  it("padrao com marca da Conta guardada limpa conta_* (a clínica voltou ao padrão)", async () => {
    banco.linha = { ...LOCAL, conta_nome: "X", conta_accent_hex: "#27463b", conta_logo_path: null, conta_etag: '"v1"', conta_atualizado_em: "2026-11-01T00:00:00Z" };
    const { rodarMarcaDaConta } = await armazem();
    const aoGravar = vi.fn();
    await rodarMarcaDaConta(CONTA, aoGravar, { fetch: contaFalsa(corpo({ atualizado_em: null })).f });
    expect(banco.linha).toMatchObject({ ...LOCAL, conta_nome: null, conta_accent_hex: null, conta_etag: null, conta_atualizado_em: null });
    expect(aoGravar).toHaveBeenCalledTimes(1);
  });

  it("falha não grava e loga no máximo uma vez a cada 10 min", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { rodarMarcaDaConta } = await armazem();
    const { f } = contaFalsa(null, {}, 503);
    for (let i = 0; i < 3; i++) expect(await rodarMarcaDaConta(CONTA, () => {}, { fetch: f })).toBe("falha");
    expect(banco.updates).toEqual([]);
    expect(banco.avisos.filter((a) => a.includes("leitura falhou"))).toHaveLength(1);
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    await rodarMarcaDaConta(CONTA, () => {}, { fetch: f });
    expect(banco.avisos.filter((a) => a.includes("leitura falhou"))).toHaveLength(2);
  });

  it("colunas conta_* ausentes (42703, clone sem a 0409): nenhuma rodada, nenhum fetch", async () => {
    banco.erroConta = { code: "42703", message: "column conta_nome does not exist" };
    const { rodarMarcaDaConta } = await armazem();
    const { f, chamadas } = contaFalsa(corpo());
    expect(await rodarMarcaDaConta(CONTA, () => {}, { fetch: f })).toBe("sem-leitura");
    expect(chamadas).toEqual([]);
  });
});

describe("disparo preguiçoso", () => {
  it("sem CONTA_URL: nenhum fetch", async () => {
    vi.stubEnv("CONTA_URL", "");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const { dispararMarcaDaConta } = await armazem();
    dispararMarcaDaConta(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(f).not.toHaveBeenCalled();
  });

  it("com CONTA_URL: uma rodada só a cada 60 s, mesmo com muitos renders", async () => {
    vi.stubEnv("CONTA_URL", CONTA);
    const { f, chamadas } = contaFalsa(corpo());
    vi.stubGlobal("fetch", f);
    const { dispararMarcaDaConta } = await armazem();
    const aoGravar = vi.fn();
    for (let i = 0; i < 5; i++) dispararMarcaDaConta(aoGravar);
    await vi.waitFor(() => expect(aoGravar).toHaveBeenCalledTimes(1));
    dispararMarcaDaConta(aoGravar);
    await new Promise((r) => setTimeout(r, 10));
    expect(chamadas.filter((c) => c.endsWith("/api/marca"))).toHaveLength(1);
  });
});

describe("teto da rodada", () => {
  it("banco travado não prende a rodada para sempre: depois de 20 s a vez é liberada", async () => {
    vi.useFakeTimers();
    vi.stubEnv("CONTA_URL", CONTA);
    banco.travar = true;
    const { dispararMarcaDaConta, PRAZO_DA_RODADA_MS } = await armazem();
    dispararMarcaDaConta(() => {});
    expect(globalThis.__rodadaDaConta?.emVoo).toBe(true);
    await vi.advanceTimersByTimeAsync(PRAZO_DA_RODADA_MS + 1);
    expect(globalThis.__rodadaDaConta?.emVoo).toBe(false);
  });

  it("rodada que volta depois de uma mais nova ter gravado não grava o que leu", async () => {
    vi.useFakeTimers();
    vi.stubEnv("CONTA_URL", CONTA);
    let soltar!: () => void;
    banco.travaDoUpload = new Promise<void>((r) => (soltar = r));
    // 1ª chamada: a marca VELHA, com logo (trava no bucket). Depois: a NOVA, sem logo.
    let n = 0;
    const velha = contaFalsa(corpo({ nome_clinica: "Velha" })).f;
    const nova = contaFalsa(corpo({ nome_clinica: "Nova", logos: { escuro: null, claro: null } })).f;
    vi.stubGlobal("fetch", ((u: RequestInfo | URL) => (n++ < 2 ? velha(u) : nova(u))) as typeof fetch);
    const { dispararMarcaDaConta, PRAZO_DA_RODADA_MS } = await armazem();
    const aoGravar = vi.fn();
    dispararMarcaDaConta(aoGravar);
    await vi.advanceTimersByTimeAsync(PRAZO_DA_RODADA_MS + 60_000 + 1);
    dispararMarcaDaConta(aoGravar);
    await vi.waitFor(() => expect(aoGravar).toHaveBeenCalledTimes(1));
    expect(banco.linha?.conta_nome).toBe("Nova");

    soltar();
    await vi.advanceTimersByTimeAsync(10);
    expect(banco.linha?.conta_nome).toBe("Nova");
    expect(banco.updates).toHaveLength(1);
    expect(aoGravar).toHaveBeenCalledTimes(1);
  });
});

describe("versão do ícone acompanha a gravação da Conta", () => {
  it("uma rodada que grava ícone novo muda versaoDoIcone() na hora, sem esperar 30 s", async () => {
    vi.stubEnv("CONTA_URL", CONTA);
    vi.stubGlobal("fetch", contaFalsa(corpo({ icone: sha(ICONE) }), { claro: PNG, icone: ICONE }).f);
    const antigo = `platform/conta-${"a".repeat(64)}.png`;
    banco.linha = { ...LOCAL, conta_icone_path: antigo, conta_logos: { escuro: null, claro: null, icone: "a".repeat(64) }, conta_atualizado_em: "x" };
    vi.resetModules();
    const { versaoDoIcone, invalidarVersaoDoIcone } = await import("@/lib/branding/icone-versao");
    const { marcaDaInstalacao } = await import("@/lib/branding/instalacao");
    invalidarVersaoDoIcone();
    // Primeiro a versão vigente fica no memo (rodada bloqueada pela janela de 60 s).
    globalThis.__rodadaDaConta = { ultima: Date.now(), emVoo: false, geracao: 0 };
    expect(await versaoDoIcone()).toBe("aaaaaaaa");
    // Agora a rodada roda e grava o ícone novo.
    globalThis.__rodadaDaConta = undefined;
    await marcaDaInstalacao();
    await vi.waitFor(() => expect(banco.linha?.conta_icone_path).toBe(`platform/conta-${sha(ICONE)}.png`));
    globalThis.__rodadaDaConta = { ultima: Date.now(), emVoo: false, geracao: 0 };
    expect(await versaoDoIcone()).toBe(sha(ICONE).slice(0, 8));
  });
});

describe("ícone da Conta no armazém (Plano 7)", () => {
  const caminho = `platform/conta-${sha(ICONE)}.png`;

  it("ícone anunciado → envia platform/conta-<sha>.png e guarda caminho e sha", async () => {
    const { rodarMarcaDaConta } = await armazem();
    const b = corpo({ icone: sha(ICONE) });
    expect(await rodarMarcaDaConta(CONTA, () => {}, { fetch: contaFalsa(b, { claro: PNG, icone: ICONE }).f })).toBe("gravou");
    expect(banco.uploads).toContainEqual({ caminho, tipo: "image/png" });
    expect(banco.linha).toMatchObject({ conta_icone_path: caminho, conta_logos: { escuro: sha(PNG), claro: sha(PNG), icone: sha(ICONE) } });
  });

  it("icone null depois de ter tido → apaga caminho e sha (volta ao ícone próprio)", async () => {
    banco.linha = { ...LOCAL, conta_icone_path: caminho, conta_logos: { escuro: sha(PNG), claro: sha(PNG), icone: sha(ICONE) }, conta_logo_path: `platform/conta-${sha(PNG)}.png`, conta_atualizado_em: "x" };
    const { rodarMarcaDaConta } = await armazem();
    await rodarMarcaDaConta(CONTA, () => {}, { fetch: contaFalsa(corpo({ icone: null })).f });
    expect(banco.linha).toMatchObject({ conta_icone_path: null, conta_logos: { icone: null } });
  });

  it("campo ausente (Conta antiga) → o ícone guardado fica", async () => {
    banco.linha = { ...LOCAL, conta_icone_path: caminho, conta_logos: { escuro: sha(PNG), claro: sha(PNG), icone: sha(ICONE) }, conta_atualizado_em: "x" };
    const { rodarMarcaDaConta } = await armazem();
    await rodarMarcaDaConta(CONTA, () => {}, { fetch: contaFalsa(corpo()).f });
    expect(banco.linha).toMatchObject({ conta_icone_path: caminho, conta_logos: { icone: sha(ICONE) } });
  });

  it("ícone recusado (404) → o anterior fica e o ETag sai, para tentar de novo", async () => {
    banco.linha = { ...LOCAL, conta_icone_path: caminho, conta_logos: { escuro: null, claro: null, icone: sha(ICONE) }, conta_atualizado_em: "x" };
    const { rodarMarcaDaConta } = await armazem();
    await rodarMarcaDaConta(CONTA, () => {}, { fetch: contaFalsa(corpo({ icone: "e".repeat(64) })).f });
    expect(banco.linha).toMatchObject({ conta_icone_path: caminho, conta_logos: { icone: sha(ICONE) }, conta_etag: null });
  });

  it("a limpeza do bucket nunca apaga o ícone em uso", async () => {
    const velha = `platform/conta-${"b".repeat(64)}.png`;
    banco.noBucket = [velha, caminho];
    banco.linha = { ...LOCAL, conta_icone_path: caminho, conta_logo_path: velha, conta_logos: { escuro: null, claro: "b".repeat(64), icone: sha(ICONE) }, conta_atualizado_em: "x" };
    const { rodarMarcaDaConta } = await armazem();
    await rodarMarcaDaConta(CONTA, () => {}, { fetch: contaFalsa(corpo({ icone: sha(ICONE) }), { claro: PNG, icone: ICONE }).f });
    await vi.waitFor(() => expect(banco.uploads.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 10));
    expect(banco.removidos).not.toContain(caminho);
  });
});

describe("marcaDaInstalacao com a Conta", () => {
  async function instalacao() {
    vi.resetModules();
    return import("@/lib/branding/instalacao");
  }

  it("com CONTA_URL e conta guardada, a linha traz conta_*", async () => {
    vi.stubEnv("CONTA_URL", CONTA);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 304 })));
    banco.linha = { ...LOCAL, conta_nome: "Clínica Exemplo", conta_accent_hex: "#27463b", conta_logo_path: null };
    const { marcaDaInstalacao } = await instalacao();
    expect(await marcaDaInstalacao()).toMatchObject({ app_name: "Clínica Local", conta_nome: "Clínica Exemplo", conta_accent_hex: "#27463b" });
  });

  it("42703 nas colunas conta_*: a linha local volta inteira, sem lançar", async () => {
    vi.stubEnv("CONTA_URL", CONTA);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 304 })));
    banco.erroConta = { code: "42703", message: "column conta_nome does not exist" };
    const { marcaDaInstalacao } = await instalacao();
    const linha = await marcaDaInstalacao();
    expect(linha).toMatchObject(LOCAL);
    expect(linha).not.toHaveProperty("conta_nome");
  });

  it("sem CONTA_URL: nenhuma coluna conta_* entra, mesmo guardada, e nenhum fetch", async () => {
    vi.stubEnv("CONTA_URL", "");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    banco.linha = { ...LOCAL, conta_nome: "Guardada", conta_accent_hex: "#27463b" };
    const { marcaDaInstalacao } = await instalacao();
    expect(await marcaDaInstalacao()).toEqual(LOCAL);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("ícone da aba com a Conta", () => {
  async function icone(linha: Record<string, unknown> | null) {
    vi.resetModules();
    vi.doMock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => linha }));
    vi.doMock("next/og", () => ({ ImageResponse: class extends Response {} }));
    return (await import("@/app/icon")).default;
  }

  afterEach(() => {
    vi.doUnmock("@/lib/branding/instalacao");
    vi.doUnmock("next/og");
  });

  const daConta = `platform/conta-${"c".repeat(64)}.png`;
  const logoDaConta = `platform/conta-${"d".repeat(64)}.png`;
  const enviado = "platform/11111111-1111-4111-8111-111111111111.png";

  it("o ícone da Conta vence o enviado pela tela (a Conta é a fonte da marca)", async () => {
    banco.linha = { icone_path: enviado };
    const Icon = await icone({ conta_icone_path: daConta, conta_logo_path: logoDaConta });
    const res = await Icon();
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe(`bytes:${daConta}`);
  });

  it("sem ícone da Conta, o enviado; a logo da Conta NUNCA vai para a aba", async () => {
    banco.linha = { icone_path: enviado };
    const Icon = await icone({ conta_icone_path: null, conta_logo_path: logoDaConta });
    expect(await (await Icon()).text()).toBe(`bytes:${enviado}`);
  });

  it("sem ícone nenhum e com logo da Conta, desenha (não usa a logo comprida)", async () => {
    banco.linha = { icone_path: null };
    const Icon = await icone({ conta_icone_path: null, conta_logo_path: logoDaConta });
    expect(await (await Icon()).text()).not.toBe(`bytes:${logoDaConta}`);
  });

  it("a versão do ícone segue o caminho do ícone", async () => {
    const { versaoDoCaminho } = await import("@/lib/branding/icone-versao");
    expect(versaoDoCaminho(daConta)).toBe("cccccccc");
    expect(versaoDoCaminho(enviado)).toBe("11111111");
    expect(versaoDoCaminho(null)).toBe("d");
  });
});
