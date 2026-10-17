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
 *      (nunca logout), conferido depois, até o teto (padrão: 2 por sessão a
 *      cada 6 h), e sempre com aviso na Central e no celular, inclusive quando
 *      voltou e quando desistiu. Nunca por cima de uma pessoa conectando a
 *      sessão nem de uma atualização da instalação em andamento.
 *
 * A regra 3 não contradiz a 1 porque fala de outro estado: o transporte acabou
 * de responder `WORKING`, a credencial está intacta e a plataforma não derrubou
 * ninguém. Reiniciar ali é o que a pessoa faria ao clicar em Reconectar. Uma
 * sessão que o reinício deixe em `FAILED` ou `SCAN_QR_CODE` cai na regra 1, e
 * o teto impede que uma conexão doente vire laço de reinício.
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
  conexaoEmAndamento,
  type ChannelAdapter,
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
  avisoDeSurdezSemEfeito,
  avisoDeVoltaDaSurdez,
  avisoPendenteDoVigia,
  decidirVigiaDeSurdez,
  lerMarcaDoVigia,
  precisaPerguntarSeEntrou,
  reiniciosDaMarca,
  relogioDoVigia,
  tetoDosReinicios,
  type MarcaDoVigia,
  type RelogioDoAviso,
  type TetoDeReinicios,
} from "@/lib/channels/vigia-de-surdez";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { RUN_STALE_AFTER_MS } from "@/lib/system/update-run";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

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

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Grava `metadata.vigia_surdez` sem pisar nas outras chaves (`ai_gate`,
 * `ai_test_phone_numbers`...), e SÓ se ninguém gravou a marca desde que `lida`
 * foi lida: o UPDATE leva a ficha (`versao`) no filtro, e o Postgres reavalia
 * o filtro na linha travada. Duas rodadas simultâneas não reiniciam a mesma
 * sessão duas vezes; a que perde recebe `null` e não faz nada.
 *
 * LANÇA se não conseguir ler ou gravar: a marca é a trava do laço, e reiniciar
 * sem ela é reiniciar de novo na rodada seguinte.
 *
 * ponytail: lê e regrava o jsonb inteiro. A ficha protege a marca; uma edição
 * de OUTRA chave de `metadata` que caia entre as duas chamadas (milissegundos)
 * se perde. Se isso um dia doer, vira `jsonb_set` numa função SQL, que pede
 * migration.
 */
async function gravarMarcaDoVigia(
  admin: Admin,
  s: Pick<LinhaDeSessao, "id" | "organization_id">,
  lida: MarcaDoVigia | null,
  nova: MarcaDoVigia,
): Promise<MarcaDoVigia | null> {
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
  const ficha = typeof lida?.versao === "number" ? lida.versao : null;
  const marca: MarcaDoVigia = { ...nova, versao: (ficha ?? 0) + 1 };
  const caminho = `metadata->${CHAVE_DO_VIGIA}->>versao`;
  const update = admin
    .from("channel_sessions")
    .update({ metadata: { ...atual, [CHAVE_DO_VIGIA]: marca } })
    .eq("id", s.id)
    .eq("organization_id", s.organization_id);
  const { data: linhas, error } = await (ficha === null ? update.is(caminho, null) : update.eq(caminho, String(ficha))).select("id");
  if (error) throw new Error("vigia_surdez_marca_nao_gravada");
  return (linhas ?? []).length > 0 ? marca : null;
}

interface VigiaDaRodada {
  admin: Admin;
  requestId: string;
  teto: TetoDeReinicios;
  desfechos: Record<string, number>;
  /** Fuso e idioma da organização, para a hora que o aviso escreve. Uma leitura por organização na rodada. */
  relogio: (organizationId: string, agora: Date) => Promise<RelogioDoAviso>;
  /** Atualização disparada pela tela em andamento. Uma leitura por rodada. */
  atualizacaoEmAndamento: () => Promise<boolean>;
}

