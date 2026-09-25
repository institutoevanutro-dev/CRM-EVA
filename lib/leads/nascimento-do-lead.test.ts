/**
 * `tituloDoContatoNovo` — o fallback de título do card quando o contato não
 * tem nome nem no cadastro nem no payload da mensagem. Extraída como função
 * pura de `garantirLeadDaConversa` (que precisa de um `SupabaseClient` real —
 * contato, pipeline, stage, RPC, atividade) só para este `if` poder ser
 * testado sem levantar um fake de banco inteiro.
 *
 * Cobertura DB-backed do restante da função (contato bloqueado, funil de
 * entrada, idempotência) vive em `tests/invariants/nascimento-do-lead.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { SEM_NOME } from "@/lib/contacts/rotulo-do-contato";

import { tituloDoContatoNovo } from "./nascimento-do-lead";

describe("tituloDoContatoNovo", () => {
  it("sem nome no cadastro nem no payload, canal instagram → \"Novo contato pelo Instagram\"", () => {
    expect(tituloDoContatoNovo(SEM_NOME, "", "instagram")).toBe("Novo contato pelo Instagram");
  });

  it("sem nome no cadastro nem no payload, canal whatsapp → \"Novo contato pelo WhatsApp\"", () => {
    expect(tituloDoContatoNovo(SEM_NOME, "", "whatsapp")).toBe("Novo contato pelo WhatsApp");
  });

  it("canal ausente/desconhecido cai no fallback de WhatsApp (o texto de sempre)", () => {
    expect(tituloDoContatoNovo(SEM_NOME, "", "")).toBe("Novo contato pelo WhatsApp");
    expect(tituloDoContatoNovo(SEM_NOME, "", "sms")).toBe("Novo contato pelo WhatsApp");
  });

  it("nome do CADASTRO vence, em qualquer canal — o canal só decide o fallback", () => {
    expect(tituloDoContatoNovo("Maria", "", "instagram")).toBe("Maria");
    expect(tituloDoContatoNovo("Maria", "", "whatsapp")).toBe("Maria");
  });

  it("sem nome no cadastro, nome do PAYLOAD entra (e não é identificador técnico)", () => {
    expect(tituloDoContatoNovo(SEM_NOME, "João da Padaria", "instagram")).toBe("João da Padaria");
  });

  it("nome do payload identificador técnico (ex.: sufixo do WhatsApp) é descartado — cai no canal", () => {
    expect(tituloDoContatoNovo(SEM_NOME, "5511999999999@s.whatsapp.net", "instagram")).toBe(
      "Novo contato pelo Instagram",
    );
  });
});
