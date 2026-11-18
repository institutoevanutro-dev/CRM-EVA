/**
 * O que a API aceita de fora. Zod em todo input externo, como manda a doutrina —
 * e nada aqui aceita `organization_id`: a organização vem do `requireRole()`,
 * nunca do corpo.
 */
import { z } from "zod";

import { filtroDeAudienciaSchema } from "./audiencia";

const INTEIRO = { error: "Use um número inteiro." };

/**
 * O ritmo próprio. Todos opcionais e anuláveis: `null` devolve a decisão ao
 * canal, que é o default de quem nunca abriu esta seção.
 *
 * As faixas são as do CHECK da migration 0374 — validação de entrada do
 * operador, não default de comportamento (os números de pacing são fonte única
 * em `lib/agent-engine/pacing/defaults.ts`). As frases são as que a TELA mostra
 * embaixo do campo (`CamposDeRitmo`): uma regra, dois lugares.
 */
export const ritmoSchema = z.object({
  intervalo_segundos: z
    .number(INTEIRO)
    .int(INTEIRO)
    .min(1, { error: "Use pelo menos 1 segundo." })
    .max(86_400, { error: "No máximo 86400 segundos (um dia)." })
    .nullable()
    .optional(),
  janela_inicio_hora: z
    .number(INTEIRO)
    .int(INTEIRO)
    .min(0, { error: "Use uma hora de 0 a 23." })
    .max(23, { error: "Use uma hora de 0 a 23." })
    .nullable()
    .optional(),
  janela_fim_hora: z
    .number(INTEIRO)
    .int(INTEIRO)
    .min(1, { error: "Use uma hora de 1 a 24." })
    .max(24, { error: "Use uma hora de 1 a 24." })
    .nullable()
    .optional(),
  teto_diario: z
    .number(INTEIRO)
    .int(INTEIRO)
    .min(1, { error: "Use pelo menos 1." })
    .max(10_000, { error: "No máximo 10000." })
    .nullable()
    .optional(),
  teto_horario: z
    .number(INTEIRO)
    .int(INTEIRO)
    .min(1, { error: "Use pelo menos 1." })
    .max(10_000, { error: "No máximo 10000." })
    .nullable()
    .optional(),
});

/**
 * A janela é as duas horas ou nenhuma — é o CHECK `campaigns_janela_check`.
 *
 * Sem esta conferência, "Enviar a partir das 9" sem "Parar às" chegava ao
 * banco e voltava como "Erro interno" (auditoria de 17/11/2026, item 18). E o
 * motor de ritmo só aplica janela com as duas pontas: meia janela gravada nos
 * padrões seria ignorada em silêncio.
 */
export function erroDaJanela(
  inicio: number | null | undefined,
  fim: number | null | undefined,
): string | null {
  const temInicio = inicio !== null && inicio !== undefined;
  const temFim = fim !== null && fim !== undefined;
  if (temInicio !== temFim) return "Preencha as duas horas, ou deixe as duas em branco.";
  if (temInicio && temFim && fim <= inicio) return "A janela precisa terminar depois de começar.";
  return null;
}

function conferirJanela(
  r: { janela_inicio_hora?: number | null; janela_fim_hora?: number | null },
  ctx: z.RefinementCtx,
): void {
  const erro = erroDaJanela(r.janela_inicio_hora, r.janela_fim_hora);
  if (!erro) return;
  // O erro fica no campo que falta (ou no fim, se a ordem está trocada): é ali
  // que a pessoa olha.
  const faltaInicio = r.janela_inicio_hora == null && r.janela_fim_hora != null;
  ctx.addIssue({ code: "custom", message: erro, path: [faltaInicio ? "janela_inicio_hora" : "janela_fim_hora"] });
}

/** O ritmo inteiro, com a janela conferida — o que a tela valida antes de mandar. */
export const ritmoCompletoSchema = ritmoSchema.superRefine(conferirJanela);

const CAMPOS_DO_RITMO = new Set(Object.keys(ritmoSchema.shape));

/**
 * A frase da recusa: a do ritmo, que é escrita para gente ("Use pelo menos 1
 * segundo."); o resto continua "Dados inválidos." com o detalhe por campo. Só
 * "Dados inválidos." para um intervalo 0 mandava a pessoa adivinhar o campo.
 */
export function mensagemDaRecusa(erro: z.ZodError): string {
  return erro.issues.find((i) => CAMPOS_DO_RITMO.has(String(i.path[0])))?.message ?? "Dados inválidos.";
}

