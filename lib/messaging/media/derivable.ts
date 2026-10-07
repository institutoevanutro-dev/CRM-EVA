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

/**
 * Predicado SQL: a mídia `m` ainda VAI virar texto — só por ela vale esperar.
 * Fora dele, a que nunca será lida e que só ganha estado final depois de uma
 * fila inteira (download + derivação), segurando o texto seguinte até o teto:
 *
 *  - vídeo sem nenhuma versão publicada com `video_frames_enabled` (a mesma
 *    pergunta do worker de derivação, que então a marca `skipped`);
 *  - mídia importada do histórico do número oficial (`importada_do_historico`),
 *    que o worker de download guarda sem derivar.
 *
 * Usado pelo drain (espera) e pela anotação do turno (o que ele pôde ler): as
 * duas réguas não podem discordar.
 */
export function sqlMidiaVaiSerLida(m: string): string {
  return `(coalesce(${m}.metadata->>'importada_do_historico', '') <> 'true'
          and (${m}.type <> 'video' or exists (
                select 1 from ai_agent_versions vv
                 where vv.organization_id = ${m}.organization_id
                   and vv.status = 'published' and vv.video_frames_enabled)))`;
}
