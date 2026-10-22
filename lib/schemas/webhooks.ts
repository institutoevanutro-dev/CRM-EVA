/**
 * Zod schemas for webhook-sources e automation-rules (feature Webhooks, Task 12).
 *
 * `ENTIDADE_ESPERADA_POR_GATILHO`, logo abaixo, é a fonte única dos gatilhos:
 * `lib/automation/engine.ts` e `lib/automation/engine.handler.ts` leem daqui.
 * (Este cabeçalho já afirmou "exatamente os 5 eventos" — número que envelheceu
 * na primeira vez que alguém acrescentou um. Agora não há número a envelhecer.)
 */
import { z } from "zod";

import { conditionSchema, conditionsSchema } from "@/lib/automation/conditions";

/**
 * Os gatilhos que o motor reconhece, e a entidade que cada um tem que trazer.
 *
 * É UMA FONTE, e não três, porque as três divergiam: este arquivo listava os
 * gatilhos para o Zod, `engine.ts` repetia o mapa de entidade, e
 * `engine.handler.ts` repetia a lista de novo para se registrar no dispatcher.
 * Acrescentar um gatilho exigia lembrar dos três lugares, e esquecer o terceiro
 * produz o pior desfecho possível: a regra aparece na tela, o operador a salva,
 * o evento acontece — e nada roda, porque o handler não assinou aquele evento.
 * Sem erro, sem log, sem run.
 *
 * A entidade existe porque o trigger legado `fn_emit_event_on_lead_change` emite
 * `lead.created` com `entity_kind='lead'` (derivado por `split_part` do
 * event_type) enquanto os handlers desta feature emitem `crm_lead`. Sem o guard,
 * o motor rodaria a regra duas vezes por mudança de lead.
 */
export const ENTIDADE_ESPERADA_POR_GATILHO = {
  "lead.created": "crm_lead",
  "lead.stage_changed": "crm_lead",
  "message.received": "message",
  "lead.tag_added": "crm_lead",
  // O ganho nasce do trigger `fn_emit_event_on_lead_change`, por QUALQUER porta
  // (botão Ganhar, arrasto no kanban, lote): `fn_log_event` deriva a entidade do
  // nome do evento, então ela chega como `lead`, e não `crm_lead`. Não há outro
  // emissor de `lead.won` (`lib/leads/encerramento.ts` não emite de propósito),
  // então não há linha duplicada para o guard filtrar.
  "lead.won": "lead",
  "contact.tag_added": "contact",
  // O aniversário nasce do cron `contact-birthdays`, e não de uma ação de
  // alguém: a entidade que ele traz é o próprio contato que faz aniversário.
  "contact.birthday": "contact",
  // O contato GANHOU telefone (porte do upstream #2861): nasce do PATCH de
  // contatos, depois de gravar o número, só na transição de vazio para preenchido.
  "contact.phone_added": "contact",
  "appointment.created": "calendar_appointment",
  "appointment.confirmed": "calendar_appointment",
  "appointment.rescheduled": "calendar_appointment",
  "appointment.cancelled": "calendar_appointment",
} as const;

export type GatilhoDeAutomacao = keyof typeof ENTIDADE_ESPERADA_POR_GATILHO;

export const TRIGGER_EVENTS = Object.keys(ENTIDADE_ESPERADA_POR_GATILHO) as [
  GatilhoDeAutomacao,
  ...GatilhoDeAutomacao[],
];