/**
 * Conectada, mas surda: a decisão é de `decidirVigiaDeSurdez`; aqui está a
 * fiação. Cada passo que muda alguma coisa reserva a vez na marca ANTES de
 * agir, e quem perde a reserva não age.
 *
 * ponytail: o aviso é aberto DEPOIS da reserva. Se o insert falhar, aquele
 * aviso não sai (fica no log de erro); o contrário, reservar depois, abriria
 * avisos em dobro com duas rodadas simultâneas.
 */
async function vigiarSurdez(
  v: VigiaDaRodada,
  s: LinhaDeSessao,
  sessao: { status: string | null; sessionRef: string; apelido: string; restart: NonNullable<ChannelAdapter["restart"]> },
): Promise<void> {
  const { admin } = v;
  const conta = (desfecho: string) => {
    v.desfechos[desfecho] = (v.desfechos[desfecho] ?? 0) + 1;
  };
  const agora = new Date();
  const agoraIso = agora.toISOString();
  const entrada = {
    status: sessao.status,
    lastStatusChangeAt: s.last_status_change_at,
    metadata: s.metadata,
    agora,
    teto: v.teto,
  };

  // Duas voltas na mesma regra pura para só pagar a consulta de mensagens
  // quando ela muda a decisão. Na rodada comum (a cada 5 min, sessão saudável
  // ou fora da janela) este bloco não toca no banco.
  let decisao = decidirVigiaDeSurdez({ ...entrada, houveEntrada: false });
  let voltouEm: string | null = null;
  const desde = relogioDoVigia(s.last_status_change_at, s.metadata);
  if (desde && precisaPerguntarSeEntrou(decisao)) {
    // Service role ignora RLS: `organization_id` vai explícito. A coluna
    // `messages.channel_session_id` tem índice próprio.
    const { data: entrou, error: erroDaBusca } = await admin
      .from("messages")
      .select("created_at")
      .eq("organization_id", s.organization_id)
      .eq("channel_session_id", s.id)
      .eq("direction", "inbound")
      .gt("created_at", desde)
      .order("created_at", { ascending: true })
      .limit(1);
    // Não deu para perguntar NÃO é "não entrou nada", nem "voltou": na dúvida, não mexe.
    if (erroDaBusca) return;
    voltouEm = ((entrou ?? [])[0]?.created_at as string | undefined) ?? null;
    decisao = decidirVigiaDeSurdez({ ...entrada, houveEntrada: voltouEm !== null });
  }

  let marca = lerMarcaDoVigia(s.metadata);
  const aviso = async (severity: "warn" | "critical", texto: { title: string; body: string }) => {
    const { error } = await admin.from("agent_inbox_items").insert({
      organization_id: s.organization_id,
      kind: "channel_number_alert",
      severity,
      ...texto,
      ref_kind: REF_KIND_SESSAO,
      ref_id: s.id,
    });
    if (error) logger.error("[channel-health] aviso do vigia de surdez não gravou", { sessionId: s.id, requestId: v.requestId });
    return !error;
  };

  if (decisao.acao === "reiniciar") {
    // Não reinicia por cima de gente: alguém lendo o QR ou reconectando agora,
    // ou uma atualização da instalação no meio. A próxima rodada decide de novo.
    if (await conexaoEmAndamento(admin, s.organization_id, s.id)) return conta("surdez_conexao_em_andamento");
    if (await v.atualizacaoEmAndamento()) return conta("surdez_atualizacao_em_andamento");

    // A marca vai ANTES do reinício: se o processo morrer no meio, a trava já
    // existe. E é ela que decide quem reinicia quando duas rodadas se cruzam.
    const recentes = reiniciosDaMarca(marca)
      .filter((t) => agora.getTime() - t < v.teto.janelaMs)
      .map((t) => new Date(t).toISOString());
    const reservada = await gravarMarcaDoVigia(admin, s, marca, {
      reiniciado_em: agoraIso,
      reinicios: [...recentes, agoraIso],
      queda_em: decisao.quedaEm,
    });
    if (!reservada) return conta("surdez_concorrente");
    marca = reservada;

    let reiniciou = false;
    try {
      await sessao.restart({ organizationId: s.organization_id, sessionRef: sessao.sessionRef });
      reiniciou = true;
      conta("surdez_reiniciada");
    } catch (err) {
      logger.error("[channel-health] reinício da sessão surda falhou", {
        sessionId: s.id,
        detail: err instanceof Error ? err.message : "erro",
        requestId: v.requestId,
      });
      // O aviso da próxima rodada precisa dizer a verdade: tentou e não deu.
      marca = (await gravarMarcaDoVigia(admin, s, marca, { ...marca, falhou: true })) ?? marca;
      conta("surdez_reinicio_falhou");
    }

    // Uma linha por TENTATIVA, com o desfecho. Antes só o sucesso auditava, e
    // a tentativa recusada ficava só no log do contêiner, que some no próximo
    // `up -d`. Sem ator: quem age é o sistema.
    //
    // `status` e `last_status_change_at` NÃO são gravados aqui: os eventos do
    // próprio reinício (STOPPED, STARTING, WORKING) chegam pelo webhook e são a
    // fonte. Gravar "STARTING" por cima de um WORKING que já chegou travaria o
    // envio até a próxima rodada.
    void audit({
      action: "channel.reconnected",
      organizationId: s.organization_id,
      resourceType: "channel_session",
      resourceId: s.id,
      bypassedRls: true,
      requestId: v.requestId,
      metadata: {
        origem: "vigia_de_surdez",
        force: false,
        sem_entrada_desde: decisao.quedaEm,
        tentativa: decisao.tentativa,
        reiniciou,
      },
    });
    logger.info("[channel-health] reinício automático de conexão surda", {
      sessionId: s.id,
      tentativa: decisao.tentativa,
      reiniciou,
      requestId: v.requestId,
    });
  } else if (decisao.acao === "voltou" && voltouEm) {
    // `avisado_em` junto: se o reinício ainda não tinha virado aviso, o da
    // volta já conta a história inteira, e o celular não toca duas vezes.
    const reservada = await gravarMarcaDoVigia(admin, s, marca, {
      ...marca,
      desfecho: "voltou",
      desfecho_em: agoraIso,
      avisado_em: marca?.avisado_em ?? agoraIso,
    });
    if (!reservada) return conta("surdez_concorrente");
    marca = reservada;
    // O que estava aberto sobre esta sessão (o reinício, o "continua") já não
    // vale. Mesma chave de `sincronizarSaudeDaConexao`: só ESTA sessão.
    await admin
      .from("agent_inbox_items")
      .update({ status: "resolved" })
      .eq("organization_id", s.organization_id)
      .eq("ref_kind", REF_KIND_SESSAO)
      .eq("ref_id", s.id)
      .eq("status", "open");
    const reiniciadoEm =
      marca.reiniciado_em && Date.parse(marca.reiniciado_em) >= Date.parse(decisao.quedaEm) ? marca.reiniciado_em : null;
    const relogio = await v.relogio(s.organization_id, agora);
    await aviso(
      "warn",
      avisoDeVoltaDaSurdez({ apelido: sessao.apelido, quedaEm: decisao.quedaEm, reiniciadoEm, voltouEm, relogio }),
    );
    conta("surdez_voltou");
  } else if (decisao.acao === "escalar") {
    const reservada = await gravarMarcaDoVigia(admin, s, marca, {
      ...marca,
      queda_em: decisao.quedaEm,
      desfecho: "escalado",
      desfecho_em: agoraIso,
    });
    if (!reservada) return conta("surdez_concorrente");
    marca = reservada;
    const relogio = await v.relogio(s.organization_id, agora);
    await aviso(
      "critical",
      avisoDeSurdezSemEfeito({
        apelido: sessao.apelido,
        quedaEm: decisao.quedaEm,
        reiniciadoEm: decisao.tentativas > 0 ? (marca.reiniciado_em ?? null) : null,
        tentativas: decisao.tentativas,
        recentes: decisao.recentes,
        teto: v.teto,
        relogio,
      }),
    );
    conta("surdez_escalada");
  }

  // O aviso do reinício da rodada ANTERIOR. Direto na Central, e não por
  // `escalated_status`: aquela coluna guarda um episódio de QUEDA por sessão, e
  // o próprio reinício passa por STOPPED e WORKING, que a sobrescrevem e fecham.
  // Quem garante o "uma vez" aqui é `avisado_em`.
  if (marca?.reiniciado_em && avisoPendenteDoVigia({ [CHAVE_DO_VIGIA]: marca }, agora)) {
    const reservada = await gravarMarcaDoVigia(admin, s, marca, { ...marca, avisado_em: agoraIso });
    if (!reservada) return conta("surdez_concorrente");
    const quedaEm = marca.queda_em ?? marca.reiniciado_em;
    const relogio = await v.relogio(s.organization_id, agora);
    const enviado = await aviso(
      "warn",
      avisoDeSurdez({
        apelido: sessao.apelido,
        falhou: marca.falhou === true,
        reiniciadoEm: marca.reiniciado_em,
        quedaEm,
        tentativa: Math.max(1, reiniciosDaMarca(marca).filter((t) => t >= Date.parse(quedaEm)).length),
        maximo: v.teto.maximo,
        relogio,
      }),
    );
    if (enviado) conta("surdez_avisada");
  }
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

  const orgs = new Map<string, Promise<{ timezone?: string | null; locale?: string | null } | null>>();
  let atualizacao: Promise<boolean> | null = null;
  const vigia: VigiaDaRodada = {
    admin,
    requestId,
    teto: tetoDosReinicios(env.CHANNEL_DEAF_RESTART_MAX, env.CHANNEL_DEAF_RESTART_WINDOW_HOURS),
    desfechos,
    // Falha aberta: sem conseguir ler, o aviso sai no padrão do produto.
    relogio: async (organizationId, agora) => {
      if (!orgs.has(organizationId)) {
        orgs.set(
          organizationId,
          Promise.resolve(admin.from("organizations").select("timezone, locale").eq("id", organizationId).maybeSingle()).then(
            ({ data: org }) => org,
            () => null,
          ),
        );
      }
      const org = await orgs.get(organizationId)!;
      return { fuso: fusoUtilizavel(org?.timezone), idioma: normalizarIdioma(org?.locale), agora };
    },
    // Só a atualização disparada pela tela deixa rastro (`system_update_runs`).
    // As outras (CI, terminal) recriam o transporte e mexem no estado da
    // sessão, e o relógio do vigia já recomeça sozinho a partir dali.
    atualizacaoEmAndamento: () =>
      (atualizacao ??= Promise.resolve(
        admin
          .from("system_update_runs")
          .select("id")
          .eq("status", "dispatched")
          .gt("dispatched_at", new Date(Date.now() - RUN_STALE_AFTER_MS).toISOString())
          .limit(1),
      ).then(
        ({ data: runs, error: erroDoRun }) => Boolean(erroDoRun) || (runs ?? []).length > 0,
        () => true,
      )),
  };

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
        await vigiarSurdez(vigia, s, {
          // Só vale o que o transporte confirmou NESTA rodada e que não mudou
          // agora: se o status acabou de ser corrigido acima, a data lida no
          // início do laço já está velha e o silêncio contaria do lugar errado.
          status: saude.reachable && statusFinal === s.status ? saude.status : null,
          sessionRef,
          apelido,
          restart: adapter.restart.bind(adapter),
        });
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
