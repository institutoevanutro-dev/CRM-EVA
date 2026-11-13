/**
 * A RECUSA REGISTRADA de uma finalidade de `contacts.consent`, nos DOIS formatos que o banco tem.
 *
 * `contacts.consent` é um mapa de finalidades (`marketing`, `transactional`, `profiling`), e cada finalidade chega por
 * dois escritores com grafias diferentes:
 *
 * - a CAPTAÇÃO (o webhook do Respondi) grava a recusa como `declined_at`, com a hora;
 * - a FICHA do contato (o PATCH de `/api/v1/contacts/{id}`) grava `{ granted: false }`, o formato que o export de LGPD lê.
 *
 * As guardas de envio liam só `declined_at`: uma revogação feita pela ficha não bloqueava nada — a automação, o e-mail e
 * a campanha seguiam mandando para quem a clínica registrou que disse não. Esta função é a régua única; uma guarda nova
 * que leia `declined_at` direto repete o defeito.
 *
 * O que NÃO é recusa, de propósito: a ausência (o DEFAULT da coluna, « ninguém perguntou ») e `granted: null`. Bloquear
 * por ausência pararia toda automação de lead que nunca passou por um formulário com a pergunta.
 *
 * Portado do projeto original (DeskcommCRM, PR #4307).
 */
export type FinalidadeDaRecusa = "marketing" | "transactional" | "profiling";

export function recusaRegistrada(consent: unknown, finalidade: FinalidadeDaRecusa = "marketing"): boolean {
  if (!consent || typeof consent !== "object") return false;
  const f = (consent as Record<string, unknown>)[finalidade];
  if (!f || typeof f !== "object") return false;
  const r = f as Record<string, unknown>;
  return !!r.declined_at || r.granted === false;
}
