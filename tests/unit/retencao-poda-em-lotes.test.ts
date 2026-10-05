import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  GET,
  MAX_LOTES,
  type PodaDb,
  TAMANHO_DO_LOTE,
  houveEfeito,
  podarHistorico,
} from "@/app/api/v1/cron/data-retention/route";

import { logger } from "@/lib/logger";
import {
  RETENCAO_AUDITORIA_DIAS_PADRAO,
  RETENCAO_AUDITORIA_DIAS_PISO,
  RETENCAO_ESPELHO_AGENDA_DIAS_PADRAO,
  RETENCAO_ESPELHO_AGENDA_DIAS_PISO,
  RETENCAO_FILA_DIAS_PADRAO,
  RETENCAO_FILA_DIAS_PISO,
  interpretarRetencao,
} from "@/lib/retencao/politica";

vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_CRON_SECRET: "segredo",
    INTERNAL_SECRET: "",
    JOB_QUEUE_RETENTION_DAYS: "",
    AUDIT_LOG_RETENTION_DAYS: "",
  },
}));
// A limpeza de payloads da coexistência tem teste próprio (retencao-da-sincronizacao-meta).
const limparPayloads = vi.fn(async (): Promise<number> => 0);
vi.mock("@/lib/retencao/sincronizacao-meta", () => ({ limparPayloadsDaSincronizacao: () => limparPayloads() }));
const auditou = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...args: unknown[]) => auditou(...args) }));

/** O que o `rpc` do admin client devolve nesta rodada (o handler HTTP usa isto). */
let respostaRpc: { data: number | null; error: { message: string } | null } = {
  data: 0,
  error: null,
};
/** Resposta de UMA função, quando o caso precisa que só ela falhe (ou só ela apague). */
let respostaPorFuncao: Record<string, { data: unknown; error: { message: string } | null }> = {};
/** Tudo que a rodada mandou ao banco por `rpc`, com os NOMES dos argumentos. */
const chamadasRpc: { nome: string; args: Record<string, unknown> }[] = [];
/** As tabelas que a rodada leu — é como se vê que a retomada da LGPD rodou. */
const tabelasLidas: string[] = [];
/**
 * As linhas que a varredura de anonimização enxerga nesta rodada. Vazio por
 * padrão: os casos deste arquivo medem a PODA, e uma varredura com trabalho a
 * fazer acrescentaria linhas de auditoria que confundiriam a contagem — o que a
 * varredura faz é medido em `lgpd-varredura-completa-a-cascata.test.ts`.
 */
let contatosAnonimizados: Array<{ id: string; organization_id: string }> = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (nome: string, args?: Record<string, unknown>) => {
      chamadasRpc.push({ nome, args: args ?? {} });
      return respostaPorFuncao[nome] ?? respostaRpc;
    },
    from: (tabela: string) => {
      tabelasLidas.push(tabela);
      const q: Record<string, unknown> = {
        eq: () => q,
        in: () => q,
        limit: () => q,
        then: (r: (v: unknown) => unknown) =>
          Promise.resolve({ data: contatosAnonimizados, error: null }).then(r),
      };
      return { select: () => q, update: () => q };
    },
  }),
}));

/**
 * O LAÇO DE LOTES DA PODA — issue #261.
 *
 * O DELETE em lotes não é preciosismo: um DELETE único num banco de cliente com
 * anos de histórico segura a tabela pelo tempo inteiro da varredura, e o produto
 * é instalado em VPS sem janela de manutenção. Três propriedades sustentam isso,
 * e as três são invisíveis a olho nu:
 *
 *   1. o laço PARA no primeiro lote incompleto (senão gasta uma ida ao banco a
 *      cada rodada só para ouvir zero, 1×/dia, para sempre);
 *   2. o laço tem TETO por invocação (senão a primeira rodada de uma instalação
 *      antiga segura o `curl` do cron até o timeout de 120 s e deixa a última
 *      transação para o servidor abortar sozinho);
 *   3. quando o teto é atingido, o resultado DIZ que sobrou trabalho — silêncio
 *      aqui seria indistinguível de "acabou".
 *
 * A régua deste arquivo é a REGRA (o laço, o teto, a interpretação do knob). O
 * que o banco de fato apaga — e o que ele se recusa a apagar — é medido contra
 * um Postgres real em `tests/invariants/retencao-poda-e-expurgo.test.ts`.
 */
