/**
 * A política de retenção — regra PURA, sem banco e sem env, para a poda da fila
 * e o expurgo da auditoria (issue #261).
 *
 * ─── Por que um módulo, e não `z.coerce.number()` em `lib/env.ts` ───────────
 *
 * `lib/env.ts` LANÇA quando o schema recusa, e no Next isso acontece na primeira
 * requisição — com healthcheck TCP puro, o contêiner fica `healthy` com 100% das
 * respostas em 500. É a mesma armadilha documentada em `AI_BUDGET_ENFORCEMENT`:
 * um `z.coerce.number().int().positive()` aqui transformaria
 * `JOB_QUEUE_RETENTION_DAYS=noventa` — digitado às 2h por quem está tentando
 * liberar espaço — no derrubador do produto inteiro. As duas chaves entram como
 * `z.string()` e são interpretadas AQUI, onde lixo resolve para o lado seguro.
 *
 * ─── O piso não é sugestão ──────────────────────────────────────────────────
 *
 * Este módulo devolve o número que o CHAMADOR pede ao banco; para a FILA e a
 * AUDITORIA o piso de verdade mora dentro de `fn_podar_fila_de_jobs` e
 * `fn_expurgar_auditoria_vencida` (`greatest(..., piso)`), porque só lá ele vale
 * para QUALQUER chamador — inclusive um `psql` na mão. Repeti-lo aqui serve para
 * outra coisa: para o operador ver no log que o valor dele foi elevado, em vez
 * de descobrir pela ausência de efeito. Os dois lados usam as mesmas constantes
 * deste arquivo, e `tests/invariants/retencao-poda-e-expurgo.test.ts` compara os
 * dois.
 *
 * ⚠️ A CAPTAÇÃO É A EXCEÇÃO, e por isso o aviso NÃO diz mais "o piso também é
 * aplicado dentro da função do banco": para `webhook_lead_captures` isso seria
 * FALSO. A poda dela é um DELETE do admin client (`lib/webhooks/retencao-da-
 * captacao.ts`), não uma `security definer` — não há função onde enfiar o piso,
 * e o alcance dele termina no TypeScript. Uma frase que promete uma proteção
 * inexistente é pior que a ausência da frase: ela faz quem lê parar de checar.
 */

/** 90 dias. Longe o bastante do horizonte em que "1º outbound" ainda diz algo. */
export const RETENCAO_FILA_DIAS_PADRAO = 90;
/** Piso da fila: abaixo disso a cascata em `send_ledger` alcança lead vivo. */
export const RETENCAO_FILA_DIAS_PISO = 7;
/** 1825 dias = os 5 anos da regra L-10 (`docs/business-rules`, L-10). */
export const RETENCAO_AUDITORIA_DIAS_PADRAO = 1825;
/** Piso da auditoria: o knob nunca vira apagador de rastro recente. */
export const RETENCAO_AUDITORIA_DIAS_PISO = 90;
/**
 * 365 dias para o HISTÓRICO de leads captados (`webhook_lead_captures`).
 *
 * Muito mais longo que a fila e mais curto que a auditoria, e as duas pontas
 * têm razão: a linha não é despejo de depuração (é o que a aba "Leads
 * recebidos" mostra, e a pergunta útil — "de qual campanha veio quem fechou?" —
 * é de meses atrás), mas também não é rastro legal de 5 anos. Um ano fiscal
 * inteiro, a ~1 kB por formulário: 300 leads/dia dão ~110 MB.
 */
/**
 * Quantos dias de PASSADO o espelho da agenda conectada guarda.
 *
 * `calendar_external_events` é cache do que o Google já tem: reconstruível pelo
 * sync, apagado em cascata quando a conexão sai. Sem prazo, "espelho" vira só um
 * nome mais simpático para um arquivo permanente de compromissos de terceiros —
 * guardado por um produto que declarou não ser o controlador daquele dado.
 *
 * O corte é por `ends_at`, nunca por `created_at`: compromisso futuro não
 * envelhece, e apagá-lo faria a agenda marcar em cima de hora ocupada.
 */
