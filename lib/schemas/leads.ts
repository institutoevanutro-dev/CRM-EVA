/**
 * Zod schemas for `/api/v1/leads/*` endpoints (EPIC-04 waves 1-3).
 *
 * Contracts:
 *  - moveLeadSchema   → POST /api/v1/leads/[id]/move (P-01, P-05, P-08)
 *  - winLeadSchema    → POST /api/v1/leads/[id]/win  (P-02, idempotent)
 *  - loseLeadSchema   → POST /api/v1/leads/[id]/lose (P-02, P-03)
 *  - bulkLeadActionSchema → POST /api/v1/leads/bulk  (AT-06, max 50)
 */
import { z } from "zod";

/**
 * Accept either ISO 8601 (e.g. "2026-04-29T03:15:54.000Z") or Postgres-style
 * timestamptz (e.g. "2026-04-29 03:15:54.123456+00") since Supabase returns
 * the latter and the client passes it through. Both parse to the same Date.
 */
const flexibleTimestamp = z
  .string()
  .min(10)
  .refine((s) => !Number.isNaN(Date.parse(s)), "expected_updated_at deve ser um timestamp válido");

export const moveLeadSchema = z.object({
  stage_id: z.string().uuid(),
  position_in_stage: z.number().finite(),
  expected_updated_at: flexibleTimestamp,
  /**
   * O motivo da perda, quando a etapa de destino é de perda (issue #917). É o
   * caminho do ARRASTO: a decisão de exigir/gravar mora em
   * `lib/leads/motivo-da-perda.ts` — aqui só se aceita o campo, e um motivo em
   * branco é tratado lá como ausente (uma recusa de negócio, uma só, para os três
   * caminhos; string vazia morrendo no Zod daria uma mensagem de validação
   * diferente da que o /lose devolve para o mesmo caso).
   */
  lost_reason: z.string().max(500).optional(),
});
export type MoveLeadInput = z.infer<typeof moveLeadSchema>;

/**
 * cloneLeadSchema → POST /api/v1/leads/[id]/clone (P-01).
 *
 * O caminho para OUTRO funil: `pipeline_id` é obrigatório, `stage_id` é opcional
 * (sem ele a primeira etapa aberta do funil destino recebe o negócio) e
 * `lost_reason` é o motivo do encerramento da ORIGEM — canônico ou estendido pelo
 * funil (o trigger do banco é a fonte de verdade, como em `loseLeadSchema`).
 */
export const cloneLeadSchema = z.object({
  pipeline_id: z.string().uuid(),
  stage_id: z.string().uuid().optional(),
  lost_reason: z.string().min(1).max(500).optional(),
});
export type CloneLeadInput = z.infer<typeof cloneLeadSchema>;

export const winLeadSchema = z.object({}).passthrough();
export type WinLeadInput = z.infer<typeof winLeadSchema>;

/**
 * Canonical lost reasons enforced by DB trigger fn_validate_lost_reason_required.
 * Pipeline.settings.lost_reasons (jsonb array) can extend this list per-tenant.
 */
export const CANONICAL_LOST_REASONS = [
  "requested_by_customer",
  "price",
  "no_response",
  "product_unavailable",
  "cancelled_by_store",
  "cancelled_by_customer",
  "payment_failed",
  "other",
  /**
   * Motivo do SISTEMA para quem respondeu PARAR (migration 0310, portado do
   * DeskcommCRM PR 2049): a ingestão fecha sozinha todo negócio aberto do
   * contato com ele. Não é `requested_by_customer` porque pedir silêncio não é
   * cancelar. CONTA como perda — é oportunidade que foi embora.
   */
  "opted_out_of_messages",
] as const;
export type CanonicalLostReason = (typeof CANONICAL_LOST_REASONS)[number];

/**
 * O rótulo legível de cada motivo canônico (pt-BR; a tela passa por `t()`).
 * Ao lado da lista para a janela de perda, o filtro do quadro e o relatório
 * "Perdas" mostrarem o MESMO texto, nunca a chave crua (DeskcommCRM #1717).
 */
export const ROTULO_DO_MOTIVO_CANONICO: Record<CanonicalLostReason, string> = {
  requested_by_customer: "Cliente solicitou cancelamento",
  price: "Preço",
  no_response: "Sem resposta do cliente",
  product_unavailable: "Produto indisponível",
  cancelled_by_store: "Cancelado pela loja",
  cancelled_by_customer: "Cancelado pelo cliente",
  payment_failed: "Falha no pagamento",
  other: "Outro motivo",
  opted_out_of_messages: "Pediu para não receber mensagens",
};

/** O rótulo pt-BR do motivo: o do canônico, ou o próprio texto do motivo do funil. */
export function rotuloDoMotivoDePerda(motivo: string): string {
  return (ROTULO_DO_MOTIVO_CANONICO as Record<string, string | undefined>)[motivo] ?? motivo;
}

/**
 * As categorias com que o relatório "Perdas" e o filtro do quadro agrupam
 * (DeskcommCRM #1717). O funil atribui a categoria a cada motivo em
 * `settings.lost_reasons` (`{ label, categoria }`).
 */
