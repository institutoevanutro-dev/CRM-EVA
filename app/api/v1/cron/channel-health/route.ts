/**
 * channel-health — o vigia que PERGUNTA se a conexão está de pé.
 *
 * ─── Por que perguntar, se o webhook já conta ──────────────────────────────
 *
 * Porque o webhook emudece exatamente quando mais falta. Ele avisa em segundos
 * enquanto o transporte está vivo; quando o transporte morre, o container cai ou
 * a assinatura do webhook se perde, não chega evento nenhum — e "nenhum evento"
 * é indistinguível de "tudo bem". A coluna segue dizendo `WORKING` para sempre.
 *
 * Foi assim que uma desconexão real passou horas despercebida numa instalação de
 * verdade: nada quebrou, nada alertou, e o dono só descobriu ao estranhar que
 * ninguém escrevia e ir olhar por conta própria.
 *
 * Este cron fecha esse buraco pelo único jeito que existe: fazendo a pergunta.
 * Silêncio deixa de ser resposta.
 *
 * ─── O que ele NÃO faz ─────────────────────────────────────────────────────
 *
 * Não reinicia sessão CAÍDA. Religar sozinho uma conexão que caiu por bloqueio
 * da plataforma é a receita para transformar uma suspensão temporária em
 * definitiva — e reconectar exige, com frequência, um humano com o celular na
 * mão. Sobre `FAILED` e `SCAN_QR_CODE` o vigia informa; a decisão é de quem lê.
 *
 * ─── Quem religa o quê: três regras, três estados ──────────────────────────
 *
 *   1. `FAILED` / `SCAN_QR_CODE` — sessão derrubada pela plataforma ou
 *      deslogada. NADA religa sozinho. É o parágrafo acima, e ele vale inteiro.
 *   2. `STOPPED` — sessão que o transporte não iniciou (contêiner reiniciado,
 *      com a credencial intacta no volume). Quem retoma é o watchdog do worker,
 *      `lib/agent-engine/edge/crm/session-reconciler.ts`, e APENAS esse estado.
 *   3. `WORKING` e surda — a sessão caiu, voltou sozinha, diz que está de pé e
 *      não entrega o que chega (medido em 10/10/2026). Quem reinicia é ESTE
 *      cron, pela regra de `lib/channels/vigia-de-surdez.ts`: reinício suave
 *      (stop + start, nunca logout), no máximo UMA vez por queda, e sempre com
 *      aviso na Central.
 *
 * A regra 3 não contradiz a 1 porque fala de outro estado: o transporte acabou
 * de responder `WORKING`, a credencial está intacta e a plataforma não derrubou
 * ninguém. Reiniciar ali é o que a pessoa faria ao clicar em Reconectar. Uma
 * sessão que o reinício deixe em `FAILED` ou `SCAN_QR_CODE` cai na regra 1, e
 * a trava de uma vez por queda impede a segunda tentativa.
 *
 * Se alguém for afrouxar qualquer um desses filtros, é o item correspondente
 * desta lista que precisa cair primeiro — e a razão do item 1 continua de pé.
 *
 * Auth: Bearer INTERNAL_CRON_SECRET|INTERNAL_SECRET (fail-closed), como os demais.
 *
 * NOTA DE DEPLOY: o agendamento vive no serviço `scheduler` do
 * `docker-compose.prod.yml` — não há `vercel.json` neste repo (self-host).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  canalConhecidoSemMensagem,
  type ChannelProvider,
  type ChannelSessionRef,
} from "@/lib/channels";
import { audit } from "@/lib/audit";
import {
  REF_KIND_SESSAO,
  STATUS_REASON_DESCONECTADO_NO_APP,
  sincronizarSaudeDaConexao,
} from "@/lib/channels/health";
import {
  CHAVE_DO_VIGIA,
  avisoDeSurdez,
  avisoPendenteDoVigia,
  decidirVigiaDeSurdez,
  lerMarcaDoVigia,
  type MarcaDoVigia,
} from "@/lib/channels/vigia-de-surdez";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Teto por rodada. Cada sessão é uma chamada de rede ao transporte. */
const LIMITE = 50;

type LinhaDeSessao = ChannelSessionRef & {
  id: string;
  organization_id: string;
  status: string | null;
  status_reason: string | null;
  display_name: string | null;
  phone_number: string | null;
  archived_at: string | null;
  last_status_change_at: string | null;
  metadata: unknown;
};

/**
 * Grava `metadata.vigia_surdez` sem pisar nas outras chaves (`ai_gate`,
 * `ai_test_phone_numbers`...). LANÇA se não conseguir ler ou gravar: a marca é
 * a trava do laço, e reiniciar sem ela é reiniciar de novo na rodada seguinte.
 *
 * ponytail: lê e regrava o jsonb inteiro. Uma edição de `metadata` que caia
 * entre as duas chamadas (milissegundos) se perde. Se isso um dia doer, vira
 * `jsonb_set` numa função SQL, que pede migration.
 */