function bancoQueDevolve(sequencias: {
  fila: number[];
  auditoria: number[];
}): { db: PodaDb; chamadas: { nome: string; dias: number; limite: number }[] } {
  const chamadas: { nome: string; dias: number; limite: number }[] = [];
  const restante = { fila: [...sequencias.fila], auditoria: [...sequencias.auditoria] };
  const db: PodaDb = {
    async rpc(nome, args) {
      chamadas.push(
        "p_dias" in args
          ? { nome, dias: args.p_dias, limite: args.p_lote }
          : { nome, dias: args.p_retencao_dias, limite: args.p_limite },
      );
      const balde = nome === "fn_podar_fila_de_jobs" ? restante.fila : restante.auditoria;
      return { data: balde.shift() ?? 0, error: null };
    },
  };
  return { db, chamadas };
}

describe("interpretarRetencao — o knob nunca derruba o produto", () => {
  it("ausente ou vazio devolve o padrão, sem aviso", () => {
    // É o caminho de toda instalação que nunca editou `.env` — a doutrina de
    // packaging exige que ele funcione sem edição manual de arquivo.
    for (const bruto of [undefined, "", "   "]) {
      const r = interpretarRetencao(bruto, { chave: "K", padrao: 90, piso: 7 });
      expect(r).toEqual({ dias: 90, aviso: null });
    }
  });

  it("lixo devolve o padrão COM aviso — nunca a frase tranquilizadora", () => {
    for (const bruto of ["noventa", "90d", "-1", "0", "1.5", "NaN"]) {
      const r = interpretarRetencao(bruto, { chave: "K", padrao: 90, piso: 7 });
      expect(r.dias, `entrada ${bruto}`).toBe(90);
      expect(r.aviso, `entrada ${bruto} sem aviso`).toContain("K=");
    }
  });

  it("valor abaixo do piso é ELEVADO, com aviso", () => {
    const r = interpretarRetencao("2", { chave: "K", padrao: 90, piso: 7 });
    expect(r.dias).toBe(7);
    expect(r.aviso).toContain("piso");
  });

  it("valor válido passa inteiro, sem aviso", () => {
    expect(interpretarRetencao("400", { chave: "K", padrao: 90, piso: 7 })).toEqual({
      dias: 400,
      aviso: null,
    });
  });
});

