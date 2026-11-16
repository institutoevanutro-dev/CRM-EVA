/**
 * O CRON DAS MENSAGENS AGENDADAS — encaminha ao envio as que venceram.
 *
 * Roda por minuto. Para cada agendamento com `scheduled_at` no passado:
 *   1. CLAIM: marca `claimed_until` com UPDATE condicional. Só quem marcar a linha
 *      processa; duas rodadas simultâneas não encaminham o mesmo envio.
 *   2. quem agendou perdeu o acesso → `cancelada` (`sem_acesso`).
 *   3. mais de 12h de atraso → `cancelada` (`expirada`).
 *   4. número fora do ar + `esperar` → adia 5 min (`adiada_ate`, fora do lote).
 *   5. número fora do ar + `cancelar` → `cancelada` (`numero_desconectado`).
 *   6. ATRASADA (mais de 10 min): fora da janela do número → adia até ela abrir;
 *      outro envio agendado do número há menos de 1 min → adia (ritmo).
 *   7. senão → encaminha; `encaminhada` com o `message_id`, ou `falhou`.
 * Regras em `lib/agendamento-mensagem/decisao.ts`.
 *
 * Primeira parte da #3118: envio único. Não há próxima ocorrência.
 * Auditoria só quando o agendamento teve desfecho gravado (regra do cron).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { ehOperante, statusDaOrgEmbutida } from "@/lib/campanhas/organizacao";
import { createAdminClient } from "@/lib/supabase/admin";
import { adiarAteAJanelaAbrir } from "@/lib/automation/janela-do-canal";
import { decidirAgendamento, FOLGA_DO_HORARIO_MS } from "@/lib/agendamento-mensagem/decisao";
import {
  autorAindaTemAcesso,
  encaminharAgendamento,
  sessaoEstaConectada,
  type AgendamentoParaEnvio,
} from "@/lib/agendamento-mensagem/envio";

export const dynamic = "force-dynamic";

const LOTE = 50;
const COLUNAS = "id, organization_id, contact_id, channel_session_id, created_by_user_id, body, scheduled_at, se_desconectado";
const TRAVA_S = 300;

interface LinhaDevida extends AgendamentoParaEnvio {
  scheduled_at: string;
  se_desconectado: "esperar" | "cancelar";
}

type Final =
  | { status: "encaminhada"; message_id: string }
  | { status: "falhou" | "cancelada"; motivo: string };

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });

  const admin = createAdminClient();
  const agora = new Date();
  const { data: candidatas, error } = await admin
    .from("mensagens_agendadas")
    .select("id, organization_id, organizations:organization_id!inner(status)")
    .eq("status", "agendada")
    .lte("scheduled_at", agora.toISOString())
    // O que esta rodada vai PULAR não pode ocupar o lote: org parada fica fora
    // pelo join, e o adiado (número fora com "esperar", fora da janela, ritmo)
    // fica fora até `adiada_ate`. Sem isto, 50 linhas presas num número
    // desconectado travavam as de todos os outros números para sempre.
    .eq("organizations.status", "active")
    .or(`adiada_ate.is.null,adiada_ate.lte.${agora.toISOString()}`)
    .order("scheduled_at", { ascending: true })
    .limit(LOTE);
  if (error) return fail("internal_error", "Erro ao ler as mensagens devidas.", 500, { requestId });

  const resumo = { processadas: 0, encaminhadas: 0, falhas: 0, canceladas: 0, esperando: 0 };

  const soltar = (id: string) => admin.from("mensagens_agendadas").update({ claimed_until: null }).eq("id", id);
  const adiar = (id: string, ate: Date) =>
    admin.from("mensagens_agendadas").update({ claimed_until: null, adiada_ate: ate.toISOString() }).eq("id", id);

  for (const candidata of candidatas ?? []) {
    // Org parada (suspensa, redigida, arquivada) não envia: o agendamento espera.
    if (!ehOperante(statusDaOrgEmbutida(candidata.organizations))) continue;
    const trava = new Date(agora.getTime() + TRAVA_S * 1000).toISOString();
    const { data: reservada } = await admin
      .from("mensagens_agendadas")
      .update({ claimed_until: trava })
      .eq("id", candidata.id)
      .eq("status", "agendada")
      .or(`claimed_until.is.null,claimed_until.lt.${agora.toISOString()}`)
      .select(COLUNAS);
    // As colunas vêm do CLAIM, não da leitura da fila: uma edição feita entre as
    // duas não pode sair com o texto antigo.
    const ag = (reservada?.[0] ?? null) as LinhaDevida | null;
    if (!ag) continue;
    resumo.processadas++;

    let final: Final;
    const decisao = (await autorAindaTemAcesso(admin, ag)) ? await decidir(admin, ag, agora) : null;
    if (!decisao) {
      final = { status: "cancelada", motivo: "sem_acesso" };
    } else if (decisao.acao === "adiar") {
      await adiar(ag.id, decisao.ate);
      resumo.esperando++;
      continue;
    } else if (decisao.acao === "cancelar") {
      final = { status: "cancelada", motivo: decisao.motivo };
    } else {
      const desfecho = await encaminharAgendamento(admin, ag);
      // Org parada no meio do envio: não grava desfecho. O agendamento fica como
      // estava e a rota volta a ele quando a org for operante de novo.
      if (desfecho.desfecho === "org_parada") {
        await soltar(ag.id);
        continue;
      }
      final =
        desfecho.desfecho === "encaminhada"
          ? { status: "encaminhada", message_id: desfecho.message_id }
          : { status: "falhou", motivo: desfecho.motivo };
    }

    const { error: upErr } = await admin
      .from("mensagens_agendadas")
      .update({
        status: final.status,
        message_id: final.status === "encaminhada" ? final.message_id : null,
        motivo: final.status === "encaminhada" ? null : final.motivo,
        claimed_until: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", ag.id)
      .eq("organization_id", ag.organization_id)
      .eq("status", "agendada");
    // Auditoria só quando o desfecho foi gravado (regra do cron: sem efeito, sem linha).
    if (!upErr) {
      if (final.status === "encaminhada") resumo.encaminhadas++;
      else if (final.status === "falhou") resumo.falhas++;
      else resumo.canceladas++;

      void audit({
        action:
          final.status === "encaminhada"
            ? "scheduled_message.dispatched"
            : final.status === "falhou"
              ? "scheduled_message.failed"
              : "scheduled_message.cancelled",
        organizationId: ag.organization_id,
        actorUserId: null,
        resourceType: "mensagens_agendadas",
        resourceId: ag.id,
        requestId,
        metadata: { previsto_para: ag.scheduled_at, status: final.status, ...(final.status === "encaminhada" ? {} : { motivo: final.motivo }) },
      });
    }
  }

  return ok(resumo, { requestId });
}

/**
 * Junta os fatos e decide (`lib/agendamento-mensagem/decisao.ts`). A janela do
 * número e o último envio só são lidos para o envio ATRASADO: no horário, a
 * mensagem sai como o atendente marcou.
 */
