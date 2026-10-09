// @vitest-environment node
/**
 * O scrub da telemetria apaga documento e endereço que não são telefone nem CPF.
 *
 * Porte de melgarafael/DeskcommCRM #2416 (7ccbd929) e #2435 (5f35f2dd). O mesmo
 * texto vai ao Sentry e, quando ligado, ao Jev: o que sobra aqui sai do país.
 * Resultados EXATOS de propósito: um `toContain` passaria com o dado pela metade.
 */
import { describe, expect, it } from "vitest";

import { scrubMessage } from "@/lib/sentry/scrub";

const casos: Array<[entrada: string, saida: string]> = [
  // internacional sai inteiro (o scrub do fork já cobria; trava para não voltar)
  ["zap +351912345678 ok", "zap [PHONE] ok"],
  ["zap +351 912 345 678 ok", "zap [PHONE] ok"],
  ["zap +34 612 345 678 ok", "zap [PHONE] ok"],
  ["zap +49 30 12345678 ok", "zap [PHONE] ok"],
  ["zap +91 98765 43210 ok", "zap [PHONE] ok"],
  // +55 com qualquer separador
  ["zap +55 11 987654321 ok", "zap [PHONE] ok"],
  ["zap +55-11-98765-4321 ok", "zap [PHONE] ok"],
  ["zap +55.11.98765.4321 ok", "zap [PHONE] ok"],
  ["zap +55 (11) 98765-4321 ok", "zap [PHONE] ok"],
  // nove dígitos em três blocos (NIF, telemóvel)
  ["nif 123 456 789 ok", "nif [PHONE] ok"],
  ["doc 123.456.789 ok", "doc [PHONE] ok"],
  // NIF com prefixo, IBAN, código postal, CEP com hífen
  ["nif PT123456789 ok", "nif [NIF] ok"],
  ["pagamento PT50 0002 0123 1234 5678 9015 4 ok", "pagamento [IBAN] ok"],
  ["morada 1000-001 Lisboa", "morada [CODIGO_POSTAL] Lisboa"],
  ["morada 1000 001 Lisboa", "morada [CODIGO_POSTAL] Lisboa"],
  ["cep 01310-100 ok", "cep [CEP] ok"],
  // o que já saía certo continua igual
  ["doc 123.456.789-09 ok", "doc [CPF] ok"],
  ["em 2026-09-23T18:46:39Z", "em 2026-09-23T18:46:39Z"],
  ["rate limit: 40000000 tokens", "rate limit: 40000000 tokens"],
];

describe("scrub: documentos e endereços de outros formatos (#2416, #2435)", () => {
  it.each(casos)("%s", (entrada, saida) => {
    expect(scrubMessage(entrada)).toBe(saida);
  });
});
