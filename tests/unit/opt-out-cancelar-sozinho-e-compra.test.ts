/**
 * Porte do upstream #4584 (DeskcommCRM, de @webtecnica; issue #4579) —
 * `cancelar` SOZINHO e "cancelar a inscrição" gravavam `is_blocked` na
 * INGESTÃO, antes do modelo (`lib/channels/pos-entrada.ts`).
 *
 * Na clínica o caso mais caro é o lembrete de consulta: o paciente responde
 * "Cancelar" a "confirmar, remarcar ou cancelar?" e some da conversa em
 * silêncio, com os negócios abertos fechados como perdidos.
 *
 * ─── As decisões, cada uma com o seu lado negativo ──────────────────────────
 *
 * 1. `cancelar` sai de `PALAVRAS_DE_OPT_OUT`. NÃO vai para as ambíguas: o
 *    ambíguo cala a IA e escala, o que para quem só respondeu a um menu seria
 *    parar o atendimento sem motivo. Cai em NADA.
 * 2. "cancelar a inscrição" SEM objeto vai para `FRASES_AMBIGUAS_DE_OPT_OUT`,
 *    o espelho da decisão do porte do #2971 para `assinatura`: escala para um
 *    humano e não bloqueia. COM objeto de comunicação ("cancelar a inscrição
 *    das mensagens") continua bloqueando na hora.
 * 3. "não quero receber o boleto/o pix" — no upstream ganhou um lookahead de
 *    objetos de compra. Aqui NÃO foi portado: o fork já exige o objeto de
 *    comunicação em "não quero receber" (CRM EvaLink, 12/10/2026, ver
 *    `RECUSA_DE_RECEBER`), e essas frases já não bloqueavam. Os casos ficam
 *    abaixo como guarda.
 */
import { describe, expect, it } from "vitest";

import { PALAVRAS_DE_OPT_OUT, ehOptOutProvavel, ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";

describe("#4584 — as frases que gravavam `is_blocked` na ingestão", () => {
  it("`cancelar` sozinho não é palavra de saída — é resposta de menu", () => {
    for (const texto of ["cancelar", "Cancelar.", "CANCELAR", "Cancelar \u{1F44D}"]) {
      expect(ehPedidoDeOptOut(texto), texto).toBe(false);
      // Não escala: o ambíguo calaria a IA sem ninguém ter pedido para sair.
      expect(ehOptOutProvavel(texto), texto).toBe(false);
    }
    expect(PALAVRAS_DE_OPT_OUT.has("cancelar")).toBe(false);
  });

  it("`cancelar a inscrição` SEM objeto só escala — não bloqueia", () => {
    for (const texto of [
      "quero cancelar a inscrição",
      "posso cancelar a inscrição e voltar depois?",
      "gostaria de cancelar a inscrição do concurso",
    ]) {
      expect(ehPedidoDeOptOut(texto), texto).toBe(false);
      expect(ehOptOutProvavel(texto), texto).toBe(true);
    }
  });

  it("`cancelar a inscrição` COM objeto de comunicação continua bloqueando", () => {
    for (const texto of [
      "quero cancelar a inscrição das mensagens",
      "cancelar a inscrição da newsletter",
      "cancelar a inscrição dos avisos",
    ]) {
      expect(ehPedidoDeOptOut(texto), texto).toBe(true);
    }
  });

  it("`não quero receber o boleto` é forma de pagamento — não descadastro", () => {
    for (const texto of [
      "não quero receber o boleto",
      "nao quero receber boleto, prefiro cartão",
      "não quero receber mais o boleto",
      "não quero receber o pix",
      "não quero receber o material do curso",
    ]) {
      expect(ehPedidoDeOptOut(texto), texto).toBe(false);
      expect(ehOptOutProvavel(texto), texto).toBe(false);
    }
  });
});

/** Controle negativo: falar de cancelar UMA COISA não descadastra ninguém. */
describe("#4584 — controle negativo: cancelar a consulta ou o pedido não descadastra", () => {
  it("as frases de agenda e de compra", () => {
    for (const texto of [
      "quero cancelar o pedido anterior",
      "quero cancelar o pedido",
      "posso cancelar a consulta de amanhã?",
      "confirmar, remarcar ou cancelar?",
      "cancelar minha inscrição no curso",
      "quero trocar a forma de pagamento do boleto",
    ]) {
      expect(ehPedidoDeOptOut(texto), texto).toBe(false);
      expect(ehOptOutProvavel(texto), texto).toBe(false);
    }
  });
});

/** O lado que NÃO pode regredir: quem pede para sair continua saindo. */
describe("#4584 — o pedido de saída de verdade segue bloqueando", () => {
  it("as palavras de saída e as frases com objeto", () => {
    for (const texto of [
      "parar",
      "PARAR",
      "sair",
      "stop",
      "descadastrar",
      "não quero receber mais nada",
      "não quero receber mensagens",
      "não quero receber propaganda",
      "não quero mais receber nada de vocês",
    ]) {
      expect(ehPedidoDeOptOut(texto), texto).toBe(true);
    }
  });

  it("troca de canal não é saída", () => {
    // Quem diz isso QUER continuar no WhatsApp.
    expect(ehPedidoDeOptOut("não quero receber ligação, só whatsapp")).toBe(false);
  });
});
