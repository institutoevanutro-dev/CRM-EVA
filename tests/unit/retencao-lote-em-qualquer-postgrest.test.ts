/**
 * O LOTE DA PODA NÃO PODE DEPENDER DA VERSÃO DO POSTGREST (revisão do PR 125).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * As duas podas desta rota apagavam com `DELETE … order=id&limit=<lote>`. Isso
 * é um recurso do PostgREST 12 ("limited deletes") que o 13.0.0 REMOVEU. Medido
 * num Postgres 16 + PostgREST v16.3 descartáveis, 7 linhas vencidas e 3 novas:
 *
 *   DELETE /t?received_at=lt.<corte>&select=id&order=id.asc&limit=2
 *     → HTTP 200, as SETE apagadas e as sete devolvidas
 *
 * Ou seja: do 13 em diante o `limit` não limita nada. A primeira rodada de um
 * banco com acumulado grande apaga tudo num DELETE só — a trava longa na tabela
 * em que todo webhook escreve, que o lote existe para impedir — e `temMais`
 * sai `true` com a fila vazia. E no 12 o mesmo DELETE sem `order` é recusado
 * (PGRST109). Uma forma só não serve às duas versões.
 *
 * ─── A régua ────────────────────────────────────────────────────────────────
 *
 * O banco falso abaixo guarda linhas de verdade e imita as DUAS semânticas do
 * DELETE com `limit`. Os casos valem para as duas: cada rodada apaga no máximo
 * `lote` linhas, as novas nunca, e a drenagem termina. Medido antes do
 * conserto: na semântica do 13 a primeira rodada apagava as 7 de uma vez.
 */
import { describe, expect, it, vi } from "vitest";

import { podarArquivoDeWebhooks } from "@/lib/channels/retencao-do-arquivo";
import { podarHistoricoDeCaptacao } from "@/lib/webhooks/retencao-da-captacao";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

type Linha = { id: string; received_at: string; archived_at: string | null };
type Versao = "12 (limited deletes)" | "13+ (limit ignorado no DELETE)";

function bancoFalso(versao: Versao, linhas: Linha[]) {
  /** Quantas linhas o MAIOR DELETE desta vida do banco apagou de uma vez. */
  const medido = { maiorDelete: 0 };
  const from = () => {
    let operacao: "select" | "delete" | "update" = "select";
    let patch: Partial<Linha> = {};
    const filtros: Array<(l: Linha) => boolean> = [];
    let ordem: keyof Linha | null = null;
    let limite: number | null = null;
    let pulo = 0;
    const executar = () => {
      let alvo = linhas.filter((l) => filtros.every((f) => f(l)));
      const ordenar = () => {
        if (ordem) alvo = [...alvo].sort((a, b) => String(a[ordem!]).localeCompare(String(b[ordem!])));
      };
      if (operacao === "select") {
        ordenar();
        return { data: alvo.slice(pulo, limite === null ? undefined : pulo + limite), error: null };
      }
      if (operacao === "update") {
        for (const l of alvo) Object.assign(l, patch);
        return { data: null, error: null };
      }
      if (limite !== null && versao.startsWith("12")) {
        if (!ordem) {
          return { data: null, error: { message: "PGRST109: limit sem order explícito" } };
        }
        ordenar();
        alvo = alvo.slice(0, limite);
      }
      // No 13+ o `limit` de um DELETE é simplesmente ignorado: `alvo` fica inteiro.
      medido.maiorDelete = Math.max(medido.maiorDelete, alvo.length);
      for (const l of alvo) linhas.splice(linhas.indexOf(l), 1);
      return { data: alvo.map((l) => ({ id: l.id })), error: null };
    };
    const q = {
      select: () => q,
      delete: () => ((operacao = "delete"), q),
      update: (p: Partial<Linha>) => ((operacao = "update"), (patch = p), q),
      lt: (c: keyof Linha, v: string) => (filtros.push((l) => String(l[c]) < v), q),
      lte: (c: keyof Linha, v: string) => (filtros.push((l) => String(l[c]) <= v), q),
      is: (c: keyof Linha, v: null) => (filtros.push((l) => l[c] === v), q),
      in: (c: keyof Linha, vs: string[]) => (filtros.push((l) => vs.includes(String(l[c]))), q),
      order: (c: keyof Linha) => ((ordem = c), q),
      limit: (n: number) => ((limite = n), q),
      range: (de: number, ate: number) => ((pulo = de), (limite = ate - de + 1), q),
      then: (ok: (v: unknown) => unknown, falhou?: (e: unknown) => unknown) =>
        Promise.resolve().then(executar).then(ok, falhou),
    };
    return q;
  };
  return { admin: { from } as never, linhas, medido };
}

const DIA = 86_400_000;
/** 7 linhas vencidas há 500 dias (já sem corpo) e 3 de hoje. */
function sementes(): Linha[] {
  const velha = new Date(Date.now() - 500 * DIA).toISOString();
  const nova = new Date().toISOString();
  return [
    ...Array.from({ length: 7 }, (_, i) => ({ id: `velha-${i}`, received_at: velha, archived_at: velha })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: `nova-${i}`, received_at: nova, archived_at: null })),
  ];
}

const VERSOES: Versao[] = ["12 (limited deletes)", "13+ (limit ignorado no DELETE)"];

describe.each(VERSOES)("PostgREST %s", (versao) => {
  it("captação: cada rodada apaga no máximo o lote, e a drenagem termina", async () => {
    const { admin, linhas, medido } = bancoFalso(versao, sementes());
    const rodadas: Array<{ apagadas: number; temMais: boolean }> = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await podarHistoricoDeCaptacao(admin, { diasBrutos: "365", lote: 2 });
      rodadas.push({ apagadas: r.apagadas, temMais: r.temMais });
    }
    expect(medido.maiorDelete).toBeLessThanOrEqual(2);
    expect(rodadas.map((r) => r.apagadas)).toEqual([2, 2, 2, 1, 0]);
    // `temMais` é o que diz ao operador que ainda há fila: fila vazia, `false`.
    expect(rodadas.map((r) => r.temMais)).toEqual([true, true, true, false, false]);
    expect(linhas.map((l) => l.id).sort()).toEqual(["nova-0", "nova-1", "nova-2"]);
  });

  it("arquivo de webhooks: o DELETE das linhas velhas também respeita o lote", async () => {
    const { admin, linhas, medido } = bancoFalso(versao, sementes());
    const apagadas: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90, lote: 2 });
      apagadas.push(r.apagadas);
    }
    expect(medido.maiorDelete).toBeLessThanOrEqual(2);
    expect(apagadas).toEqual([2, 2, 2, 1, 0]);
    expect(linhas.map((l) => l.id).sort()).toEqual(["nova-0", "nova-1", "nova-2"]);
  });
});
