/**
 * O ECO DO CELULAR NÃO ACORDA NADA — prova pelo banco e pelo registry.
 *
 * `ingestMetaEcho` não chama `aplicarEfeitosPosEntrada` (teste em
 * `ingest-echo.test.ts`), mas a linha que ele grava em `messages` dispara os
 * triggers `AFTER/BEFORE INSERT` da tabela. Este arquivo mede que nenhum deles
 * transforma uma linha `direction='outbound'` em gatilho de IA, automação,
 * follow-up, push ou demanda:
 *
 *   1. `fn_emit_message_event` só emite `message.received` no ramo inbound; o
 *      outbound vira `message.sending|sent|failed|outbound`;
 *   2. nenhum handler do dreno consome um desses tipos de saída;
 *   3. os demais triggers de insert em `messages` saem cedo quando não é inbound.
 *
 * Se alguém registrar um consumidor de `message.sent`, o caso 2 reprova e obriga
 * a decidir se o eco do celular deve mesmo acordá-lo.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getRegisteredHandlers } from "@/lib/event-log/dispatcher";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

/** Corpo da ÚLTIMA definição da função no baseline (o apêndice vence o dump). */
function corpo(nome: string): string {
  const re = new RegExp(`create or replace function "?public"?\\."?${nome}"?\\([^)]*\\)[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`, "gi");
  const achados = [...BASELINE.matchAll(re)];
  expect(achados.length, `${nome} não encontrada no baseline`).toBeGreaterThan(0);
  return achados.at(-1)![1]!;
}

const TIPOS_DE_SAIDA = ["message.sending", "message.sent", "message.failed", "message.outbound"];

describe("eco do celular (outbound) não dispara consumidor de entrada", () => {
  it("fn_emit_message_event: message.received só no ramo inbound, e o ramo outbound só emite tipos de saída", () => {
    const c = corpo("fn_emit_message_event");
    // Corta no PRIMEIRO `else` (o do `if direction`); o `case` tem o seu.
    const corte = c.search(/\belse\b/);
    const ramoInbound = c.slice(0, corte);
    const ramoOutbound = c.slice(corte);
    expect(ramoInbound).toMatch(/new\.direction\s*=\s*'inbound'/);
    expect(ramoInbound).toContain("'message.received'");
    expect(ramoOutbound).not.toContain("message.received");
    for (const t of TIPOS_DE_SAIDA) expect(ramoOutbound).toContain(`'${t}'`);
  });

  it("nenhum handler do dreno consome evento de mensagem de SAÍDA", () => {
    ensureHandlersRegistered();
    const consumidores = getRegisteredHandlers()
      .filter((h) => h.events.some((e) => TIPOS_DE_SAIDA.includes(e)))
      .map((h) => h.key);
    expect(consumidores).toEqual([]);
  });

  it("os outros triggers de insert em messages só agem em inbound", () => {
    for (const fn of ["fn_reply_inbound_revision", "fn_message_service_lock"]) {
      expect(corpo(fn), fn).toMatch(/new\.direction\s*=\s*'inbound'/);
    }
    // A demanda: o trigger delega a `fn_service_inbound`, que é quem sai cedo.
    expect(corpo("fn_demanda_abre_no_inbound")).toContain("fn_service_inbound(new.id)");
    expect(corpo("fn_service_inbound")).toMatch(/m\.direction\s*<>\s*'inbound'[^;]*then return/);
  });
});
