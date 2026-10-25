/**
 * GET /api/v1/bonus/meu?mes=YYYY-MM: o placar de QUEM PEDE e a fila de hoje.
 * Cada participante vê só o seu e os resultados da dupla. A fila é lida já
 * filtrada por `user_id = quem pede`, e a leitura (nome e telefone de paciente)
 * passa por `auditarLeitura`.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { diaLocalISO } from "@/lib/agenda/fuso";
import { janelaDeEnvioAberta, proximaAberturaDaJanela } from "@/lib/agent-engine/pacing/engine";
import { fail, ok } from "@/lib/api/wrappers";
import { auditarLeitura } from "@/lib/audit/leitura";
import { ehAberturaDeLeitura } from "@/lib/audit/releitura";
import { requireRole } from "@/lib/auth/require-role";
import { knobsDoCanal } from "@/lib/automation/janela-do-canal";
import { calcularMes } from "@/lib/bonus/calculo";
import { inicioDoDia, mesDe, somarDias } from "@/lib/bonus/calendario";
import { fatosDoMes, lerPrograma, mensagensDaEquipe } from "@/lib/bonus/fatos";
import { type ItemDaFila, itensEnviados } from "@/lib/bonus/fila";
import type { ItemDaFilaNaTela, RespostaMeuBonus } from "@/lib/bonus/tela";
import type { TipoDeItemDaFila } from "@/lib/bonus/tipos";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const MES_RX = /^\d{4}-(0[1-9]|1[0-2])$/;

interface LinhaDaFila {
  id: string;
  dia: string;
  tipo: TipoDeItemDaFila;
  user_id: string;
  contact_id: string;
  conversation_id: string | null;
  motivo: ItemDaFilaNaTela["motivo"];
  ligacao_registrada_em: string | null;
  ligacao_resultado: ItemDaFilaNaTela["ligacao_resultado"];
  ligacao_resumo: string | null;
  contacts: { display_name: string | null; name: string | null; phone_number: string | null } | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "bonus_fila_itens" });
  if (!authz.ok) return authz.response;
  const t = (s: string) => traduzir(s, authz.user.idioma);
  const admin = createAdminClient();
  const org = authz.org.orgId;

  const lido = await lerPrograma(admin, org);
  if (lido.status === "ausente") return fail("not_found", t("O programa de bônus não está ligado."), 404, { requestId });
  if (lido.status === "erro") return fail("internal_error", t("Erro ao ler o programa."), 500, { requestId });
  const programa = lido.programa;
  if (!programa.regras.participantes.includes(authz.user.id)) {
    return fail("forbidden", t("Você não participa do programa de bônus."), 403, { requestId });
  }

  const url = new URL(req.url);
  const agora = new Date();
  const hoje = diaLocalISO(agora, programa.fuso);
  const pedido = url.searchParams.get("mes");
  const mes = pedido && MES_RX.test(pedido) ? pedido : mesDe(hoje);

  try {
    const entrada = await fatosDoMes(admin, programa, mes, hoje);
    const placar = calcularMes(entrada);
    const pessoa = placar.pessoas.find((p) => p.userId === authz.user.id)!;

    let fila: ItemDaFilaNaTela[] | null = null;
    let janela: RespostaMeuBonus["janela"] = null;
    if (mes === mesDe(hoje)) {
      const { data, error } = await admin
        .from("bonus_fila_itens")
        .select(
          "id, dia, tipo, user_id, contact_id, conversation_id, motivo, ligacao_registrada_em, ligacao_resultado, ligacao_resumo, contacts(display_name, name, phone_number)",
        )
        .eq("organization_id", org)
        .eq("user_id", authz.user.id)
        .eq("dia", hoje)
        .order("id");
      if (error) throw new Error(error.message);
      const linhas = (data ?? []) as unknown as LinhaDaFila[];
      const meus: ItemDaFila[] = linhas.map((l) => ({
        id: l.id,
        dia: l.dia,
        tipo: l.tipo,
        userId: l.user_id,
        contactId: l.contact_id,
        ligacaoRegistradaEm: l.ligacao_registrada_em,
      }));
      const mensagens = await mensagensDaEquipe(
        admin,
        org,
        [authz.user.id],
        meus.map((i) => i.contactId),
        inicioDoDia(hoje, programa.fuso),
        inicioDoDia(somarDias(hoje, 1), programa.fuso),
      );
      const enviados = itensEnviados(meus, mensagens, programa.fuso);
      fila = linhas.map((l) => ({
        id: l.id,
        tipo: l.tipo,
        // O telefone vai em campo próprio; aqui só o nome de gente (regra canônica).
        contato_nome: nomeDoContato(l.contacts) ?? t("Contato sem nome"),
        telefone: l.contacts?.phone_number ?? null,
        conversation_id: l.conversation_id,
        motivo: l.motivo,
        enviada: enviados.has(l.id),
        ligacao_resultado: l.ligacao_resultado,
        ligacao_resumo: l.ligacao_resumo,
      }));
      if (linhas.length > 0 && ehAberturaDeLeitura(url)) {
        auditarLeitura({
          action: "contact.listed",
          actorUserId: authz.user.id,
          organizationId: org,
          resourceType: "contact",
          requestId,
          // Só ids: nome e telefone são do paciente.
          metadata: { ids: linhas.map((l) => l.contact_id) },
        });
      }

      const conversa = fila.find((f) => f.conversation_id)?.conversation_id;
      if (conversa) {
        const { data: cv } = await admin
          .from("conversations")
          .select("channel_session_id")
          .eq("organization_id", org)
          .eq("id", conversa)
          .maybeSingle();
        const sessao = (cv as { channel_session_id?: string } | null)?.channel_session_id;
        if (sessao) {
          const knobs = await knobsDoCanal(admin, org, sessao);
          const aberta = janelaDeEnvioAberta(agora, knobs);
          janela = { aberta, abre_em: aberta ? null : proximaAberturaDaJanela(agora, knobs).toISOString() };
        }
      }
    }

    const corpo: RespostaMeuBonus = {
      mes,
      hoje,
      mes_de_teste: placar.mesDeTeste,
      resultados: placar.resultados,
      resultados_cents: placar.resultadosCents,
      pessoa,
      stories_hoje: { contagem: entrada.storiesPorDia[hoje] ?? 0, meta: programa.regras.rotinas.stories_por_dia },
      fila,
      janela,
    };
    return ok(corpo, { requestId });
  } catch (e) {
    logger.error("[bonus.meu] leitura falhou", { organization_id: org, error: e instanceof Error ? e.message : String(e), requestId });
    return fail("internal_error", t("Erro ao montar o placar."), 500, { requestId });
  }
}