describe("podarHistorico — o laço de lotes", () => {
  it("para no primeiro lote incompleto (não gasta uma ida a mais)", async () => {
    const { db, chamadas } = bancoQueDevolve({
      fila: [TAMANHO_DO_LOTE, 7],
      auditoria: [0],
    });
    const r = await podarHistorico(db, {});
    expect(r.jobs_apagados).toBe(TAMANHO_DO_LOTE + 7);
    expect(r.lotes_fila).toBe(2);
    expect(r.fila_tem_resto).toBe(false);
    expect(r.lotes_auditoria).toBe(1);
    expect(chamadas.filter((c) => c.nome === "fn_podar_fila_de_jobs")).toHaveLength(2);
  });

  it("respeita o teto por invocação e DECLARA que sobrou trabalho", async () => {
    // Previsão feita ANTES: com todo lote cheio, são exatamente MAX_LOTES
    // chamadas e `fila_tem_resto` verdadeiro.
    const { db, chamadas } = bancoQueDevolve({
      fila: Array.from({ length: MAX_LOTES + 5 }, () => TAMANHO_DO_LOTE),
      auditoria: [0],
    });
    const r = await podarHistorico(db, {});
    expect(chamadas.filter((c) => c.nome === "fn_podar_fila_de_jobs")).toHaveLength(MAX_LOTES);
    expect(r.jobs_apagados).toBe(MAX_LOTES * TAMANHO_DO_LOTE);
    expect(r.fila_tem_resto).toBe(true);
  });

  it("pede ao banco os dias do padrão quando o .env está intocado", async () => {
    const { db, chamadas } = bancoQueDevolve({ fila: [0], auditoria: [0] });
    const r = await podarHistorico(db, {});
    expect(chamadas[0]).toEqual({
      nome: "fn_podar_fila_de_jobs",
      dias: RETENCAO_FILA_DIAS_PADRAO,
      limite: TAMANHO_DO_LOTE,
    });
    expect(chamadas[1]).toEqual({
      nome: "fn_expurgar_auditoria_vencida",
      dias: RETENCAO_AUDITORIA_DIAS_PADRAO,
      limite: TAMANHO_DO_LOTE,
    });
    expect(r.avisos).toEqual([]);
  });

  it("eleva ao piso o knob abaixo dele e devolve o aviso", async () => {
    const { db, chamadas } = bancoQueDevolve({ fila: [0], auditoria: [0] });
    const r = await podarHistorico(db, {
      JOB_QUEUE_RETENTION_DAYS: "1",
      AUDIT_LOG_RETENTION_DAYS: "0",
    });
    expect(chamadas[0]?.dias).toBe(RETENCAO_FILA_DIAS_PISO);
    // "0" é lixo (não-positivo), então cai no PADRÃO, não no piso — é a
    // diferença entre "escolheu pouco" e "escreveu bobagem".
    expect(chamadas[1]?.dias).toBe(RETENCAO_AUDITORIA_DIAS_PADRAO);
    expect(r.avisos).toHaveLength(2);
  });

  it("erro do banco não é engolido: vira `falhas`, com o nome da função", async () => {
    const db: PodaDb = {
      async rpc() {
        return { data: null, error: { message: "permission denied for table api_audit_log" } };
      },
    };
    const r = await podarHistorico(db, {});
    expect(r.falhas).toHaveLength(4);
    expect(r.falhas[1]).toMatch(/^fn_expurgar_auditoria_vencida: permission denied/);
  });

  it("uma poda que falha NÃO impede as seguintes (e a exceção também não)", async () => {
    // O defeito de produção: a quarta poda falhava toda noite e, como a falha
    // subia, tudo que vinha depois dela na rodada deixava de rodar. Aqui é a
    // PRIMEIRA que falha, das duas formas possíveis, para as outras três
    // provarem que rodam.
    for (const falha of ["erro", "excecao"] as const) {
      const chamadas: string[] = [];
      const db: PodaDb = {
        async rpc(nome) {
          chamadas.push(nome);
          if (nome !== "fn_podar_fila_de_jobs") return { data: 3, error: null };
          if (falha === "excecao") throw new Error("fetch failed");
          return { data: null, error: { message: "Could not find the function" } };
        },
      };
      const r = await podarHistorico(db, {});
      expect(chamadas, falha).toEqual([
        "fn_podar_fila_de_jobs",
        "fn_expurgar_auditoria_vencida",
        "fn_expurgar_espelho_da_agenda",
        "fn_expurgar_nonces_de_oauth",
      ]);
      expect(r.falhas, falha).toHaveLength(1);
      expect(r.falhas[0], falha).toContain("fn_podar_fila_de_jobs");
      expect(r).toMatchObject({ jobs_apagados: 0, auditoria_apagada: 3, espelho_apagado: 3, nonces_apagados: 3 });
    }
  });
});

