import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PUT /api/v1/message-templates/[id]/ordem — a REORDENAÇÃO da resposta rápida
 * (porte do original #3261, migration 0394): põe a resposta `id` logo DEPOIS
 * do vizinho que a tela manda.
 *
 * O corpo carrega o VIZINHO, não o número: `{ depois_de: <id> | null }`, com
 * `null` = primeira posição. Quem arrasta sabe em que resposta soltou, não qual
 * fração de `ordem` isso vira; a conta é de `lib/templates/ordem.ts`.
 *
 * A POSSE é a lista VISÍVEL: a RLS `message_templates_select` mais o
 * `.eq("organization_id")` da organização ativa (a mesma régua da rota de
 * mídias). Um `depois_de` de outra organização, ou o pessoal de um colega, não
 * está nela, e a rota recusa antes de calcular posição contra vizinhas que quem
 * pediu não enxerga.
 *
 * Só a linha arrastada é escrita, e NUNCA o `updated_at`: reordenar não é
 * editar, e a listagem desempata por ele. Título, corpo, atalho e imagens não
 * são tocados. O RBAC é o das rotas vizinhas: `agent` com suporte de escrita, e
 * a RLS `message_templates_write` decide se a linha é dele (pessoal) ou exige
 * manager+ (compartilhada).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { moverTemplateSchema } from "@/lib/schemas/templates";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { ordemDaRenumeracao, posicaoEntre } from "@/lib/templates/ordem";

export const dynamic = "force-dynamic";
const COLS =
  "id, organization_id, owner_user_id, title, body, shortcut, media_item_ids, created_by_user_id, created_at, updated_at, ordem";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Uma linha da lista, no mínimo que a conta da posição e a régua da RLS precisam. */
interface Linha {
  id: string;
  ordem: number;
  owner_user_id: string | null;
}

export async function PUT(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "message_templates" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id } = await params;

  const parsed = moverTemplateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { depois_de } = parsed.data;

  const supabase = await createClient();
  // A lista VISÍVEL da organização ativa, na ordem da tela (mesmos desempates
  // da listagem): a rota precisa enxergar os empates do jeito que a tela
  // enxerga, senão calcula a posição entre um par que na tela não é par.
  const { data: lista, error: erroLista } = await supabase
    .from("message_templates")
    .select("id, ordem, owner_user_id")
    .eq("organization_id", org.orgId)
    .order("ordem", { ascending: true })
    .order("updated_at", { ascending: false })
    .order("id", { ascending: true });
  if (erroLista) {
    logger.error("[message-templates/ordem] falha ao listar", { detalhe: erroLista.message, requestId });
    return fail("internal_error", "Erro ao reordenar a resposta rápida.", 500, { requestId });
  }
  // `Number`: a conta da média não pode virar concatenação de texto.
  const atual: Linha[] = (lista ?? []).map((l: Linha) => ({ ...l, ordem: Number(l.ordem) }));

  if (!atual.some((linha) => linha.id === id)) {
    return fail("not_found", t("Template não encontrado."), 404, { requestId });
  }
  // Vizinha de si mesma não é posição: sem isto, o índice sairia -1 + 1 = topo.
  if (depois_de === id) return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  if (depois_de !== null && !atual.some((linha) => linha.id === depois_de)) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: { depois_de: [t("Vizinho que não pertence a esta organização.")] },
    });
  }

  // As vizinhas são contadas SEM a linha arrastada: se ela se contasse, soltar
  // sobre si não mudaria nada e o índice sairia deslocado em um.
  const semAlvo = atual.filter((linha) => linha.id !== id);
  const indice = depois_de === null ? 0 : semAlvo.findIndex((linha) => linha.id === depois_de) + 1;
  const anterior = indice === 0 ? null : semAlvo[indice - 1]!.ordem;
  const proxima = semAlvo[indice]?.ordem ?? null;
  const nova = posicaoEntre(anterior, proxima);

  // Caminho normal: a média cabe entre as vizinhas. Grava UMA linha.
  if (nova !== null) {
    const { data, error } = await supabase
      .from("message_templates")
      .update({ ordem: nova })
      .eq("id", id)
      .eq("organization_id", org.orgId)
      .select("id")
      .maybeSingle();
    if (error) {
      logger.error("[message-templates/ordem] falha ao gravar a ordem", { detalhe: error.message, requestId });
      return fail("internal_error", "Erro ao reordenar a resposta rápida.", 500, { requestId });
    }
    // Sem linha de volta, a RLS recusou a escrita (um `agent` movendo resposta
    // COMPARTILHADA): nada mudou, então nada é auditado nem respondido como movido.
    if (!data) {
      return fail("forbidden", t("Você não pode reordenar esta resposta rápida."), 403, { requestId });
    }
    return finalizar(false, nova);
  }

  /**
   * Sem posição representável (empate entre as vizinhas, ou precisão esgotada):
   * a lista visível inteira é renumerada, na ordem pedida. Isso escreve as
   * OUTRAS linhas também, então a régua da RLS (`message_templates_write`: a
   * própria com `agent`, a compartilhada com manager+) é conferida na lista
   * inteira ANTES do primeiro UPDATE. Conferir no meio do laço deixaria parte
   * da lista renumerada e responderia 409.
   */
  const gravavel = (linha: Linha) =>
    linha.owner_user_id === user.id || (linha.owner_user_id === null && roleAtLeast(org.role, "manager"));
  if (!atual.every(gravavel)) {
    return fail("state_conflict", t("Não foi possível reordenar a lista inteira. Recarregue a página."), 409, {
      requestId,
    });
  }
  const ids = semAlvo.map((linha) => linha.id);
  ids.splice(indice, 0, id);
  for (let i = 0; i < ids.length; i++) {
    const { data, error } = await supabase
      .from("message_templates")
      .update({ ordem: ordemDaRenumeracao(i) })
      .eq("id", ids[i]!)
      .eq("organization_id", org.orgId)
      .select("id")
      .maybeSingle();
    if (error) {
      logger.error("[message-templates/ordem] falha ao renumerar", { detalhe: error.message, requestId });
      return fail("internal_error", "Erro ao reordenar a resposta rápida.", 500, { requestId });
    }
    // Defesa em profundidade: a régua acima já recusou o que a RLS recusaria;
    // chegar aqui é corrida (a linha mudou de dono ou sumiu entre as consultas).
    if (!data) {
      return fail("state_conflict", t("Não foi possível reordenar a lista inteira. Recarregue a página."), 409, {
        requestId,
      });
    }
  }
  return finalizar(true, ordemDaRenumeracao(indice));

  /** Registra o efeito e devolve a linha inteira relida, no formato da listagem. */
  async function finalizar(renumerada: boolean, ordem: number): Promise<Response> {
    void audit({
      action: "template.reordered",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "message_template",
      resourceId: id,
      requestId,
      metadata: { depois_de, ordem, renumerada },
    });
    const { data, error } = await supabase
      .from("message_templates")
      .select(COLS)
      .eq("id", id)
      .eq("organization_id", org.orgId)
      .maybeSingle();
    if (error || !data) return fail("not_found", t("Template não encontrado."), 404, { requestId });
    return ok(data, { requestId });
  }
}
