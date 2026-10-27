/**
 * Zod schemas for /app/settings/* server actions and routes (EPIC-10).
 *
 * - profileSchema: persisted to auth.users.raw_user_meta_data
 * - tenantSchema: persisted to organizations row + organizations.settings jsonb
 * - notificationPrefsSchema: STUB (notification_prefs table not yet migrated)
 * - pipelineConfigPatchSchema: pipeline vocabulary + settings.fields + settings.lost_reasons
 */
import { z } from "zod";

import { ehHexValido, normalizarHex } from "@/lib/branding/rampa";
import { normalizarTags } from "@/lib/contacts/tag-normalizada";
import { IDIOMAS } from "@/lib/i18n/idiomas";
import { MOEDAS_SERVIDAS } from "@/lib/money";

import { conversationTagSchema } from "./messaging";
import { mostrarQuandoSchema } from "./mostrar-quando";

/**
 * Os idiomas que a interface REALMENTE serve.
 *
 * `en-US` saiu: esteve na lista desde sempre e nunca teve uma linha de
 * tradução — escolhê-lo não mudava nada. Espanhol entrou quando passou a mudar.
 * A fonte é `lib/i18n/idiomas`, para a validação e o dicionário não divergirem:
 * um idioma aceito aqui e desconhecido lá cairia no padrão em silêncio.
 */
const LOCALES = IDIOMAS;

/**
 * G6-02: organizations.settings.ai_dispatch_mode (edge-contract do Vendaval).
 * 'native' (default) = o dispatcher de IA deste repo processa os eventos
 * ai_agent.dispatch_requested. 'external' = o tenant delega o dispatch ao
 * runtime externo (Vendaval); o dispatcher nativo PULA o evento sem tocá-lo.
 * `.catch("native")` normaliza chave ausente/null/inválida para o default seguro.
 */
export const AI_DISPATCH_MODES = ["native", "external"] as const;
export type AiDispatchMode = (typeof AI_DISPATCH_MODES)[number];
export const aiDispatchModeSchema = z.enum(AI_DISPATCH_MODES).catch("native");

/**
 * G3-05: vocabulário canônico de tags de conversa, persistido em
 * organizations.settings.canonical_conversation_tags (spec 13 §3.3 — org-scoped,
 * não pipeline-scoped). Schema declarativo; usado para validar o que o inbox lê
 * como sugestões.
 */
export const canonicalConversationTagsSchema = z
  .array(conversationTagSchema)
  .max(50)
  .transform((tags) => Array.from(new Set(tags)))
  .catch([]);
export type CanonicalConversationTags = z.infer<typeof canonicalConversationTagsSchema>;
export type Locale = (typeof LOCALES)[number];

/**
 * "Sigo minha empresa" — a ausência de preferência, com um valor para ela.
 *
 * Sem isto, quem abrisse o perfil por qualquer motivo (trocar o fuso, o nome)
 * sairia de lá com uma preferência de idioma que nunca escolheu: o seletor
 * mostraria o idioma em vigor e o salvar o gravaria como decisão pessoal. A
 * partir daí, trocar o idioma da empresa não alcançaria mais essa pessoa — e
 * ninguém entenderia por quê.
 */
export const SEM_PREFERENCIA_DE_IDIOMA = "auto";

export const profileSchema = z.object({
  full_name: z.string().min(1).max(120).nullable().optional(),
  locale: z.enum([...LOCALES, SEM_PREFERENCIA_DE_IDIOMA]),
  timezone: z.string().min(1).max(64),
  avatar_url: z
    .string()
    .url()
    .max(2048)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
});
export type ProfileInput = z.infer<typeof profileSchema>;

/**
 * As moedas servidas vêm de `lib/money`, pelo mesmo motivo que os idiomas vêm
 * de `lib/i18n/idiomas`: com duas listas, uma moeda aceita aqui e ausente do
 * seletor vira um valor que ninguém consegue mais escolher de volta.
 */
const MOEDAS = MOEDAS_SERVIDAS;

