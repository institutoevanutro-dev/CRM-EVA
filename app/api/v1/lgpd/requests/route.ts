/**
 * GET /api/v1/lgpd/requests
 *
 * Lista paginada de lgpd_requests para o tenant ativo.
 * Apenas role >= admin pode acessar (lgpd:execute permission).
 * organization_id sempre resolvido de sessão confiável — nunca do body.
 *
 * POST /api/v1/lgpd/requests
 *
 * A equipe registra o pedido que o titular fez por WhatsApp, e-mail, telefone ou
 * no balcão. Mesmo papel (admin), mesma origem da organização (a sessão).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { hojeNoBrasil, instanteDoRecebimento, registrarPedidoSchema } from "@/lib/lgpd/pedido-manual";
import { createLgpdRequest } from "@/lib/lgpd/repository";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { LGPD_ESTADOS_ABERTOS, LGPD_REQUEST_STATUSES } from "@/lib/lgpd/types";
import { computeSlaBucket } from "@/lib/lgpd/balde-de-sla";
import { rotuloDoPrazo } from "@/lib/lgpd/sla";
import { rotuloDoTitular, type ContatoDoTitular } from "@/lib/lgpd/titular";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  status: z.enum(LGPD_REQUEST_STATUSES).optional(),
  type: z
    .enum(["redact", "data_request", "store_redact"])
    .optional(),
  sla_bucket: z.enum(["overdue", "critical", "warning", "ok"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * O BALDE DE SLA da linha é `computeSlaBucket`, de `lib/lgpd/balde-de-sla.ts` —
 * função pura, testada em `tests/unit/lgpd-prazo-e-dia-civil.test.ts`. O motivo
 * de a régua não estar neste arquivo está no cabeçalho de lá.
 */

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("admin", {
    requestId,
    resource: "lgpd_requests",
    allowPlatformAdmin: "leitura",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const supabase = await createClient();

  // Parse + validate query params
  const rawParams: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => {
    rawParams[k] = v;
  });
  const parsed = querySchema.safeParse(rawParams);
  if (!parsed.success) {
    return fail("validation_failed", t("Parâmetros inválidos."), 422, {
      details: parsed.error.flatten(),
      requestId,
    });
  }
  const { status, type, page, limit } = parsed.data;

  const orgId = activeOrg.orgId;
  const offset = (page - 1) * limit;
  const fuso = fusoUtilizavel(activeOrg.timezone);
  const agora = new Date();
  const daPaginaNoBanco = () =>
    supabase
      .from("lgpd_requests")
      .select(
        "id, organization_id, request_type, source, contact_id, external_customer_id, status, attempts, received_at, due_at, completed_at, emergency, scope, error_message, request_payload",
      )
      .eq("organization_id", orgId);
  type LinhaDaPagina = NonNullable<Awaited<ReturnType<typeof daPaginaNoBanco>>["data"]>[number];

  // O balde só existe para pedido ABERTO: o concluído parou o relógio. Era daqui
  // que saía o "Vencido" vermelho num pedido entregue.
  const ehAberto = (s: string) => (LGPD_ESTADOS_ABERTOS as readonly string[]).includes(s);
  const baldeDe = (r: { status: string; due_at: string | null; received_at: string }) =>
    ehAberto(r.status) ? computeSlaBucket(r.due_at, r.received_at, agora, fuso) : null;

  // Os pedidos abertos da organização inteira, só com as colunas do balde. Deles
  // saem o aviso do topo (que olhava só a página aberta) e o filtro de prazo
  // (que era aplicado DEPOIS de paginar: 2 linhas e "25 solicitações").
  // ponytail: o balde é aritmética de dia civil em TypeScript (`computeSlaBucket`),
  // então o recorte é em memória sobre os ABERTOS. O teto é o max-rows do
  // PostgREST (1000 abertos); passar disso pede o balde numa função SQL.
  const { data: abertosBrutos, error: erroDosAbertos } = await supabase
    .from("lgpd_requests")
    .select("id, request_type, status, received_at, due_at")
    .eq("organization_id", orgId)
    .in("status", [...LGPD_ESTADOS_ABERTOS])
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("received_at", { ascending: false });
  if (erroDosAbertos) {
    return fail("internal_error", erroDosAbertos.message, 500, { requestId });
  }
  const abertos = (abertosBrutos ?? []).map((r) => ({ ...r, sla_bucket: baldeDe(r) }));
  const alertas = {
    criticos: abertos.filter((r) => r.sla_bucket === "overdue" || r.sla_bucket === "critical").length,
    em_alerta: abertos.filter((r) => r.sla_bucket === "warning").length,
  };

  let total: number;
  let rows: LinhaDaPagina[];
  if (parsed.data.sla_bucket) {
    const ids = abertos
      .filter(
        (r) =>
          r.sla_bucket === parsed.data.sla_bucket &&
          (!status || r.status === status) &&
          (!type || r.request_type === type),
      )
      .map((r) => r.id);
    total = ids.length;
    const daPagina = ids.slice(offset, offset + limit);
    if (daPagina.length === 0) {
      rows = [];
    } else {
      const { data, error: dbErr } = await daPaginaNoBanco().in("id", daPagina);
      if (dbErr) return fail("internal_error", dbErr.message, 500, { requestId });
      const posicao = new Map(daPagina.map((id, i) => [id, i]));
      rows = [...(data ?? [])].sort((a, b) => posicao.get(a.id)! - posicao.get(b.id)!);
    }
  } else {
    let countQuery = supabase
      .from("lgpd_requests")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    if (status) countQuery = countQuery.eq("status", status);
    if (type) countQuery = countQuery.eq("request_type", type);
    const { count } = await countQuery;
    total = count ?? 0;

    let dataQuery = daPaginaNoBanco()
      .order("due_at", { ascending: true, nullsFirst: false })
      .order("received_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (status) dataQuery = dataQuery.eq("status", status);
    if (type) dataQuery = dataQuery.eq("request_type", type);

    const { data, error: dbErr } = await dataQuery;
    if (dbErr) return fail("internal_error", dbErr.message, 500, { requestId });
    rows = data ?? [];
  }

  // Balde por linha. A régua mora em `lib/lgpd/balde-de-sla.ts` porque é
  // aritmética de DIA CIVIL (`due_at` guarda um dia, não um instante) e
  // aritmética testada precisa ficar onde o teste alcança. A versão que estava
  // neste arquivo comparava milissegundos e marcava "Vencido" 26h antes do prazo.
  //
  // O titular: UMA consulta para a página inteira (nada de uma por linha), com
  // o filtro de organização escrito aqui mesmo, além da RLS. Um `contact_id`
  // de outra organização numa linha torta não traz nome nenhum.
  const idsDeContato = [...new Set(rows.map((r) => r.contact_id).filter((id): id is string => !!id))];
  const contatos = new Map<string, ContatoDoTitular>();
  if (idsDeContato.length > 0) {
    const { data: achados, error: erroDosContatos } = await supabase
      .from("contacts")
      .select("id, name, display_name, phone_number, is_anonymized, contact_channel_identities (channel, handle, display_name)")
      .eq("organization_id", orgId)
      .in("id", idsDeContato);
    if (erroDosContatos) {
      return fail("internal_error", erroDosContatos.message, 500, { requestId });
    }
    for (const c of (achados ?? []) as ContatoDoTitular[]) contatos.set(c.id, c);
  }

  // O `request_payload` só serve ao rótulo: tem dado pessoal e não sai daqui.
  const enriched = rows.map(({ request_payload, ...r }) => ({
    ...r,
    titular: rotuloDoTitular(
      { ...r, request_payload },
      r.contact_id ? contatos.get(r.contact_id) : null,
      t,
    ),
    prazo: rotuloDoPrazo(r.due_at, agora, fuso, t),
    sla_bucket: baldeDe(r),
  }));

  return ok(enriched, {
    requestId,
    meta: {
      total,
      page,
      limit,
      has_more: offset + limit < total,
      alertas,
    },
  });
}

/** Tag do endpoint no recibo de idempotência. */
const ENDPOINT = "/api/v1/lgpd/requests";

/**
 * Registra o pedido. O que esta rota faz e, de propósito, NÃO faz:
 *
 * - grava o pedido `received` com `source = 'manual'`, e o prazo contado do dia
 *   em que o titular PEDIU (`received_on`), não de quando se digitou;
 * - NÃO emite evento. Quem põe o worker para andar é a aprovação
 *   (`[id]/approve`), e só ela. Desde a migration 0357 isso não é mais a única
 *   proteção: o worker de anonimização e a cascata do banco recusam o pedido
 *   cuja linha não prova a aprovação, venha o evento de onde vier. As duas
 *   propriedades ficam: aqui não se emite (preso em `route.test.ts`), e lá não
 *   se anonimiza sem prova (`tests/unit/lgpd-redact-so-com-aprovacao.test.ts`).
 *
 * Duplicata: recusa (409) quando o MESMO contato já tem pedido do MESMO tipo
 * ainda aberto (`LGPD_ESTADOS_ABERTOS`), e devolve o id dele para a tela ligar.
 *
 * ponytail: a checagem de duplicata é leitura seguida de gravação, sem trava.
 * Dois cliques com chaves diferentes no mesmo instante passariam os dois; fechar
 * isso é índice único parcial (migration). O botão manda Idempotency-Key e fica
 * desabilitado enquanto envia, que cobre o caso real.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", {
    requestId,
    resource: "lgpd_requests",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const orgId = org.orgId;

  const parsed = registrarPedidoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { contact_id, request_type, channel, received_on } = parsed.data;
  const note = parsed.data.note || null;
  const deliveryEmail = parsed.data.delivery_email || null;

  if (received_on > hojeNoBrasil()) {
    return fail("validation_failed", t("A data em que o pedido chegou não pode estar no futuro."), 422, {
      requestId,
    });
  }

  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }

  // Service role ignora RLS: todo filtro de organização abaixo é manual, e a
  // organização vem da sessão.
  const admin = createAdminClient();

  /** Recusa de regra de negócio: sai como resposta, sem virar recibo de idempotência. */
  class Recusa extends Error {
    constructor(public readonly resposta: Response) {
      super("recusa");
    }
  }

  async function registrar() {
    const { data: contato, error: erroDoContato } = await admin
      .from("contacts")
      .select("id, is_anonymized")
      .eq("organization_id", orgId)
      .eq("id", contact_id)
      .maybeSingle();
    if (erroDoContato) throw new Error(`contato: ${erroDoContato.code}`);
    if (!contato) throw new Recusa(fail("not_found", t("Contato não encontrado."), 404, { requestId }));
    if (contato.is_anonymized) {
      throw new Recusa(
        fail("validation_failed", t("Este contato já foi anonimizado. Não há mais dados dele para um pedido novo."), 422, {
          requestId,
        }),
      );
    }

    const { data: aberto, error: erroDoAberto } = await admin
      .from("lgpd_requests")
      .select("id")
      .eq("organization_id", orgId)
      .eq("contact_id", contact_id)
      .eq("request_type", request_type)
      .in("status", [...LGPD_ESTADOS_ABERTOS])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (erroDoAberto) throw new Error(`duplicata: ${erroDoAberto.code}`);
    if (aberto) {
      throw new Recusa(
        fail("state_conflict", t("Este contato já tem um pedido igual em aberto."), 409, {
          requestId,
          details: { existing_request_id: aberto.id },
        }),
      );
    }

    const delivery = deliveryEmail ? { method: "email" as const, address: deliveryEmail } : null;
    const criado = await createLgpdRequest({
      organizationId: orgId,
      requestType: request_type,
      source: "manual",
      contactId: contact_id,
      receivedAt: instanteDoRecebimento(received_on),
      fuso: org.timezone,
      // Dado pessoal (e-mail, observação) fica aqui, nunca na auditoria.
      payload: { channel, note, delivery, registered_by: user.id },
    });

    await audit({
      action: request_type === "data_request" ? "lgpd.data_request_received" : "lgpd.redact_received",
      actorUserId: user.id,
      organizationId: orgId,
      resourceType: "lgpd_request",
      resourceId: criado.id,
      requestId,
      metadata: {
        source: "manual",
        channel,
        contact_id,
        delivery_method: delivery?.method ?? null,
        received_on,
        due_at: criado.due_at,
      },
    });

    return { id: criado.id, status: "received" as const, due_at: criado.due_at };
  }

  try {
    if (chave === null) return ok(await registrar(), { requestId, status: 201 });

    const desfecho = await comIdempotencia({
      db: await createClient(),
      organizationId: orgId,
      endpoint: ENDPOINT,
      chave,
      corpo: parsed.data,
      executar: async () => ({ resposta: await registrar(), status: 201 }),
    });
    if (desfecho.tipo === "conflito") {
      return fail("idempotency_conflict", t("Esta chave de idempotência já foi usada com outro conteúdo."), 409, {
        requestId,
      });
    }
    return ok(desfecho.resposta, { requestId, status: 201 });
  } catch (err) {
    if (err instanceof Recusa) return err.resposta;
    // Só o começo da mensagem: o detalhe do Postgres traz a linha recusada, e a linha traz o e-mail do titular.
    logger.error("[lgpd-registrar] não foi possível registrar o pedido", {
      organization_id: orgId,
      erro: err instanceof Error ? err.message.slice(0, 80) : "desconhecido",
    });
    return fail("internal_error", t("Não foi possível registrar o pedido. Tente de novo."), 500, { requestId });
  }
}