describe("houveEfeito — as duas direções", () => {
  const base = {
    jobs_apagados: 0,
    auditoria_apagada: 0,
    lotes_fila: 1,
    lotes_auditoria: 1,
    fila_tem_resto: false,
    auditoria_tem_resto: false,
    espelho_apagado: 0,
    // Quarta poda (migration 0190): os nonces de OAuth do Google já queimados.
    nonces_apagados: 0,
    lotes_espelho: 0,
    espelho_tem_resto: false,
    retencao_fila_dias: RETENCAO_FILA_DIAS_PADRAO,
    retencao_auditoria_dias: RETENCAO_AUDITORIA_DIAS_PADRAO,
    retencao_espelho_dias: RETENCAO_ESPELHO_AGENDA_DIAS_PADRAO,
    avisos: [] as string[],
    falhas: [] as string[],
  };

  it("rodada que não apagou nada NÃO ocupa linha de auditoria", () => {
    expect(houveEfeito(base)).toBe(false);
  });

  it("apagou nonce → audita, pela mesma razão das outras três", () => {
    // Sem esta linha em `houveEfeito`, uma rodada que só podou nonces apagaria
    // linhas e não deixaria registro. O caso entrou porque quem acrescentou a
    // quarta poda (eu) a ligou ao laço e ao retorno e esqueceu do predicado —
    // um parágrafo abaixo do comentário que descreve exatamente esse defeito.
    expect(houveEfeito({ ...base, nonces_apagados: 1 })).toBe(true);
  });

  it("apagou job → audita; apagou auditoria → audita", () => {
    // A segunda é a que não pode se perder: é ela que faz o expurgo do audit
    // deixar rastro em vez de encolher a trilha em silêncio.
    expect(houveEfeito({ ...base, jobs_apagados: 1 })).toBe(true);
    expect(houveEfeito({ ...base, auditoria_apagada: 1 })).toBe(true);
  });

  it("...e apagou espelho da agenda → TAMBÉM audita (migration 0187)", () => {
    // Sem este caso, uma rodada que só podou o espelho apagaria linhas e não
    // deixaria registro. A doutrina do repo é auditar QUANDO HÁ EFEITO — nunca
    // parar de auditar —, e um efeito novo que não entra em `houveEfeito` é
    // exatamente o silêncio que ela proíbe.
    expect(houveEfeito({ ...base, espelho_apagado: 1 })).toBe(true);
  });
});

describe("os pisos do TypeScript e os do SQL são os mesmos números", () => {
  it("os quatro valores da política aparecem literalmente no baseline.sql", async () => {
    // Duas cópias de um piso é como um piso vira decorativo: o `.env.example`
    // documenta um número, a função do banco aplica outro, e ninguém percebe
    // porque os dois lados continuam "funcionando".
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sql = readFileSync(join(__dirname, "..", "..", "supabase", "baseline.sql"), "utf8");
    const bloco = sql.slice(sql.indexOf("-- ---- poda da fila e expurgo do audit (migration 0167)"));
    expect(bloco.length).toBeGreaterThan(500);
    expect(bloco).toContain(`greatest(coalesce(p_retencao_dias, ${RETENCAO_FILA_DIAS_PADRAO}), ${RETENCAO_FILA_DIAS_PISO})`);
    expect(bloco).toContain(
      `greatest(coalesce(p_retencao_dias, ${RETENCAO_AUDITORIA_DIAS_PADRAO}), ${RETENCAO_AUDITORIA_DIAS_PISO})`,
    );
  });

  it("...e o do espelho da agenda também (migration 0187)", async () => {
    // A lista deste describe era FIXA em dois pares, e o terceiro nasceria fora
    // dela sem ninguém ser avisado — o mesmo eixo de completude que já mordeu
    // nesta entrega. Um piso que só existe no TypeScript é decorativo.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sql = readFileSync(join(__dirname, "..", "..", "supabase", "baseline.sql"), "utf8");
    // O rótulo aponta para o bloco da FUNÇÃO, não para o do `comment on table`.
    // A 0187 está PARTIDA em dois no baseline — a função antes da varredura anon,
    // o resto no fim —, e o `greatest` mora só na primeira metade. Apontar para o
    // rótulo errado dava vermelho num conserto que estava certo.
    const bloco = sql.slice(sql.indexOf("-- ---- o espelho do Google é cache com prazo: função (migration 0187)"));
    expect(bloco.length).toBeGreaterThan(500);
    expect(bloco).toContain(
      `greatest(coalesce(p_retencao_dias, ${RETENCAO_ESPELHO_AGENDA_DIAS_PADRAO}), ${RETENCAO_ESPELHO_AGENDA_DIAS_PISO})`,
    );
  });
});