export const tenantSchema = z.object({
  display_name: z.string().min(1).max(120),
  legal_name: z.string().min(1).max(200),
  cnpj: z
    .string()
    .max(20)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  timezone: z.string().min(1).max(64),
  locale: z.enum(LOCALES),
  currency: z.enum(MOEDAS),
  media_retention_days: z.coerce.number().int().min(30).max(3650),
  /**
   * Interruptor da limpeza automática de mídia antiga (migration 0341; porte de
   * melgarafael/DeskcommCRM #2180). OPT-IN: o banco nasce com `false`, e quem
   * liga é a tela. Quem aplica é a função do banco, pelo cron `media-retention`.
   */
  media_retention_enforced: z.boolean(),
  dpo_email: z
    .string()
    .email()
    .max(200)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  privacy_policy_url: z
    .string()
    .url()
    .max(2048)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  lost_reasons_extra: z.array(z.string().min(1).max(80)).max(50).default([]),
});
export type TenantInput = z.infer<typeof tenantSchema>;

export const NOTIFICATION_CATEGORIES = [
  "lead_assigned",
  "lead_won",
  "lead_lost",
  "mention",
] as const;
export const NOTIFICATION_CHANNELS = ["email", "in_app", "push"] as const;

export const notificationPrefsSchema = z.object({
  prefs: z.array(
    z.object({
      category: z.enum(NOTIFICATION_CATEGORIES),
      channel: z.enum(NOTIFICATION_CHANNELS),
      enabled: z.boolean(),
    }),
  ),
});
export type NotificationPrefsInput = z.infer<typeof notificationPrefsSchema>;

export const customFieldSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/i, "Use letras, números e underscore"),
  label: z.string().min(1).max(80),
  type: z.enum([
    "text",
    "textarea",
    "number",
    "date",
    "select",
    "multiselect",
    "boolean",
    "email",
    "phone",
    "url",
  ]),
  required: z.boolean().optional(),
  options: z
    .array(z.object({ value: z.string().min(1), label: z.string().min(1) }))
    .optional(),
  /**
   * QUANDO este campo aparece (porte do upstream #2793): "mostrar só quando
   * outro campo tem determinado valor". Lida por `lib/schemas/mostrar-quando.ts`
   * no renderizador único (`CustomFieldsEditor`). Esconder NÃO apaga valor.
   * Ausente é o caminho de todo funil instalado hoje.
   */
  mostrar_quando: mostrarQuandoSchema.optional(),
});
export type CustomFieldDef = z.infer<typeof customFieldSchema>;

export const pipelineConfigPatchSchema = z.object({
  vocabulary: z
    .object({
      lead: z.string().min(1).max(40).optional(),
      deal: z.string().min(1).max(40).optional(),
      won: z.string().min(1).max(40).optional(),
      lost: z.string().min(1).max(40).optional(),
    })
    .optional(),
  fields: z.array(customFieldSchema).max(50).optional(),
  lost_reasons: z.array(z.string().min(1).max(80)).max(50).optional(),
});
export type PipelineConfigPatch = z.infer<typeof pipelineConfigPatchSchema>;

/**
 * A marca da INSTALAÇÃO (`platform_branding`) — o que a server action aceita.
 *
 * `.nullable()` em cada campo, e não `.optional()`: aqui `null` é um valor com
 * significado ("apague este campo, quero o padrão do produto"), e ausência
 * significaria "não mexa". Colapsar os dois faria a tela não ter como limpar o
 * logo depois de configurá-lo.
 *
 * `accent_hex` valida com `ehHexValido` — o validador do domínio, o MESMO que
 * `lib/branding/schema.ts` usa — e a action normaliza antes de gravar. Um regex
 * novo escrito aqui divergiria do CHECK do banco (`^#[0-9a-f]{6}$`) e o operador
 * receberia um `23514` cru na tela em vez de "essa cor não é válida".
 */