async function decidir(admin: ReturnType<typeof createAdminClient>, ag: LinhaDevida, agora: Date) {
  const scheduledAt = new Date(ag.scheduled_at);
  const conectado = await sessaoEstaConectada(admin, ag.organization_id, ag.channel_session_id);
  const atrasada = agora.getTime() - scheduledAt.getTime() > FOLGA_DO_HORARIO_MS;
  let janelaAbreEm: Date | null = null;
  let ultimoEnvioDoNumero: Date | null = null;
  if (conectado && atrasada) {
    const abre = await adiarAteAJanelaAbrir(admin, ag.organization_id, ag.channel_session_id, agora);
    janelaAbreEm = abre ? new Date(abre) : null;
    const { data } = await admin
      .from("mensagens_agendadas")
      .select("updated_at")
      .eq("organization_id", ag.organization_id)
      .eq("channel_session_id", ag.channel_session_id)
      .eq("status", "encaminhada")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const ultimo = (data as { updated_at?: string } | null)?.updated_at;
    ultimoEnvioDoNumero = ultimo ? new Date(ultimo) : null;
  }
  return decidirAgendamento({
    agora,
    scheduledAt,
    seDesconectado: ag.se_desconectado,
    conectado,
    janelaAbreEm,
    ultimoEnvioDoNumero,
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