function requisicaoAutorizada(): Parameters<typeof GET>[0] {
  // O handler só lê `headers.get("authorization")`.
  return { headers: new Headers({ authorization: "Bearer segredo" }) } as never;
}

beforeEach(() => {
  auditou.mockClear();
  limparPayloads.mockReset();
  limparPayloads.mockResolvedValue(0);
  contatosAnonimizados = [];
  respostaRpc = { data: 0, error: null };
  respostaPorFuncao = {};
  chamadasRpc.length = 0;
  tabelasLidas.length = 0;
});

describe("o handler HTTP — a falha entra na trilha, o vazio não", () => {

  it("rodada que não apagou nada responde 200 e NÃO audita", async () => {
    respostaRpc = { data: 0, error: null };
    const resposta = await GET(requisicaoAutorizada());
    expect(resposta.status).toBe(200);
    expect(auditou).not.toHaveBeenCalled();
  });

  it("rodada que apagou AUDITA — o expurgo do audit deixa rastro", async () => {
    // Esta é a direção que não pode se perder: sem ela, o expurgo encolheria a
    // trilha em silêncio, que é exatamente o que a doutrina de append-only
    // existe para impedir.
    respostaRpc = { data: 7, error: null };
    await GET(requisicaoAutorizada());
    expect(auditou).toHaveBeenCalledTimes(1);
    expect(auditou.mock.calls[0]?.[0]).toMatchObject({
      action: "retention.sweep_run",
      metadata: { jobs_apagados: 7 },
    });
  });

  it("rodada que FALHOU responde 500 e AUDITA a falha", async () => {
    // O laço de retorno: uma poda que parou de funcionar num clone (grants que
    // não vieram no `update.sh`) não pode ficar idêntica, na trilha, a uma poda
    // sem nada a fazer. Sem esta linha o único sinal viveria num `logger.error`
    // dentro do contêiner, atrás de um `curl` que manda tudo para /dev/null.
    respostaRpc = { data: null, error: { message: "permission denied for table api_audit_log" } };
    const resposta = await GET(requisicaoAutorizada());
    expect(resposta.status).toBe(500);
    expect(auditou).toHaveBeenCalledTimes(1);
    expect(auditou.mock.calls[0]?.[0]).toMatchObject({
      action: "retention.sweep_run",
      metadata: { falhou: true },
    });
  });
});

describe("houveEfeito — payloads da sincronização Meta limpos", () => {
  it("rodada que só limpou payloads (coexistência) audita", () => {
    const vazio = {
      jobs_apagados: 0, auditoria_apagada: 0, lotes_fila: 0, lotes_auditoria: 0, fila_tem_resto: false, auditoria_tem_resto: false,
      nonces_apagados: 0, espelho_apagado: 0, lotes_espelho: 0, espelho_tem_resto: false,
      retencao_fila_dias: 0, retencao_auditoria_dias: 0, retencao_espelho_dias: 0, avisos: [], falhas: [],
    };
    expect(houveEfeito(vazio)).toBe(false);
    expect(houveEfeito({ ...vazio, payloads_limpos: 3 })).toBe(true);
  });
});

