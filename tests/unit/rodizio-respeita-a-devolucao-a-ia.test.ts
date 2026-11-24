/**
 * A CONVERSA DEVOLVIDA À IA NÃO VOLTA PARA O RODÍZIO SÓ PORQUE PEDIRAM.
 *
 * Porte do upstream melgarafael/DeskcommCRM#5176 (contribuição de @fcostamil-hub).
 * Neste fork o pedido nasce da própria devolução (soltar o dono dispara
 * `trg_routing_assignment_changed`), e o rodízio entregava a conversa a um
 * atendente no tick seguinte, com a IA atendendo.
 *
 * Prova, sem banco:
 *   1. a regra pura (`esperaPelaRetomada`) nos dois sentidos;
 *   2. a leitura da marca não confia no jsonb;
 *   3. "IA calada" lê o `'infinity'` do Postgres como calada (o gate também);
 *   4. a FIAÇÃO no worker: só no rodízio, nunca com dono nem com caso que barra,
 *      e o pedido é REAGENDADO sem gastar tentativa.
 * O efeito no worker de verdade (o pedido guardado, ninguém atribuído) está em
 * `tests/unit/cron-rodizio-devolucao.test.ts`, que tem o dublê do banco do worker.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { qualificacaoEmCurso, silenciadoAgora } from "@/lib/routing/qualificacao-da-ia";
import {
  CHAVE_DA_RETOMADA_DA_IA,
  INTERVALO_DA_RETOMADA_MS,
  esperaPelaRetomada,
  lerMarcaDeRetomada,
  marcaDeRetomada,
} from "@/lib/routing/retomada-da-ia";

const AGORA = new Date("2026-11-20T20:31:30Z");
const comMarca = {
  [CHAVE_DA_RETOMADA_DA_IA]: marcaDeRetomada("pessoa", new Date("2026-11-20T20:30:19Z")),
};

describe("esperaPelaRetomada — a regra pura", () => {
  it("⭐ marca + sem passagem nova + IA no ar ⇒ guarda o pedido e o reavalia no intervalo", () => {
    const ate = esperaPelaRetomada({ metadata: comMarca, lastHandoffAt: null, iaAtendendo: true, agora: AGORA });
    expect(ate).toBe(new Date(AGORA.getTime() + INTERVALO_DA_RETOMADA_MS).toISOString());
  });

  it("sem a marca (conversa nunca devolvida): distribui como sempre — o rodízio não muda", () => {
    expect(esperaPelaRetomada({ metadata: {}, lastHandoffAt: null, iaAtendendo: true, agora: AGORA })).toBeNull();
    expect(esperaPelaRetomada({ metadata: null, lastHandoffAt: null, iaAtendendo: true, agora: AGORA })).toBeNull();
  });

  it("⭐ a IA passou para humano de novo (`last_handoff_at`): necessidade real — distribui", () => {
    expect(
      esperaPelaRetomada({ metadata: comMarca, lastHandoffAt: "2026-11-20T20:40:00Z", iaAtendendo: true, agora: AGORA }),
    ).toBeNull();
  });

  it("sem IA no ar (pausada, calada, número sem agente): distribui — falha aberta", () => {
    expect(esperaPelaRetomada({ metadata: comMarca, lastHandoffAt: null, iaAtendendo: false, agora: AGORA })).toBeNull();
  });

  it("a marca vale por pessoa OU automática (o cron do prazo também devolve à IA)", () => {
    const auto = { [CHAVE_DA_RETOMADA_DA_IA]: marcaDeRetomada("automatica", AGORA) };
    expect(esperaPelaRetomada({ metadata: auto, lastHandoffAt: null, iaAtendendo: true, agora: AGORA })).not.toBeNull();
  });
});

describe("lerMarcaDeRetomada — não confia no jsonb", () => {
  it.each([
    ["sem metadata", null],
    ["metadata texto", "x"],
    ["sem a chave", { outra: 1 }],
    ["chave texto", { ia_retomada: "sim" }],
    ["sem data", { ia_retomada: { por: "pessoa" } }],
    ["data lixo", { ia_retomada: { em: "ontem", por: "pessoa" } }],
    ["autor desconhecido", { ia_retomada: { em: "2026-11-20T20:30:19Z", por: "robo" } }],
  ])("%s ⇒ sem marca", (_caso, metadata) => {
    expect(lerMarcaDeRetomada(metadata)).toBeNull();
  });

  it("a marca bem formada é lida como foi gravada", () => {
    expect(lerMarcaDeRetomada(comMarca)).toEqual({ em: "2026-11-20T20:30:19.000Z", por: "pessoa" });
  });
});

describe("IA no ar — a mesma régua de 'calada' do gate", () => {
  it("`'infinity'` (o texto que o PostgREST devolve) é calada para sempre; no passado, não", () => {
    expect(silenciadoAgora("infinity", AGORA)).toBe(true);
    expect(silenciadoAgora("2026-11-20T20:40:00Z", AGORA)).toBe(true);
    expect(silenciadoAgora("2026-11-20T20:00:00Z", AGORA)).toBe(false);
    expect(silenciadoAgora(null, AGORA)).toBe(false);
  });

  it("só há IA atendendo com agente no ar, sem passagem, sem silêncio e sem humano", () => {
    const base = { iaAtendeOCanal: true, passouParaHumano: false, agenteCalado: false, comHumano: false };
    expect(qualificacaoEmCurso(base)).toBe(true);
    expect(qualificacaoEmCurso({ ...base, iaAtendeOCanal: false })).toBe(false);
    expect(qualificacaoEmCurso({ ...base, passouParaHumano: true })).toBe(false);
    expect(qualificacaoEmCurso({ ...base, agenteCalado: true })).toBe(false);
    expect(qualificacaoEmCurso({ ...base, comHumano: true })).toBe(false);
  });
});

describe("a fiação no routing-worker", () => {
  const src = readFileSync(join(process.cwd(), "lib/routing/worker.ts"), "utf8");
  const inicio = src.indexOf("lerMarcaDeRetomada((conv as { metadata?: unknown }).metadata)");
  const bloco = src.slice(src.lastIndexOf("if (", inicio), src.indexOf("let eligibles", inicio));

  it("⭐ só no rodízio, nunca para conversa com dono nem com caso que barra a fila", () => {
    expect(inicio).toBeGreaterThan(0);
    expect(bloco).toContain('config.mode === "round_robin"');
    expect(bloco).toContain("!alreadyAssigned");
    expect(bloco).toContain("!motivoDoCaso");
  });

  it('a pergunta "há IA no ar?" é `lerQualificacaoDaIA`, a régua do motor, não uma nova', () => {
    expect(bloco).toContain("await lerQualificacaoDaIA(");
    expect(bloco).toContain("esperaPelaRetomada(");
  });

  it("⭐ o pedido é REAGENDADO com motivo próprio e sem gastar tentativa — descartar deixaria a passagem sem ninguém", () => {
    expect(bloco).toContain('requeueEvent(event, now, event.attempts, { reason: "ia_retomada" }, ate)');
    expect(bloco).not.toContain("markDone(");
  });
});
