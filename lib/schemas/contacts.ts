/**
 * Zod schemas for `/api/v1/contacts/*` endpoints (EPIC-05 waves 1, 2, 8).
 *
 * Contracts:
 *  - contactCreateSchema    → POST /api/v1/contacts
 *  - contactPatchSchema     → PATCH /api/v1/contacts/[id]
 *  - contactListQuerySchema → GET /api/v1/contacts (search/tag/source/cursor)
 *  - lgpdAnonymizeSchema    → POST /api/v1/lgpd/anonymize (irreversible)
 */
import { z } from "zod";

import { DDD_BR } from "@/lib/channels/phone-variants";
import { normalizarTag, normalizarTags } from "@/lib/contacts/tag-normalizada";
import {
  MAXIMO_DE_ETIQUETAS_NO_FILTRO,
  MODOS_DE_ETIQUETA,
} from "@/lib/inbox/marcador-da-conversa";

export const PHONE_REGEX = /^\+\d{8,15}$/;
const CPF_DIGITS = /^\d{11}$/;

/**
 * O TELEFONE COMO O BRASILEIRO ESCREVE (porte do original #3305, issue #3301).
 *
 * Quem cadastra à mão digita `(42) 99873-7374`, `42998737374` ou o fixo
 * `(42) 3333-4444`, e o campo exigia o `+55` do próprio país. A normalização
 * mora no SCHEMA, e não na tela, porque a tela não é a única porta: o POST e o
 * PATCH de `/api/v1/contacts` e a importação por planilha passam por aqui. O que
 * se grava continua sendo o E.164 (`+5542998737374`), o que o resto do produto
 * procura.
 *
 * Este CRM não tem país por organização: o público é brasileiro (a mesma decisão
 * de `normalizaTelefone`, em `lib/contacts/csv.ts`). Por isso a régua nacional
 * vale para todo cadastro, e o número estrangeiro continua possível escrevendo o
 * `+` e o DDI.
 *
 * O DDD é conferido pela régua do produto (`DDD_BR`, a mesma de
 * `phoneLookupVariants`). E o nono dígito NÃO é inventado aqui: local de 8
 * dígitos é fixo, e quem completa o nono do celular antigo é `canonicalPhoneBR`,
 * no handler, como já era.
 */
export const MSG_TELEFONE_INVALIDO =
  "Telefone deve ter DDD + número (ex.: 11999998888) ou o formato E.164 (+5511999998888)";

/** DDD + número (8 ou 9 dígitos, com ou sem máscara) → E.164 com `+55`; `null` fora disso. */
function telefoneNacionalE164(valor: string): string | null {
  const digitos = valor.replace(/\D/g, "");
  // 12 ou 13 dígitos começando com 55: quem colou o número completo e esqueceu o
  // `+`. O DDI sai e o resto passa pela MESMA régua nacional, DDD incluído.
  const nacional =
    (digitos.length === 12 || digitos.length === 13) && digitos.startsWith("55")
      ? digitos.slice(2)
      : digitos;
  if (nacional.length !== 10 && nacional.length !== 11) return null;
  if (!DDD_BR.test(nacional.slice(0, 2))) return null;
  return `+55${nacional}`;
}

/**
 * O que já é E.164 passa intacto; o nacional ganha o `+55`. O resto segue como
 * veio, para o `refine` recusar.
 *
 * Quem escreveu o `+` declarou o DDI: `+1 (415) 555-1234` é dos Estados Unidos,
 * e a régua nacional o leria como DDD 14, o número de outra pessoa. Só a máscara
 * (espaço, parêntese, ponto, traço) sai; letra e ramal ficam, e o `refine` os
 * recusa.
 */
function normalizarTelefoneBR(valor: string): string {
  if (PHONE_REGEX.test(valor)) return valor;
  const limpo = valor.trim();
  if (limpo.startsWith("+")) return `+${limpo.slice(1).replace(/[\s().-]/g, "")}`;
  return telefoneNacionalE164(valor) ?? valor;
}

/**
 * Teto de 32 KB no jsonb inteiro. O CHECK do banco só garante que é OBJETO —
 * sem limite de tamanho, um cliente da API escreveria megabytes numa coluna que
 * a listagem de contatos traz inteira, e o custo apareceria como "a tela de
 * contatos ficou lenta", longe da causa.
 */
const CUSTOM_FIELDS_MAX_BYTES = 32_768;

const customFieldsSchema = z
  .record(z.string().min(1).max(80), z.unknown())
  .refine((value) => JSON.stringify(value).length <= CUSTOM_FIELDS_MAX_BYTES, {
    message: "Campos personalizados excedem o limite de 32 KB",
  });

/**
 * CPF check-digit validator (algoritmo oficial Receita Federal).
 * Rejeita repetidos (00000000000, 11111111111, ...) e dígitos verificadores inválidos.
 */