/**
 * O PostgREST acha a função pelo NOME dos argumentos, nunca pela posição. O nome
 * é texto dos dois lados — um objeto literal aqui, um `.sql` lá — e por isso
 * `typecheck`, `lint` e `build` passam com um par que o banco não conhece.
 *
 * Foi assim que a quarta poda ficou quebrada em produção: o laço mandava
 * `{ p_retencao_dias, p_limite }` às quatro funções e
 * `fn_expurgar_nonces_de_oauth` declara `(p_dias, p_lote)`. Toda noite a trilha
 * recebia `retention.sweep_run` com `falhou: true` e "Could not find the function
 * public.fn_expurgar_nonces_de_oauth(p_limite, p_retencao_dias)".
 *
 * `rpc-do-codigo-nasce-no-schema.test.ts` não pegava por dois motivos, os dois
 * escritos no cabeçalho dele: confere só o NOME da função, e este é um dos
 * sítios em que o nome chega por variável. Aqui a régua é a rodada de verdade:
 * o que o handler manda × o que o `baseline.sql` declara.
 */
const BASELINE = readFileSync(join(__dirname, "..", "..", "supabase", "baseline.sql"), "utf8");

/**
 * Os parâmetros da ÚLTIMA declaração da função no baseline — é a que fica em
 * vigor depois do `update.sh`. ponytail: `[^)]*` não atravessa `default` com
 * parêntese (`default now()`); nenhuma destas funções tem, e a que tiver
 * reprova no controle de "não achei a declaração", não em silêncio.
 */
function parametrosNoBaseline(fn: string): { nome: string; opcional: boolean }[] {
  const re = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+"?public"?\\."?${fn}"?\\s*\\(([^)]*)\\)`, "gi");
  const ultima = [...BASELINE.matchAll(re)].pop();
  if (!ultima) throw new Error(`${fn} não é declarada em supabase/baseline.sql`);
  return (ultima[1] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => ({ nome: (p.split(/\s+/)[0] ?? "").replace(/"/g, ""), opcional: /\bdefault\b/i.test(p) }));
}

describe("cada rpc() da rodada fala os nomes de parâmetro que o schema declara", () => {
  it("o leitor do baseline enxerga a assinatura (controle)", () => {
    expect(parametrosNoBaseline("fn_expurgar_nonces_de_oauth")).toEqual([
      { nome: "p_dias", opcional: false },
      { nome: "p_lote", opcional: true },
    ]);
    expect(parametrosNoBaseline("fn_verificar_cadeia_auditoria")).toEqual([]);
  });

  it("nenhum argumento enviado é desconhecido da função, e nenhum obrigatório falta", async () => {
    await GET(requisicaoAutorizada());

    const enviadosPorFuncao = new Map(chamadasRpc.map((c) => [c.nome, Object.keys(c.args)]));
    // Controle: a régua viu a rodada inteira. Uma poda nova que entre no laço
    // aparece aqui e passa a ser medida sem ninguém lembrar de listá-la.
    expect([...enviadosPorFuncao.keys()].sort()).toEqual([
      "fn_expurgar_auditoria_vencida",
      "fn_expurgar_espelho_da_agenda",
      "fn_expurgar_nonces_de_oauth",
      "fn_podar_fila_de_jobs",
      "fn_verificar_cadeia_auditoria",
    ]);

    for (const [fn, enviados] of enviadosPorFuncao) {
      const declarados = parametrosNoBaseline(fn);
      const nomes = declarados.map((p) => p.nome);
      for (const enviado of enviados) {
        expect(nomes, `${fn} não declara \`${enviado}\` — o PostgREST responde PGRST202 e a poda não roda`).toContain(enviado);
      }
      for (const obrigatorio of declarados.filter((p) => !p.opcional)) {
        expect(enviados, `${fn} exige \`${obrigatorio.nome}\` e a rodada não manda`).toContain(obrigatorio.nome);
      }
    }
  });
});

