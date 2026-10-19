/**
 * Normalização e hash dos identificadores — a regra de CADA plataforma, que não
 * é a mesma, e um id de evento que não se reverte.
 *
 * O hash errado não dá erro: a plataforma aceita, não casa ninguém, e o envio
 * parece funcionar. Por isso cada regra mora aqui, com o teste ao lado
 * (`tests/unit/conversao-de-agendamento.test.ts`).
 *
 *   Meta  (Conversions API, "customer information parameters"):
 *     ph — só dígitos, com código do país, sem `+` nem zeros à esquerda.
 *     em — sem espaços nas pontas, minúsculo.
 *   Google (Google Ads API, "normalize and hash user-provided data"):
 *     phone — E.164: `+`, código do país, só dígitos.
 *     email — sem espaços nas pontas, minúsculo; em gmail.com/googlemail.com,
 *             sem os pontos antes do `@`.
 *   As duas: SHA-256 em hexadecimal minúsculo.
 */
import { createHash } from "node:crypto";

const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");

/** `+` e 8 a 15 dígitos, ou `null`. Número fora disso não casa ninguém. */
export function telefoneE164(telefone: string | null | undefined): string | null {
  const digitos = (telefone ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if (digitos.length < 8 || digitos.length > 15) return null;
  return `+${digitos}`;
}

export function emailNormalizado(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
}

export function telefoneHashMeta(telefone: string | null | undefined): string | null {
  const e164 = telefoneE164(telefone);
  return e164 ? sha256(e164.slice(1)) : null;
}

export function emailHashMeta(email: string | null | undefined): string | null {
  const e = emailNormalizado(email);
  return e ? sha256(e) : null;
}

export function telefoneHashGoogle(telefone: string | null | undefined): string | null {
  const e164 = telefoneE164(telefone);
  return e164 ? sha256(e164) : null;
}

export function emailHashGoogle(email: string | null | undefined): string | null {
  const e = emailNormalizado(email);
  if (!e) return null;
  const [usuario, dominio] = e.split("@") as [string, string];
  const semPontos =
    dominio === "gmail.com" || dominio === "googlemail.com" ? usuario.replace(/\./g, "") : usuario;
  return sha256(`${semPontos}@${dominio}`);
}

/**
 * O id do evento: igual para a mesma entrada (é o que deixa a plataforma
 * descartar a cópia) e sem caminho de volta para o agendamento.
 */
export function idDoEvento(organizationId: string, agendamentoId: string, evento: string): string {
  return sha256(`${organizationId}:${agendamentoId}:${evento}`).slice(0, 32);
}