const baseDaCampanha = {
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).nullable().optional(),
  channel_session_id: z.string().uuid(),
  message_body: z.string().trim().max(4096).nullable().optional(),
  base_legal: z.enum(["consent", "legitimate_interest"]),
  lia_ref: z.string().trim().max(120).nullable().optional(),
  audience_filter: filtroDeAudienciaSchema.optional(),
  /**
   * Os números EXTRAS do rodízio (migration 0376). O principal continua em
   * `channel_session_id`; estes entram junto. Vazio = campanha de um número só,
   * que é como toda campanha existente se comporta.
   */
  channel_session_ids: z.array(z.string().uuid()).max(10).optional(),
  /**
   * Onde o card de quem responde nasce, e quem atende (migration 0377).
   * `null` devolve a decisão ao número, que é o comportamento de sempre.
   */
  pipeline_id: z.string().uuid().nullable().optional(),
  stage_id: z.string().uuid().nullable().optional(),
  agent_id: z.string().uuid().nullable().optional(),
};

export const criarCampanhaSchema = z
  .object({ ...baseDaCampanha })
  .merge(ritmoSchema)
  .refine(
    (c) => c.base_legal !== "legitimate_interest" || (c.lia_ref ?? "").trim() !== "",
    {
      message:
        "Interesse legítimo exige a referência da avaliação (LIA) — é ela que responde a quem " +
        "perguntar com base em quê recebeu a mensagem.",
      path: ["lia_ref"],
    },
  )
  .refine((c) => c.stage_id == null || c.pipeline_id != null, {
    message: "Escolha o funil antes da etapa — etapa sem funil seria um card sem coluna.",
    path: ["stage_id"],
  })
  .superRefine(conferirJanela);

/**
 * Edição: tudo opcional. A base legal e a janela são conferidas NA ROTA, contra
 * o que está gravado — o valor que vale é o mesclado.
 *
 * O filtro entra como objeto solto, sem `default` nem `refine`, de propósito:
 * aqui ele é um PEDAÇO a mesclar (`mesclarFiltroDeAudiencia`), e o schema
 * inteiro roda sobre o resultado. Validado inteiro aqui, uma chave ausente
 * viraria `[]` e apagaria o critério gravado.
 */
export const editarCampanhaSchema = z
  .object({
    name: baseDaCampanha.name.optional(),
    description: baseDaCampanha.description,
    channel_session_id: baseDaCampanha.channel_session_id.optional(),
    message_body: baseDaCampanha.message_body,
    base_legal: baseDaCampanha.base_legal.optional(),
    lia_ref: baseDaCampanha.lia_ref,
    audience_filter: z.record(z.string(), z.unknown()).optional(),
    channel_session_ids: baseDaCampanha.channel_session_ids,
    pipeline_id: baseDaCampanha.pipeline_id,
    stage_id: baseDaCampanha.stage_id,
    agent_id: baseDaCampanha.agent_id,
  })
  .merge(ritmoSchema);

export const previaSchema = z.object({
  audience_filter: filtroDeAudienciaSchema,
  message_body: z.string().max(4096).default(""),
  campaign_id: z.string().uuid().optional(),
});

export const criarTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(4096),
});

export const editarTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  body: z.string().trim().min(1).max(4096).optional(),
});

/**
 * O telefone entra CRU e sai em hash — a normalização e o hash moram em
 * `lib/campanhas/exclusoes.ts`, para o mesmo cálculo valer na gravação e na
 * consulta. Aqui só se exige que algo tenha sido digitado.
 */
export const criarExclusaoSchema = z.object({
  address: z.string().trim().min(8).max(32),
  reason: z.string().trim().max(240).nullable().optional(),
  contact_id: z.string().uuid().nullable().optional(),
});

export const agendarSchema = z.object({ scheduled_at: z.string().datetime() });
export const testarSchema = z.object({ contact_id: z.string().uuid() });

export const listarCampanhasSchema = z.object({
  status: z.string().trim().max(20).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const listarDestinatariosSchema = z.object({
  status: z.string().trim().max(20).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Cursor opaco `created_at|id`, o mesmo formato de `lib/schemas/lead-captures.ts`.
 * Sem HMAC, como os outros: ele só ordena, não autoriza — a organização vem do
 * papel conferido, e um cursor forjado não alcança linha de outro tenant.
 */
export function codificarCursor(c: { created_at: string; id: string }): string {
  return Buffer.from(`${c.created_at}|${c.id}`, "utf8").toString("base64url");
}

export function decodificarCursor(bruto: string): { created_at: string; id: string } | null {
  try {
    const [created_at, id] = Buffer.from(bruto, "base64url").toString("utf8").split("|");
    if (!created_at || !id) return null;
    return { created_at, id };
  } catch {
    return null;
  }
}