describe("o handler HTTP — uma etapa que falha não leva as outras junto", () => {
  const CADEIA = { linhas: 3, total_problemas: 0, problemas: [], cabeca_seq: 3, cabeca_hash: "abc" };
  const NAO_ACHOU = {
    data: null,
    error: { message: "Could not find the function public.fn_expurgar_nonces_de_oauth(p_limite, p_retencao_dias)" },
  };

  it("poda que falha: as outras podas, a limpeza, a retomada da LGPD e a conferência da cadeia rodam", async () => {
    const erroNoLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    // A PRIMEIRA poda falha: tudo que vem depois dela tem de rodar mesmo assim.
    respostaPorFuncao = { fn_podar_fila_de_jobs: NAO_ACHOU, fn_verificar_cadeia_auditoria: { data: CADEIA, error: null } };

    const resposta = await GET(requisicaoAutorizada());

    expect(chamadasRpc.map((c) => c.nome)).toEqual([
      "fn_podar_fila_de_jobs",
      "fn_expurgar_auditoria_vencida",
      "fn_expurgar_espelho_da_agenda",
      "fn_expurgar_nonces_de_oauth",
      "fn_verificar_cadeia_auditoria",
    ]);
    expect(limparPayloads).toHaveBeenCalledTimes(1);
    expect(tabelasLidas).toContain("contacts");

    // A falha é DITA: log, a linha `falhou` de sempre na trilha, e 500.
    expect(resposta.status).toBe(500);
    expect(erroNoLog).toHaveBeenCalledWith(
      "[data-retention] etapa da faxina falhou",
      expect.objectContaining({ falha: expect.stringContaining("fn_podar_fila_de_jobs") }),
    );
    expect(auditou).toHaveBeenCalledTimes(1);
    expect(auditou.mock.calls[0]?.[0]).toMatchObject({
      action: "retention.sweep_run",
      metadata: { falhou: true, erro: expect.stringContaining("fn_podar_fila_de_jobs") },
    });
    erroNoLog.mockRestore();
  });

  it("falhou uma e outra apagou: a mesma linha da trilha diz as duas coisas", async () => {
    const erroNoLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    respostaPorFuncao = { fn_podar_fila_de_jobs: { data: 7, error: null }, fn_expurgar_nonces_de_oauth: NAO_ACHOU };

    await GET(requisicaoAutorizada());

    expect(auditou).toHaveBeenCalledTimes(1);
    expect(auditou.mock.calls[0]?.[0]).toMatchObject({
      action: "retention.sweep_run",
      metadata: { falhou: true, jobs_apagados: 7, erro: expect.stringContaining("fn_expurgar_nonces_de_oauth") },
    });
    erroNoLog.mockRestore();
  });

  it("limpeza da sincronização que explode: a retomada da LGPD e a cadeia rodam, e a falha é dita", async () => {
    const erroNoLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    limparPayloads.mockRejectedValue(new Error("limpar meta.history_chunk: timeout"));

    const resposta = await GET(requisicaoAutorizada());

    expect(tabelasLidas).toContain("contacts");
    expect(chamadasRpc.map((c) => c.nome)).toContain("fn_verificar_cadeia_auditoria");
    expect(resposta.status).toBe(500);
    expect(auditou.mock.calls[0]?.[0]).toMatchObject({
      action: "retention.sweep_run",
      metadata: { falhou: true, erro: expect.stringContaining("meta.history_chunk") },
    });
    erroNoLog.mockRestore();
  });

  it("rodada sem efeito e sem falha continua muda na trilha", async () => {
    respostaPorFuncao = { fn_verificar_cadeia_auditoria: { data: CADEIA, error: null } };
    const resposta = await GET(requisicaoAutorizada());
    expect(resposta.status).toBe(200);
    expect(auditou).not.toHaveBeenCalled();
  });
});
