/**
 * GET /api/v1/contacts/compare?ids=<uuid>,<uuid> — duas fichas lado a lado
 * (porte do #3640), para o gestor decidir antes de juntar ou dispensar.
 *
 * Só `manager`+ (`requireRole`, com a trava de MFA): é a mesma decisão da
 * fusão, e a comparação põe dados de duas pessoas lado a lado.
 *
 * Tudo é lido pela SESSÃO — a RLS decide o que a pessoa enxerga, e o
 * `organization_id` da sessão entra em todo filtro mesmo assim. Nenhum cliente
 * administrador aqui.
 *
 * A resposta leva só o recorte da comparação: os campos que provam a
 * identidade (nascimento, CPF cadastrado) e o que `fn_mesclar_contatos` NÃO
 * leva da ficha absorvida ou aperta em quem fica (CPF, endereço, vínculo com o
 * prontuário, bloqueio, travas da IA, oculto do Inbox). Nunca `custom_fields`,
 * `source_metadata` nem a cifra do CPF inteiros.
 *
 * O vínculo com o prontuário é lido de forma ESTRITA: erro vira 500, nunca
 * "não ligada" — um "Prontuário: —" falso levaria o gestor a absorver a ficha
 * ligada.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { auditarLeitura } from "@/lib/audit/leitura";
import { ehAberturaDeLeitura } from "@/lib/audit/releitura";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS_DA_FICHA =
  "id, name, display_name, email, phone_number, birthdate, cpf_encrypted, source, custom_fields, is_blocked, force_human, ai_opt_out, inbox_hidden_at, created_at, last_activity_at, is_merged_into, is_anonymized";

/** Exatamente duas fichas, e diferentes sem distinguir caixa. */
const idsDaComparacao = z
  .array(z.string().uuid())
  .length(2)
  // O `refine` roda mesmo quando o `length(2)` já falhou: daí o `?.`.
  .refine((ids) => ids[0]?.toLowerCase() !== ids[1]?.toLowerCase(), {
    message: "As duas fichas precisam ser diferentes.",
  });

interface LinhaDaFicha {
  id: string;
  name: string | null;
  display_name: string | null;
  email: string | null;
  phone_number: string | null;
  birthdate: string | null;
  cpf_encrypted: unknown;
  source: string | null;
  custom_fields: Record<string, unknown> | null;
  is_blocked: boolean | null;
  force_human: boolean | null;
  ai_opt_out: boolean | null;
  inbox_hidden_at: string | null;
  created_at: string;
  last_activity_at: string | null;
  is_merged_into: string | null;
  is_anonymized: boolean;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "contact" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const url = new URL(req.url);
  const pedidos = (url.searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const validos = idsDaComparacao.safeParse(pedidos);
  if (!validos.success) {
    return fail("validation_failed", "Compare exatamente duas fichas diferentes: ?ids=<id>,<id>.", 422, {
      requestId,
    });
  }
  const ids = validos.data.map((id) => id.toLowerCase());

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contacts")
    .select(COLUNAS_DA_FICHA)
    .eq("organization_id", org.orgId)
    .in("id", ids);
  if (error) {
    return fail("internal_error", "Não foi possível ler as fichas.", 500, { requestId });
  }

  // Lápide e anonimizada não se comparam: a primeira já virou outra ficha, a
  // segunda não tem mais dado. Contam como não encontradas.
  const lidas = ((data ?? []) as unknown as LinhaDaFicha[]).filter(
    (c) => c.is_merged_into === null && !c.is_anonymized,
  );
  const porId = new Map(lidas.map((c) => [c.id, c] as const));
  const fichas = ids.map((id) => porId.get(id)).filter((c): c is LinhaDaFicha => c !== undefined);
  if (fichas.length < 2) {
    return fail("not_found", "Uma das fichas não está disponível para comparação.", 404, { requestId });
  }
  const idsLidos = fichas.map((f) => f.id);

  const contar = (tabela: "conversations" | "crm_leads", contatoId: string) =>
    supabase
      .from(tabela)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org.orgId)
      .eq("contact_id", contatoId);
  const [contagens, vinculos] = await Promise.all([
    Promise.all(fichas.map((f) => Promise.all([contar("conversations", f.id), contar("crm_leads", f.id)]))),
    supabase
      .from("prontuario_contact_links")
      .select("contact_id")
      .eq("organization_id", org.orgId)
      .in("contact_id", idsLidos),
  ]);
  if (contagens.some(([conversas, negocios]) => conversas.error || negocios.error)) {
    return fail("internal_error", "Não foi possível contar conversas e negócios.", 500, { requestId });
  }
  if (vinculos.error) {
    return fail("internal_error", "Não foi possível ler o vínculo com o prontuário.", 500, { requestId });
  }
  const ligadas = new Set(((vinculos.data ?? []) as Array<{ contact_id: string }>).map((v) => v.contact_id));

  if (ehAberturaDeLeitura(url)) {
    auditarLeitura({
      action: "contact.viewed",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "contact",
      resourceId: fichas[0]!.id,
      requestId,
      metadata: { recurso: "comparacao", ids: idsLidos },
    });
  }

  return ok(
    {
      contatos: fichas.map((ficha, i) => {
        const endereco = ficha.custom_fields?.["endereco"];
        return {
          id: ficha.id,
          name: ficha.name,
          display_name: ficha.display_name,
          phone_number: ficha.phone_number,
          email: ficha.email,
          birthdate: ficha.birthdate,
          cpf_available: ficha.cpf_encrypted != null,
          endereco: typeof endereco === "string" && endereco.trim() ? endereco : null,
          prontuario_linked: ligadas.has(ficha.id),
          is_blocked: ficha.is_blocked === true,
          force_human: ficha.force_human === true,
          ai_opt_out: ficha.ai_opt_out === true,
          inbox_hidden_at: ficha.inbox_hidden_at,
          source: ficha.source,
          created_at: ficha.created_at,
          last_activity_at: ficha.last_activity_at,
          conversas: contagens[i]![0].count ?? 0,
          negocios: contagens[i]![1].count ?? 0,
        };
      }),
    },
    { requestId },
  );
}
