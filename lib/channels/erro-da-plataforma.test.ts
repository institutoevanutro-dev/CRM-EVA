/**
 * A recusa da plataforma oficial chega em vários formatos, e todos têm de dar o
 * MESMO código: é por ele que a tela da conversa escolhe a frase.
 *
 * Portado do projeto original (DeskcommCRM, PR #3336 e anteriores). Os casos de
 * campanha (`falhaDoEnvioInteiro`, `fraseDaFalha`) não se aplicam ao fork.
 */
import { describe, expect, it } from "vitest";

import { motivoDaFalhaDaMensagem } from "@/lib/inbox/motivo-da-falha";
import { codigoDaPlataforma, recusaDoEnvioDeModelo } from "./erro-da-plataforma";

describe("codigoDaPlataforma", () => {
  it("oficial direto: o número vem em error_code", () => {
    expect(codigoDaPlataforma("131050", "Unable to deliver")).toBe("131050");
  });

  it("parceiro, pelo webhook: o rótulo do adapter em error_code e o número no começo do texto", () => {
    expect(codigoDaPlataforma("zernio_error", "131049 — Healthy ecosystem — …")).toBe("131049");
  });

  it("recusa síncrona: o marcador ganha do status HTTP que abre o texto", () => {
    expect(
      codigoDaPlataforma("zernio_error", "zernio_template_failed: 400 platform_api_error: x [plataforma:132015]"),
    ).toBe("132015");
    // Sem marcador, o 400 do envelope NÃO é lido como código.
    expect(codigoDaPlataforma("zernio_error", "zernio_template_failed: 400 INVALID_TEMPLATE_PARAMS: faltam")).toBe(
      "INVALID_TEMPLATE_PARAMS",
    );
  });

  it("recusa síncrona do envio de modelo: o código depois do prefixo do canal", () => {
    expect(codigoDaPlataforma("meta_error", "meta_132000: (#132000) Number of parameters does not match")).toBe("132000");
    // Código de um dígito também é da plataforma (4 = limite de chamadas do app).
    expect(codigoDaPlataforma("meta_error", "meta_4: (#4) Application request limit reached")).toBe("4");
    // Sem código na resposta (`<canal>_erro`) ou só o rótulo do adapter: nada a ler.
    expect(codigoDaPlataforma("meta_error", "meta_erro: build_failed")).toBeNull();
    expect(codigoDaPlataforma("zernio_error", "zernio_template_failed: timeout")).toBeNull();
  });

  it("recusa do pré-voo deste sistema", () => {
    expect(codigoDaPlataforma("zernio_error", 'template_not_approved: "x" (es) está PAUSED')).toBe("template_not_approved");
  });

  it("sem código nenhum: null", () => {
    expect(codigoDaPlataforma("send_failed", "timeout")).toBeNull();
    expect(codigoDaPlataforma(null, null)).toBeNull();
  });
});

describe("recusaDoEnvioDeModelo: o prefixo que o envio de modelo grava", () => {
  it.each([
    ["meta_132000: Parameter mismatch", { codigo: "132000", textoDoProvedor: "Parameter mismatch" }],
    ["meta_100: Parameter name is missing or empty", { codigo: "100", textoDoProvedor: "Parameter name is missing or empty" }],
    ["meta_erro: build_failed", { codigo: "erro", textoDoProvedor: "build_failed" }],
    ["meta_4: (#4) Application request limit reached", { codigo: "4", textoDoProvedor: "(#4) Application request limit reached" }],
    ["template_missing: promo (pt_BR) não está no espelho", { codigo: "template_missing", textoDoProvedor: "promo (pt_BR) não está no espelho" }],
  ])("%s", (texto, esperado) => {
    expect(recusaDoEnvioDeModelo(texto)).toEqual(esperado);
  });

  it("o texto do provedor sai cortado em 300 caracteres", () => {
    expect(recusaDoEnvioDeModelo(`meta_131009: ${"a".repeat(500)}`)?.textoDoProvedor).toBe("a".repeat(300));
  });

  it.each(["template_missing_values: 1", "400 Bad Request", "131026 — Undeliverable", "", null])(
    "não é recusa do envio de modelo: %s",
    (texto) => {
      expect(recusaDoEnvioDeModelo(texto)).toBeNull();
    },
  );
});

// O desfecho de status do parceiro (`zernio/webhook.ts`) grava `zernio_error` e
// `<código> — <título> — <explicação>`. A dica do selo mostrava esse texto.
describe("a tela da conversa: desfecho do parceiro com código sem frase nossa", () => {
  const t = (s: string) => s;
  it.each([
    [
      "131000 — Something went wrong — Message failed to send due to an unknown error.",
      "131000: Something went wrong. Message failed to send due to an unknown error.",
    ],
    ["131053 — Media upload error — Unable to download the media.", "131053: Media upload error. Unable to download the media."],
  ])("%s: o texto gravado, não 'Confira a conexão', e sem o nosso travessão", (texto, naTela) => {
    expect(motivoDaFalhaDaMensagem({ error_code: "zernio_error", error_message: texto }, t)).toBe(naTela);
  });

  it("código com frase nossa: a frase (controle)", () => {
    expect(motivoDaFalhaDaMensagem({ error_code: "zernio_error", error_message: "131026 — Message undeliverable — x" }, t))
      .toMatch(/^Não foi possível entregar/);
  });

  it("sem o formato do desfecho, a frase do canal segue (500 do serviço)", () => {
    expect(motivoDaFalhaDaMensagem({ error_code: "zernio_error", error_message: "500 Internal Server Error" }, t))
      .toBe("O canal recusou o envio. Confira a conexão em Conexões.");
  });
});