export const CATEGORIAS_DE_PERDA = ["Cliente", "Concorrência", "Mérito", "Nós", "Ausência"] as const;
export type CategoriaDePerda = (typeof CATEGORIAS_DE_PERDA)[number];

/**
 * A categoria PADRÃO de cada motivo canônico: o motivo já nasce agrupado sem
 * ninguém cadastrar nada, e o funil pode sobrescrever. `other` fica sem: sem
 * saber o que aconteceu, a tela estaria inventando informação.
 */
export const CATEGORIA_PADRAO_DO_MOTIVO: Partial<Record<CanonicalLostReason, CategoriaDePerda>> = {
  requested_by_customer: "Cliente",
  opted_out_of_messages: "Cliente",
  cancelled_by_customer: "Cliente",
  payment_failed: "Cliente",
  price: "Nós",
  product_unavailable: "Nós",
  cancelled_by_store: "Nós",
  no_response: "Ausência",
};

/** A categoria de um valor gravado em `lost_reason`, se o produto tem uma. */
export function categoriaPadraoDoMotivo(valor: string): CategoriaDePerda | undefined {
  return CATEGORIA_PADRAO_DO_MOTIVO[valor.trim() as CanonicalLostReason];
}

/**
 * loseLeadSchema accepts canonical reasons OR any string (pipeline-extended).
 * The server-side DB trigger is the source of truth; we keep the Zod schema
 * permissive here to not block tenant-specific extensions.
 */
export const loseLeadSchema = z.object({
  lost_reason: z.string().min(1, "lost_reason é obrigatório").max(500),
});
export type LoseLeadInput = z.infer<typeof loseLeadSchema>;

/**
 * createLeadSchema → POST /api/v1/leads
 * Status, source_metadata, custom_fields, position_in_stage are server-managed.
 */
export const createLeadSchema = z.object({
  pipeline_id: z.string().uuid(),
  stage_id: z.string().uuid(),
  title: z.string().min(2).max(200),
  description: z.string().max(2000).nullable().optional(),
  contact_id: z.string().uuid().nullable().optional(),
  value_cents: z.coerce.number().int().nonnegative().nullable().optional(),
  currency: z.string().length(3).default("BRL"),
  owner_user_id: z.string().uuid().nullable().optional(),
  /** Dono agente já na criação (0070) — mesma regra do update: os dois é 422. */
  owner_agent_id: z.string().uuid().nullable().optional(),
  expected_close_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  tags: z.array(z.string()).default([]),
  source: z.string().min(1).default("manual"),
});
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

/**
 * updateLeadSchema → PATCH /api/v1/leads/[id]
 * Stage/pipeline transitions go through /move /win /lose endpoints.
 */
export const updateLeadSchema = z.object({
  title: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  contact_id: z.string().uuid().nullable().optional(),
  value_cents: z.coerce.number().int().nonnegative().nullable().optional(),
  currency: z.string().length(3).optional(),
  owner_user_id: z.string().uuid().nullable().optional(),
  /**
   * Dono agente (0070). Exclusivo com owner_user_id — mandar os dois não-nulos
   * é 422. `owner_kind` NÃO entra aqui: é derivado no handler a partir de qual
   * dos dois veio, para a constraint crm_leads_owner_kind_coherence nunca
   * depender do que o cliente mandou.
   */
  owner_agent_id: z.string().uuid().nullable().optional(),
  expected_close_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  tags: z.array(z.string()).optional(),
  custom_fields: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

export const bulkLeadActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("move"),
    lead_ids: z.array(z.string().uuid()).min(1).max(50),
    // Sem `position_in_stage`: quem posiciona o lote é o banco
    // (`fn_mover_leads_em_lote`, migration 0209), porque N cards precisam de N
    // posições distintas e um campo escalar só sabe dizer uma. Um cliente antigo
    // que ainda o mande não quebra — `z.object` descarta chave desconhecida —,
    // e é melhor que ele suma do que ficar aceito e ignorado.
    params: z.object({
      stage_id: z.string().uuid(),
      /**
       * O motivo da perda, quando a etapa de destino é de perda (issue #917):
       * o lote fecha N negócios de uma vez, então UM motivo vale para todos os
       * cards que ainda não têm um. A decisão (e a recusa de negócio) mora em
       * `lib/leads/motivo-da-perda.ts`.
       */
      lost_reason: z.string().max(500).optional(),
    }),
  }),
  z.object({
    action: z.literal("assign"),
    lead_ids: z.array(z.string().uuid()).min(1).max(50),
    params: z.object({ owner_user_id: z.string().uuid().nullable() }),
  }),
  z.object({
    action: z.literal("tag"),
    lead_ids: z.array(z.string().uuid()).min(1).max(50),
    params: z.object({
      add: z.array(z.string()).optional(),
      remove: z.array(z.string()).optional(),
    }),
  }),
  z.object({
    action: z.literal("delete"),
    lead_ids: z.array(z.string().uuid()).min(1).max(50),
    params: z.object({}).optional(),
  }),
]);
export type BulkLeadActionInput = z.infer<typeof bulkLeadActionSchema>;