export const platformBrandingSchema = z.object({
  app_name: z.string().trim().min(1).max(120).nullable(),
  logo_url: z.string().trim().url().max(2048).nullable(),
  accent_hex: z
    .string()
    .trim()
    .refine(ehHexValido, { message: "Use uma cor no formato #rrggbb" })
    .nullable(),
  show_powered_by: z.boolean(),
});
export type PlatformBrandingInput = z.infer<typeof platformBrandingSchema>;

/**
 * A marca da ORGANIZAÇÃO (`organizations.settings.branding`) — o cliente final
 * do revendedor, e o que a Server Action `updateMarcaDaOrganizacao` aceita.
 *
 * `.nullable()` pelo mesmo motivo do schema de cima: aqui `null` é um valor com
 * significado ("apague este campo, quero o que vem da instalação") e ausência
 * significaria "não mexa". Colapsar os dois deixaria o admin sem como voltar
 * atrás depois de escolher uma cor.
 *
 * SEM `logo_url`: upload é a fase seguinte (bucket, policies, limite de tamanho,
 * delete-on-replace). Um campo aqui hoje seria contrato oferecido e não
 * implementado — a precedência por campo garante que o logo da instalação
 * continua valendo enquanto isso.
 *
 * `accent_hex` valida com `ehHexValido` — o MESMO validador do domínio que
 * `lib/branding/schema.ts` usa — e a action normaliza antes de gravar. Um regex
 * novo escrito aqui divergiria da regex da função SQL (`^#[0-9a-f]{6}$`) e o
 * admin receberia um `22023` cru na tela em vez de "essa cor não é válida".
 */
export const marcaDaOrganizacaoSchema = z.object({
  app_name: z.string().trim().min(1).max(120).nullable(),
  accent_hex: z
    .string()
    .trim()
    .refine(ehHexValido, { message: "Use uma cor no formato #rrggbb" })
    .nullable(),
  /**
   * A cor do menu lateral. Mesmo validador do `accent_hex`, e já normalizada
   * aqui (`#FFF` vira `#ffffff`): a função SQL não confere esta chave, então o
   * Zod é a única porta. `default(null)` para uma aba aberta antes da
   * atualização, que ainda não manda o campo, não ser recusada inteira: ela
   * grava o menu em branco, que é o que aquela tela mostrava.
   */
  menu_hex: z
    .string()
    .trim()
    .refine(ehHexValido, { message: "Use uma cor no formato #rrggbb" })
    .transform((v) => normalizarHex(v))
    .nullable()
    .default(null),
});
export type MarcaDaOrganizacaoInput = z.infer<typeof marcaDaOrganizacaoSchema>;

/** Prazos por organização. Leitura legada degrada; escrita usa schema estrito. */
export const agendaSettingsWriteSchema = z.strictObject({
  confirmation_delay_minutes: z.number().int().min(1).max(10080),
  unknown_protection_minutes: z.number().int().min(1).max(10080),
  /**
   * Quanto tempo um pedido não confirmado segura o horário.
   *
   * ⚠️ `.default()` e não obrigatório: este schema é `strictObject`, e torná-lo
   * exigido faria TODO PATCH já escrito (que manda só os dois campos de cima)
   * passar a falhar — o tipo de mudança que a doutrina de packaging proíbe,
   * porque quebra quem já instalou sem nenhum aviso.
   *
   * 24h é o default porque quem confere a fila uma vez por dia não pode perder
   * pedido. O mínimo é 15 minutos: abaixo disso a expiração corre com quem está
   * decidindo naquele instante.
   */
  pending_expires_after_minutes: z.number().int().min(15).max(10080).default(1440),
}).refine(v => v.unknown_protection_minutes >= v.confirmation_delay_minutes, {message:"O prazo de proteção deve ser maior que o prazo de confirmação."});
export const agendaSettingsSchema = agendaSettingsWriteSchema.catch({confirmation_delay_minutes:10,unknown_protection_minutes:1440,pending_expires_after_minutes:1440});