async function gravarMarcaDoVigia(
  admin: ReturnType<typeof createAdminClient>,
  s: Pick<LinhaDeSessao, "id" | "organization_id">,
  marca: MarcaDoVigia,
): Promise<void> {
  const { data, error: erroDeLeitura } = await admin
    .from("channel_sessions")
    .select("metadata")
    .eq("id", s.id)
    .eq("organization_id", s.organization_id)
    .maybeSingle();
  if (erroDeLeitura || !data) throw new Error("vigia_surdez_metadata_ilegivel");
  const atual =
    data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
      ? (data.metadata as Record<string, unknown>)
      : {};
  const { error } = await admin
    .from("channel_sessions")
    .update({ metadata: { ...atual, [CHAVE_DO_VIGIA]: marca } })
    .eq("id", s.id)
    .eq("organization_id", s.organization_id);
  if (error) throw new Error("vigia_surdez_marca_nao_gravada");
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();

  // Arquivada não é vigiada: ela foi desligada de propósito, e avisar que uma
  // conexão aposentada está parada é exatamente o ruído que faz o operador
  // ignorar a Central.
  const { data, error } = await admin
    .from("channel_sessions")
    .select(
      `id, organization_id, status, display_name, phone_number, archived_at, status_reason, last_status_change_at, metadata, ${CHANNEL_SESSION_REF_COLUMNS}`,
    )
    .is("archived_at", null)
    .limit(LIMITE);

  if (error) {
    logger.error("[channel-health] query falhou", { detail: error.message, requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }

  const sessoes = (data ?? []) as LinhaDeSessao[];
  let verificadas = 0;
  const desfechos: Record<string, number> = {};
  let ignoradas = 0;

  for (const s of sessoes) {
    // Canal CONHECIDO que não transporta mensagem não tem saúde de mensagem a
    // vigiar — e a linha de chamada de voz (spec 18) é uma dessas. Este
    // `continue` vem ANTES de `getAdapter` de propósito: é decisão de escopo,
    // não erro, e um `warn` por sessão de voz a cada minuto seria ruído
    // perpétuo. É `canalConhecidoSemMensagem` e não `!transportaMensagem`
    // justamente para que um provider DESCONHECIDO não caia aqui em silêncio:
    // ele segue para o `getAdapter` abaixo, que lança, e o `catch` da iteração
    // deixa o rastro.
    if (canalConhecidoSemMensagem(s.provider)) {
      ignoradas++;
      continue;
    }

    try {
      // Pergunta ao CANAL, não ao provider: quem tem sessão para consultar
      // implementa `checkHealth`; quem não tem simplesmente não o expõe, e o
      // vigia segue adiante sem nunca perguntar QUEM ele é — o invariante 1 da
      // doutrina.
      //
      // DENTRO do try, e a diferença é a rodada inteira: `getAdapter` falha
      // FECHADO (`unknown_channel_provider`), e o `catch` desta iteração fica
      // logo abaixo. Enquanto a chamada morava fora, um provider que o banco já
      // aceita e esta imagem ainda não conhece — o clone que aplicou o baseline
      // antes de puxar a imagem nova — abortava `handle()` no meio do laço:
      // TODOS os tenants seguintes daquela rodada ficavam sem vigia, e o
      // operador via 500 no cron sem nenhuma pista de qual linha o derrubou.
      const adapter = getAdapter((s.provider ?? DEFAULT_CHANNEL_PROVIDER) as ChannelProvider);
      const sessionRef = resolveSessionRef(s);
      if (!adapter.checkHealth || !sessionRef) continue;

      const saude = await adapter.checkHealth({
        organizationId: s.organization_id,
        sessionRef,
      });
      verificadas++;

      // O status novo vale para o banco, mas SÓ quando deu para perguntar:
      // gravar por cima com um erro de rede transitório trocaria informação boa
      // por ruído, e é o mesmo cuidado que a tela de conexões já toma.
      // Desconexão feita pelo celular (coexistência) é um estado que a sonda
      // não enxerga: a Graph pode seguir respondendo 200 ao número. Só o
      // `account_reconnected` da própria Meta tira a sessão daqui.
      const presaPeloCelular = s.status === "FAILED" && s.status_reason === STATUS_REASON_DESCONECTADO_NO_APP;
      // Nem o aviso é da sonda: ela poderia fechar o da desconexão (alcançável)
      // ou empilhar outro por cima (inalcançável). Só o empurrão mexe nele.
      if (presaPeloCelular) continue;
      let statusFinal = s.status;
      if (saude.reachable && saude.status && saude.status !== s.status) {
        statusFinal = saude.status;
        const agora = new Date().toISOString();
        await admin
          .from("channel_sessions")
          .update({ status: saude.status, last_status_change_at: agora })
          .eq("id", s.id)
          .eq("organization_id", s.organization_id);
      }

      const apelido = s.display_name ?? s.phone_number ?? "sem nome";
      const desfecho = await sincronizarSaudeDaConexao(
        admin,
        { id: s.id, organization_id: s.organization_id, status: statusFinal, provider: s.provider },
        saude,
        apelido,
      );
      desfechos[desfecho] = (desfechos[desfecho] ?? 0) + 1;

      // ─── Conectada, mas surda ─────────────────────────────────────────────
      //
      // Mesma pergunta de cima, feita ao CANAL: quem sabe se reiniciar sem
      // deslogar expõe `restart`; quem não sabe fica de fora sem ninguém
      // perguntar qual provider ele é.
      if (adapter.restart) {
        const agora = new Date();
        const marca = lerMarcaDoVigia(s.metadata);

        if (marca && avisoPendenteDoVigia(s.metadata, agora)) {
          // O aviso do reinício da rodada ANTERIOR. Direto na Central, e não por
          // `escalated_status`: aquela coluna guarda um episódio de QUEDA por
          // sessão, e o próprio reinício passa por STOPPED e WORKING, que a
          // sobrescrevem e fecham. Quem garante o "uma vez" aqui é `avisado_em`.
          const { error: erroDoAviso } = await admin.from("agent_inbox_items").insert({
            organization_id: s.organization_id,
            kind: "channel_number_alert",
            severity: "warn",
            ...avisoDeSurdez(apelido, marca.falhou === true),
            ref_kind: REF_KIND_SESSAO,
            ref_id: s.id,
          });
          if (!erroDoAviso) {
            await gravarMarcaDoVigia(admin, s, { ...marca, avisado_em: agora.toISOString() });
            desfechos.surdez_avisada = (desfechos.surdez_avisada ?? 0) + 1;
          }
        }

        // Só vale o que o transporte confirmou NESTA rodada e que não mudou
        // agora: se o status acabou de ser corrigido acima, a data lida no
        // início do laço já está velha e o silêncio contaria do lugar errado.
        const mudouEm = s.last_status_change_at;
        const entrada = {
          status: saude.reachable && statusFinal === s.status ? saude.status : null,
          lastStatusChangeAt: mudouEm,
          metadata: s.metadata,
          agora,
        };
        // Duas voltas na mesma regra pura para só pagar a consulta de mensagens
        // quando TODO o resto já aponta surdez. Na rodada comum (a cada 5 min,
        // sessão saudável ou fora da janela) este bloco não toca no banco.
        if (mudouEm && decidirVigiaDeSurdez({ ...entrada, houveEntradaDesdeAMudanca: false }).acao === "reiniciar") {
          // Service role ignora RLS: `organization_id` vai explícito. A coluna
          // `messages.channel_session_id` tem índice próprio.
          const { data: entrou, error: erroDaBusca } = await admin
            .from("messages")
            .select("id")
            .eq("organization_id", s.organization_id)
            .eq("channel_session_id", s.id)
            .eq("direction", "inbound")
            .gt("created_at", mudouEm)
            .limit(1);
          // Não deu para perguntar NÃO é "não entrou nada": na dúvida, não reinicia.
          const houveEntradaDesdeAMudanca = Boolean(erroDaBusca) || (entrou ?? []).length > 0;

          if (decidirVigiaDeSurdez({ ...entrada, houveEntradaDesdeAMudanca }).acao === "reiniciar") {
            // A marca vai ANTES do reinício: se o processo morrer no meio, a
            // trava já existe. Cada queda rende no máximo uma tentativa.
            const reiniciado_em = agora.toISOString();
            await gravarMarcaDoVigia(admin, s, { reiniciado_em });

            let reiniciou = false;
            try {
              await adapter.restart({ organizationId: s.organization_id, sessionRef });
              reiniciou = true;
            } catch (err) {
              logger.error("[channel-health] reinício da sessão surda falhou", {
                sessionId: s.id,
                detail: err instanceof Error ? err.message : "erro",
                requestId,
              });
              // O aviso da próxima rodada precisa dizer a verdade: tentou e não deu.
              await gravarMarcaDoVigia(admin, s, { reiniciado_em, falhou: true });
              desfechos.surdez_reinicio_falhou = (desfechos.surdez_reinicio_falhou ?? 0) + 1;
            }

            // `status` e `last_status_change_at` NÃO são gravados aqui: os
            // eventos do próprio reinício (STOPPED, STARTING, WORKING) chegam
            // pelo webhook e são a fonte. Gravar "STARTING" por cima de um
            // WORKING que já chegou travaria o envio até a próxima rodada.
            if (reiniciou) {
              desfechos.surdez_reiniciada = (desfechos.surdez_reiniciada ?? 0) + 1;
              void audit({
                action: "channel.reconnected",
                organizationId: s.organization_id,
                resourceType: "channel_session",
                resourceId: s.id,
                bypassedRls: true,
                requestId,
                metadata: { origem: "vigia_de_surdez", force: false, sem_entrada_desde: mudouEm },
              });
            }
          }
        }
      }
    } catch (err) {
      // Uma sessão problemática não derruba o lote — as outras ainda precisam
      // ser vigiadas, e é justamente numa rodada assim que alguma pode ter caído.
      logger.warn("[channel-health] falhou numa sessão", {
        sessionId: s.id,
        detail: err instanceof Error ? err.message : "erro",
        requestId,
      });
    }
  }

  return ok({ sessoes: sessoes.length, verificadas, ignoradas, ...desfechos }, { requestId });
}

export const GET = handle;
export const POST = handle;