// Uma fonte para o avaliador e para a porta da API (#2727): os operadores e o
// grupo `all`/`any` do topo moram em `lib/automation/conditions.ts`.
export { conditionSchema };

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_or_move_lead"), config: z.object({ pipeline_id: z.string().uuid(), stage_id: z.string().uuid() }) }),
  z.object({ type: z.literal("send_whatsapp_message"), config: z.object({ channel_session_id: z.string().uuid(), template: z.string().min(1).max(2000) }) }),
  // O e-mail como SAÍDA (porte do upstream #2794). O transporte não é da regra:
  // é o serviço de e-mail da instalação (`lib/email/resend.ts`). `email_fixo`
  // só existe para o modo `fixo`; "" do input controlado vira ausência.
  z.object({
    type: z.literal("send_email"),
    config: z.object({
      destinatario: z.enum(["contato", "dono_do_lead", "fixo"]),
      email_fixo: z.preprocess(
        (v) => (v === "" ? undefined : v),
        z.string().email("E-mail inválido").max(320).optional(),
      ),
      assunto: z.string().min(1).max(200),
      corpo: z.string().min(1).max(5000),
      formato: z.enum(["texto", "html"]).optional(),
    }).superRefine((config, ctx) => {
      // Sem isto, `fixo` sem endereço salvaria e só falharia na execução.
      if (config.destinatario === "fixo" && !config.email_fixo) {
        ctx.addIssue({
          code: "custom",
          path: ["email_fixo"],
          message: "Informe o endereço de e-mail que recebe os envios desta regra.",
        });
      }
    }),
  }),
  z.object({
    type: z.literal("add_tag"),
    config: z.object({
      tags: z.array(z.string().min(1).max(60)).min(1).max(10),
      // Onde a etiqueta é gravada: `card` (padrão, o de sempre) ou `contato`.
      // Opcional: as regras antigas não têm a chave e continuam iguais.
      destino: z.enum(["card", "contato"]).optional(),
    }),
  }),
  z.object({ type: z.literal("assign_owner"), config: z.object({ user_id: z.string().uuid() }) }),
  z.object({
    type: z.literal("send_ai_message"),
    config: z.object({
      /** Agente PUBLICADO que assina a mensagem. */
      agent_id: z.string().uuid(),
      channel_session_id: z.string().uuid(),
      /**
       * O que fazer com os dados do formulário. Mesmo teto do `prompt_hint` de
       * um passo de follow-up (1000): é instrução, não roteiro — quem escreve
       * mais que isso está tentando pôr o prompt do agente aqui dentro.
       */
      instruction: z.string().min(1).max(1000),
    }),
  }),
  z.object({
    type: z.literal("call_webhook"),
    config: z.object({
      url: z.string().url().max(2000),
      // Input do usuário (plaintext, write-only) — a rota troca por secret_enc.
      secret: z.string().max(200).optional(),
      // Ciphertext hex (round-trip do editor: GET devolve, PATCH preserva).
      secret_enc: z.string().max(4000).optional(),
    }),
  }),
  z.object({
    type: z.literal("start_message_flow"),
    config: z.object({ flow_pointer_id: z.string().uuid(), bind_appointment: z.boolean().optional() }),
  }),
]);

export const createWebhookSourceSchema = z.object({
  name: z.string().min(1).max(120),
  default_pipeline_id: z.string().uuid(),
  default_stage_id: z.string().uuid(),
  redirect_to: z.string().url().max(2000).nullish(),
  field_map: z
    .object({
      name: z.array(z.string()).optional(),
      phone: z.array(z.string()).optional(),
      email: z.array(z.string()).optional(),
    })
    .optional(),
  secret: z.string().min(16).max(200).nullish(),
});
export const updateWebhookSourceSchema = createWebhookSourceSchema.partial().extend({
  is_active: z.boolean().optional(),
});

export const createAutomationRuleSchema = z.object({
  name: z.string().min(1).max(120),
  trigger_event: z.enum(TRIGGER_EVENTS),
  conditions: conditionsSchema.default([]),
  actions: z.array(actionSchema).min(1).max(10),
});
export const updateAutomationRuleSchema = createAutomationRuleSchema.partial().extend({
  is_active: z.boolean().optional(),
});

export type CreateWebhookSourceInput = z.infer<typeof createWebhookSourceSchema>;
export type UpdateWebhookSourceInput = z.infer<typeof updateWebhookSourceSchema>;
export type CreateAutomationRuleInput = z.infer<typeof createAutomationRuleSchema>;
export type UpdateAutomationRuleInput = z.infer<typeof updateAutomationRuleSchema>;