/**
 * `organizations.settings.crm` — regras de CRM que cada organização liga para si.
 *
 * `cliente_pela_agenda`: quem tem horário marcado vira cliente (migration 0262).
 * Nasce DESLIGADA em toda organização, e só um administrador a liga, por
 * `fn_definir_cliente_pela_agenda` (nunca por UPDATE em `organizations`).
 *
 * ⚠️ SÓ O BOOLEANO `true` LIGA — e é a mesma régua do banco, que compara
 * `settings->'crm'->'cliente_pela_agenda' = 'true'::jsonb` em
 * `fn_marcar_contato_como_cliente`. Ausente, `false`, a string `"true"` ou
 * qualquer lixo é desligado aqui E lá. Se os dois idiomas divergissem, a tela
 * mostraria o selo de uma regra que o trigger não aplica.
 *
 * `paciente_pelo_cadastro`: quem tem cadastro de paciente (vínculo com o
 * prontuário ou CPF) entra pelo funil de clientes (migration 0360). Independente
 * da primeira, também nasce DESLIGADA, e só `fn_definir_paciente_pelo_cadastro`
 * a grava. A mesma régua: só o booleano `true` liga.
 *
 * `internal_contact_tags` (#2353 do original): as etiquetas que marcam um contato
 * INTERNO (equipe, sócio, família, fornecedor). Contato com uma delas não vira
 * card e não recebe atendimento automático; ver `lib/contacts/tags-internas.ts`.
 * Ausente/lixo vira lista vazia (nenhum contato é interno), o comportamento de
 * antes desta chave existir.
 */
export const internalContactTagsSchema = z.array(z.string()).catch([]);

export const crmSettingsSchema = z
  .object({
    cliente_pela_agenda: z.boolean().catch(false),
    paciente_pelo_cadastro: z.boolean().catch(false),
    internal_contact_tags: internalContactTagsSchema,
    /**
     * `telefone_de_ficha_vazia` (#2593): o telefone que o cliente diz numa
     * conversa entra SOZINHO na ficha SEM número, sem a fila de proposta da
     * spec 17 §4b. NASCE DESLIGADA: só o booleano `true` liga.
     */
    telefone_de_ficha_vazia: z.boolean().catch(false),
  })
  .catch({
    cliente_pela_agenda: false,
    paciente_pelo_cadastro: false,
    internal_contact_tags: [],
    telefone_de_ficha_vazia: false,
  });

function crmDe(settings: unknown): z.infer<typeof crmSettingsSchema> {
  const crm =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).crm
      : undefined;
  return crmSettingsSchema.parse(crm ?? {});
}

/**
 * As etiquetas de contato INTERNO desta organização, na forma em que o banco
 * guarda as tags (`normalizarTag`: minúscula, aparada, sem repetição). Nunca
 * lança: um jsonb torto devolve lista vazia ("nenhum contato é interno").
 */
export function tagsInternasDaOrg(settings: unknown): string[] {
  return normalizarTags(crmDe(settings).internal_contact_tags);
}

/** A regra "cliente pela agenda" está ligada nesta organização? Nunca lança. */
export function clientePelaAgendaLigado(settings: unknown): boolean {
  return crmDe(settings).cliente_pela_agenda === true;
}

/**
 * O interruptor de #2593 está ligado nesta organização? **Desligado por
 * padrão**, e nunca lança.
 *
 * A régua é "SÓ O BOOLEANO `true` LIGA": ausente, `false`, a string `"true"`,
 * `1`, array ou qualquer lixo é DESLIGADO. É deliberadamente o mais
 * conservador dos dois lados — quem atualizar o produto sem abrir a tela
 * continua com a regra da spec 17 §4b intacta (o dado ouvido é proposto, não
 * gravado), e um `settings` torto nunca liga uma escrita automática por
 * acidente.
 */
export function telefoneDeFichaVaziaLigado(settings: unknown): boolean {
  return crmDe(settings).telefone_de_ficha_vazia === true;
}

/** A regra "paciente pelo cadastro" está ligada nesta organização? Nunca lança. */
export function pacientePeloCadastroLigado(settings: unknown): boolean {
  return crmDe(settings).paciente_pelo_cadastro === true;
}