export function isValidCpf(raw: string): boolean {
  const s = raw.replace(/\D/g, "");
  if (!CPF_DIGITS.test(s) || /^(\d)\1{10}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(s[i]!, 10) * (10 - i);
  let d1 = (sum * 10) % 11;
  if (d1 === 10) d1 = 0;
  if (d1 !== parseInt(s[9]!, 10)) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(s[i]!, 10) * (11 - i);
  let d2 = (sum * 10) % 11;
  if (d2 === 10) d2 = 0;
  return d2 === parseInt(s[10]!, 10);
}

export const contactCreateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  display_name: z.string().min(1).max(200).optional(),
  email: z.string().email().optional(),
  // `.transform()` ANTES do `.refine()`: o `refine` julga o valor já
  // normalizado, então `(11) 99999-8888` e `+5511999998888` passam pela mesma
  // régua E.164.
  phone_number: z
    .string()
    .transform(normalizarTelefoneBR)
    .refine((valor) => PHONE_REGEX.test(valor), { message: MSG_TELEFONE_INVALIDO })
    .optional(),
  cpf: z.string().refine(isValidCpf, "CPF inválido").optional(),
  birthdate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  // O marcador nasce em caixa baixa, pela MESMA regra da tag de conversa: o
  // "VIP" gravado verbatim não casava com o filtro `?tag=vip` (issue #1224).
  tags: z.array(z.string()).transform(normalizarTags).optional(),
  source: z.string().min(1).default("manual"),
  source_metadata: z.record(z.string(), z.unknown()).optional(),
  consent: z.record(z.string(), z.unknown()).optional(),
  custom_fields: customFieldsSchema.optional(),
});
export type ContactCreate = z.infer<typeof contactCreateSchema>;

export const contactPatchSchema = contactCreateSchema.partial().extend({
  source: z.string().min(1).optional(),
});
export type ContactPatch = z.infer<typeof contactPatchSchema>;

export const CONTACT_ORDER_BY = [
  "last_activity_at",
  "created_at",
  "display_name",
  "email",
  "phone_number",
] as const;

export const contactListQuerySchema = z.object({
  search: z.string().optional(),
  // ⚠️ VÁRIAS etiquetas (#1274). Aceita `string` OU `string[]`, e a
  // repetição na URL (`?tag=vip&tag=orçamento`) é lida por `getAll`. Aceitar as
  // DUAS formas é o que mantém o `?tag=vip` singular funcionando: `get` devolve
  // string e `getAll` devolve array de um, e os dois precisam passar pelo MESMO
  // schema — se este só aceitasse array, toda chamada antiga quebraria com 422.
  tag: z
    .union([z.string(), z.array(z.string()).max(MAXIMO_DE_ETIQUETAS_NO_FILTRO)])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      // O filtro normaliza pelo MESMO caminho da escrita: `?tag=VIP` acha o
      // que a ficha gravou como "vip" (porte do original #1263).
      const lista = (Array.isArray(v) ? v : [v]).map(normalizarTag);
      // Lista VAZIA vira `undefined`, e não `[]` — mesma razão do schema do
      // Inbox: `getAll` devolve `[]` sem o parâmetro, e `[]` num `cs` é um filtro
      // que não casa nada, com o filtro desligado.
      return lista.length > 0 ? lista : undefined;
    }),
  /**
   * E ou OU entre as etiquetas escolhidas (#1274). `e` é o padrão — e é o que
   * uma etiqueta só já significava, logo o parâmetro só importa havendo duas.
   *
   * `z.enum` recusa o valor fora dos dois, e a recusa vira 422: `?modo=xou` é
   * quase sempre alguém copiando o nome do parâmetro errado, e a resposta
   * ensina o integrador a corrigir. Na TELA quem lê é `modoDeEtiqueta`, que cai
   * no `e` — uma tela não pode quebrar por um parâmetro inventado.
   */
  modo: z.enum(MODOS_DE_ETIQUETA).optional(),
  source: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  order_by: z.enum(CONTACT_ORDER_BY).default("last_activity_at"),
  order_dir: z.enum(["asc", "desc"]).default("desc"),
});
export type ContactListQuery = z.output<typeof contactListQuerySchema>;
export type ContactListQueryParams = z.input<typeof contactListQuerySchema>;
export type ContactOrderBy = (typeof CONTACT_ORDER_BY)[number];

export const lgpdAnonymizeSchema = z.object({
  contact_id: z.string().uuid(),
  justification: z.string().min(10).max(1000),
});
export type LgpdAnonymizeInput = z.infer<typeof lgpdAnonymizeSchema>;

/**
 * Juntar contatos duplicados.
 *
 * O principal fica FORA do array de secundários e o `refine` é o que garante
 * isso na borda — `fn_mesclar_contatos` recusa o mesmo caso com `22023`, mas um
 * 422 com a lista de campos é o que a tela consegue mostrar. As duas guardas
 * existem porque a rota não é a única porta: a RPC é alcançável por
 * `authenticated` (é assim que a RLS a autoriza), e ela precisa se defender só.
 *
 * O teto de 20 secundários por chamada não é arbitrário: a fusão trava as
 * linhas (`for update`) e reponta toda FK que aponta para elas: um lote grande
 * segura escrita de contato para a organização inteira enquanto roda.
 */
export const contactsMergeSchema = z
  .object({
    primary_contact_id: z.string().uuid(),
    secondary_contact_ids: z.array(z.string().uuid()).min(1).max(20),
  })
  .refine((v) => !v.secondary_contact_ids.includes(v.primary_contact_id), {
    message: "O contato principal não pode estar entre os que serão absorvidos.",
    path: ["secondary_contact_ids"],
  })
  .refine((v) => new Set(v.secondary_contact_ids).size === v.secondary_contact_ids.length, {
    message: "Contato repetido na seleção.",
    path: ["secondary_contact_ids"],
  });
export type ContactsMergeInput = z.infer<typeof contactsMergeSchema>;
