// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mensagemDaRecusaDePublicacao } from "@/lib/agenda/google/sync-executor";

/**
 * ERRO PERMANENTE DO BANCO NÃO É "O COMPROMISSO MUDOU" (upstream #4453, issue #4448).
 *
 * O executor gravava "O compromisso mudou. A sincronização vai reler a versão
 * atual." para QUALQUER erro de banco que trouxesse `code`. A frase convida a
 * tentar de novo — verdade para o `PT409` (`google_stale`) e mentira para o
 * `42501` (`google_connection_unavailable`): nada mudou, a agenda de destino
 * está indisponível e repetir não muda o resultado.
 */

/** O erro como o `googleRpc` entrega: `Error` com `code` do SQLSTATE. */
function erroDoBanco(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

describe("erro de banco no executor: permanente tem frase própria", () => {
  it("42501 (google_connection_unavailable) não é lido como versão desatualizada", () => {
    const mensagem = mensagemDaRecusaDePublicacao(
      erroDoBanco("42501", "google_connection_unavailable"),
      "PATCH",
    );
    expect(mensagem).not.toContain("O compromisso mudou");
    expect(mensagem).not.toContain("reler a versão atual");
    expect(mensagem).toContain("agenda de destino");
    // A ação `error` grava `left(message, 200)`.
    expect(mensagem.length).toBeLessThanOrEqual(200);
  });

  it("o PT409 continua dizendo que o compromisso mudou", () => {
    expect(mensagemDaRecusaDePublicacao(erroDoBanco("PT409", "google_stale"), "PATCH")).toBe(
      "O compromisso mudou. A sincronização vai reler a versão atual.",
    );
  });

  it("guarda que não é de versão também não vira 'mudou'", () => {
    for (const [code, texto] of [
      ["42501", "google_owner_unavailable"],
      ["42501", "google_contact_redacted"],
      ["P0002", "appointment_not_found"],
      ["22023", "google_action_invalid"],
    ] as const) {
      const mensagem = mensagemDaRecusaDePublicacao(erroDoBanco(code, texto), "PATCH");
      expect(mensagem, `${code}/${texto}`).not.toContain("O compromisso mudou");
    }
  });

  it("erro sem `code`, ou com `code` vazio/indefinido (falha de rede), mantém a frase de conexão", () => {
    const conexao = "Não foi possível sincronizar. Confira a conexão e tente novamente.";
    expect(mensagemDaRecusaDePublicacao(new Error("falhou"), "PATCH")).toBe(conexao);
    for (const code of ["", undefined]) {
      const erro = Object.assign(new Error("TypeError: fetch failed"), { code });
      expect(mensagemDaRecusaDePublicacao(erro, "PATCH"), String(code)).toBe(conexao);
    }
  });
});