export const RETENCAO_ESPELHO_AGENDA_DIAS_PADRAO = 90;

/**
 * Piso BAIXO de propósito, ao contrário do da auditoria.
 *
 * 90 dias de piso existem lá para o knob não virar apagador de rastro depois de
 * um incidente. Aqui é cache: quem quiser mais passado pede ao sync, que repõe.
 * Piso alto não protegeria ninguém — só guardaria mais tempo dado de terceiro.
 */
export const RETENCAO_ESPELHO_AGENDA_DIAS_PISO = 7;

export const RETENCAO_CAPTACAO_DIAS_PADRAO = 365;
/**
 * Piso da captação: o knob nunca vira apagador de ORIGEM.
 *
 * A tabela guarda de onde o contato veio — a página, o IP, a campanha, o
 * consentimento implícito de ter preenchido. Trinta dias é o mínimo em que essa
 * pergunta ainda tem chance de ser feita.
 *
 * ⚠️ DIFERENÇA DECLARADA em relação aos dois pisos acima: aqueles moram DENTRO
 * de uma função do banco (`greatest(..., piso)`), o que os faz valer até para
 * um `psql` na mão. Este mora no TypeScript que apaga
 * (`lib/webhooks/retencao-da-captacao.ts`), porque a poda da captação é um
 * DELETE do admin client, não uma `security definer` — não há função onde
 * enfiá-lo. O alcance é menor e está escrito aqui em vez de presumido.
 */
export const RETENCAO_CAPTACAO_DIAS_PISO = 30;

/**
 * 90 dias para as observações do Jev (`jev_observacoes`, migration 0350): só
 * rótulos e probabilidades, sem texto. O piso de 30 é a janela que o cartão do
 * Jev mostra ("últimos 30 dias"), e mora também NO CORPO de
 * `fn_expurgar_observacoes_do_jev`.
 */
export const RETENCAO_OBSERVACOES_JEV_DIAS_PADRAO = 90;
export const RETENCAO_OBSERVACOES_JEV_DIAS_PISO = 30;

/**
 * 400 dias para a TELEMETRIA DA IA (`llm_calls`, `metrics`, `skill_activations`,
 * `ai_router_decisions` — migration 0354), um prazo para as quatro.
 *
 * A tela que mais olha para trás olha 90 dias (`MAX_RANGE_DAYS` em
 * `app/api/v1/ai/usage` e `app/api/v1/ai/evolution`); o orçamento olha o mês
 * corrente. Pouco mais de um ano deixa comparar o mesmo mês do ano anterior.
 *
 * Quem aplica é `fn_expurgar_telemetria_de_ia_vencida`, com o piso no CORPO. Ela
 * NUNCA apaga `llm_calls` com `legacy_invocation_id`: o backfill da 0130, que o
 * `update.sh` reaplica, recopiaria a linha de `ai_invocations` a cada atualização.
 */
export const RETENCAO_TELEMETRIA_DE_IA_DIAS_PADRAO = 400;
/** Piso de 100 dias: acima da janela de 90 que as telas de uso e evolução mostram. */
export const RETENCAO_TELEMETRIA_DE_IA_DIAS_PISO = 100;

/**
 * 2 dias para o RITMO DE ENVIO (`pacing_ledger`, migration 0354) — o padrão É o
 * piso, porque nenhum leitor olha mais longe.
 *
 * `loadPacingState` pergunta o último envio do número e
 * quantos saíram desde a meia-noite local (no máximo 24 h atrás). A função
 * `fn_expurgar_ritmo_de_envio_vencido` NUNCA apaga a última linha de cada número,
 * em nenhuma idade — é dela que o espaçamento do próximo envio mede. Subir o
 * knob só serve a quem quer investigar à mão os envios de dias passados.
 */
export const RETENCAO_RITMO_DE_ENVIO_DIAS_PADRAO = 2;
/** Piso de 2 dias: o dobro do dia local, a janela mais longa que o ritmo lê. */
export const RETENCAO_RITMO_DE_ENVIO_DIAS_PISO = 2;

