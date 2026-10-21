/**
 * Quem sabe reportar conversão para qual plataforma.
 *
 * A feature (`lib/conversoes/`) nunca importa `./meta/conversions` nem
 * `./google/conversions`: ela entrega a credencial (que já diz a plataforma) e
 * a conversão, e este arquivo escolhe o transporte.
 */
import { transporteGoogle } from "./google/conversions";
import { transporteMeta } from "./meta/conversions";
import type {
  ConversaoDeAgendamento,
  CredencialDeConversao,
  PlataformaDeAnuncio,
  ResultadoDeEnvio,
} from "./types";

export const PLATAFORMAS: readonly PlataformaDeAnuncio[] = ["meta_ads", "google_ads"];

/** A plataforma é do vocabulário? Guarda para o que vem do banco em jsonb. */
export function ehPlataformaConhecida(valor: unknown): valor is PlataformaDeAnuncio {
  return typeof valor === "string" && (PLATAFORMAS as readonly string[]).includes(valor);
}

export function enviarConversao(
  credencial: CredencialDeConversao,
  conversao: ConversaoDeAgendamento,
): Promise<ResultadoDeEnvio> {
  return credencial.plataforma === "meta_ads"
    ? transporteMeta.enviar(credencial, conversao)
    : transporteGoogle.enviar(credencial, conversao);
}
