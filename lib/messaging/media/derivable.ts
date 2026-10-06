/**
 * Tipos de mensagem cujo conteúdo vira TEXTO antes de o agente responder
 * (áudio → transcrição, imagem → descrição, documento → extração).
 *
 * Vive fora do worker porque duas peças precisam da MESMA resposta e não podem
 * discordar: o worker que deriva e o drain que decide se vale esperar a
 * derivação antes de despachar o turno. Duas listas separadas divergiriam no
 * primeiro tipo novo, e o sintoma seria o agente respondendo "não consigo
 * ouvir" só para um formato.
 */
export const TIPOS_DERIVAVEIS: ReadonlySet<string> = new Set([
  "audio",
  "image",
  "document",
  "video",
]);

/**
 * Estados finais de `messages.media_derived_status` — não há o que esperar.
 *
 * `skipped` é a mídia que o worker desiste de ler DE PROPÓSITO (vídeo com a
 * leitura desligada, que é o padrão; mensagem sem arquivo no storage). Sem ele
 * a linha ficava null para sempre, e o drain — que espera a mídia da CONVERSA —
 * segurava a resposta do texto seguinte até o teto.
 */
export const DERIVACAO_TERMINADA: ReadonlySet<string> = new Set(["ready", "failed", "skipped"]);

/**
 * Quanto o drain espera a derivação de uma mídia antes de despachar o turno sem
 * ela (o racional e as medições estão em `edge/crm/drain.ts`). Mora aqui porque
 * a anotação do turno (`agent/turno-ja-respondido.ts`) usa a mesma régua para
 * saber o que o turno pôde ler.
 */
export const TETO_ESPERA_DERIVACAO_MS = 120_000;