/**
 * 30 dias para as CÓPIAS ENVIADAS (`outbound_copies`, migration 0354), e nunca
 * as últimas `windowSize` do número.
 *
 * O gate anti-template-idêntico (`loadRecentCopies`) lê as últimas `windowSize`
 * do número (20, ou o knob de `channel_knobs.spinning_knobs`), sem olhar a
 * idade. `fn_expurgar_copias_enviadas_vencidas` guarda o MAIOR entre isso e o
 * prazo. A tabela guarda texto enviado sem `contact_id` — fora da cascata de
 * LGPD —, então guardar menos é também apagar menos texto de pessoa sem dono.
 */
export const RETENCAO_COPIAS_ENVIADAS_DIAS_PADRAO = 30;
/** Piso de 7 dias: o que o operador investiga depois de um alerta de número. */
export const RETENCAO_COPIAS_ENVIADAS_DIAS_PISO = 7;

/**
 * 180 dias para o CHECKPOINT SUPERADO (`lead_checkpoints`, migration 0354).
 *
 * Só sai o que já não é o último da sua fronteira (conversa, revisão do
 * atendimento, demanda e revisão dela — o recorte de `latestCheckpoint`) e não
 * é lido por job `pending`/`running` (nem pelo próprio `job_id`, nem pelo
 * `origin_job_id` do Operador). O checkpoint vigente de cada atendimento fica
 * para sempre; o que se poda é o resumo de turnos que um resumo mais novo já
 * substituiu, e isso muda a exportação de LGPD, que lista os resumos do titular.
 * Quem aplica é `fn_expurgar_checkpoints_superados`, piso no CORPO.
 */
export const RETENCAO_CHECKPOINTS_DIAS_PADRAO = 180;
/** Piso de 30 dias: o turno de um mês atrás ainda é investigável por inteiro. */
export const RETENCAO_CHECKPOINTS_DIAS_PISO = 30;

export interface RetencaoInterpretada {
  /** Dias a pedir ao banco. Nunca abaixo do piso, nunca `NaN`. */
  readonly dias: number;
  /**
   * Frase pronta em pt-BR quando o valor do operador NÃO foi usado como escrito.
   * `null` quando a chave está ausente (o caso normal) ou foi aceita inteira.
   * Nunca a frase tranquilizadora: se o número dele não valeu, o log diz.
   */
  readonly aviso: string | null;
}

/**
 * Interpreta o valor cru de uma variável de ambiente de retenção.
 *
 * Ausente ou vazio → o padrão, sem aviso (é o caminho de toda instalação que
 * nunca editou `.env`, e a doutrina de packaging exige que ele funcione).
 * Não-numérico, zero ou negativo → o padrão, COM aviso.
 * Abaixo do piso → o piso, COM aviso.
 */
export function interpretarRetencao(
  bruto: string | undefined,
  opcoes: { readonly chave: string; readonly padrao: number; readonly piso: number },
): RetencaoInterpretada {
  const texto = (bruto ?? "").trim();
  if (texto === "") return { dias: opcoes.padrao, aviso: null };

  // `Number()` e não `parseInt`: `parseInt("90dias")` devolve 90 em silêncio, e
  // aceitar sufixo faria `JOB_QUEUE_RETENTION_DAYS=90d` virar 90 sem o operador
  // saber que o `d` foi ignorado. Aqui ele é lixo, e lixo tem aviso.
  const numero = Number(texto);
  if (!Number.isFinite(numero) || !Number.isInteger(numero) || numero <= 0) {
    return {
      dias: opcoes.padrao,
      aviso:
        `${opcoes.chave}="${texto}" não é um número inteiro de dias — ` +
        `usando o padrão de ${opcoes.padrao} dias.`,
    };
  }

  if (numero < opcoes.piso) {
    return {
      dias: opcoes.piso,
      aviso:
        `${opcoes.chave}=${numero} está abaixo do piso de ${opcoes.piso} dias — ` +
        `usando ${opcoes.piso}.`,
    };
  }

  return { dias: numero, aviso: null };
}
