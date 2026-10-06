/**
 * O LEMBRETE DO COMPROMISSO — o consumidor que faltava.
 *
 * A migration 0177 declarou que `calendar_appointments.contact_id` é "quem
 * recebe o LEMBRETE", `calendar_event_types` ganhou `reminder_enabled` e
 * `reminder_minutes_before`, a tela oferece os dois — e nada nunca leu
 * `reminder_sent_at`. O comentário de `app/api/v1/agenda/agendamentos/_handler.ts`
 * fala desta rota no futuro do pretérito: "no dia em que o worker de lembrete
 * nascer". Este é o dia.
 *
 * Enquanto ele não existia, ligar o lembrete no tipo de agendamento não fazia
 * nada — e não fazia nada EM SILÊNCIO, que é o caro: quem configurou acreditou
 * que o paciente seria avisado. Coluna sem consumidor é o anti-pattern nº 3 do
 * CLAUDE.md deste repo, e este era um deles.
 *
 * ═══ O QUE ESTA ROTA DECIDE, E POR QUÊ ═══
 *
 * **Lembrete é transacional, não marketing.** Quem recusou receber campanha
 * continua recebendo aviso do próprio compromisso. `consent.marketing.declined_at`
 * NÃO barra: esconder de alguém que o pedido dele está pronto não é respeitar a
 * recusa, é perder a entrega. Bloqueio de contato (`is_blocked`) e ausência de
 * telefone barram, porque aí não há para onde mandar.
 *
 * **A janela de envio vale.** Um lembrete que chega às 6h da manhã é o tipo de
 * mensagem que faz o número ser denunciado. Fora da janela do canal a rodada
 * simplesmente não marca `reminder_sent_at`, e a próxima tenta de novo — o
 * adiamento é o silêncio, não uma fila nova.
 *
 * **O carimbo é da TENTATIVA, não da entrega.** `sendMessageHandler` marca
 * `failed`/`queued` na própria mensagem e devolve normalmente; o estado da
 * entrega vive lá. Se este carimbo esperasse a entrega, um contato com número
 * permanentemente inválido receberia uma tentativa a cada 5 minutos até a hora
 * do compromisso.
 *
 * **Compromisso que já começou não gera lembrete.** Avisar às 15h de uma
 * retirada das 14h não é lembrete, é ruído — e o carimbo some com a linha da
 * varredura seguinte de qualquer jeito.
 *
 * **Degrau cuja hora já passou ANTES da marcação nunca sai** (issue #2223).
 * Reunião marcada às 18:30 para as 16h do dia seguinte tem a véspera (1440 min)
 * às 16:00 de HOJE — duas horas e meia antes de existir. `estaNaHora` respondia
 * "sim" e a primeira varredura mandava o lembrete um minuto depois de o agente
 * confirmar a reunião. A hora que passou antes da linha existir não é atraso de
 * cron, é a ocasião que nunca houve: quem marca para daqui a 21h30 não tem
 * "vespera" para avisar. `degrausPendentes` descarta esse degrau contra
 * `created_at`; o atraso LEGÍTIMO de cron continua saindo, porque ali a hora
 * venceu DEPOIS de a linha existir — e é a diferença que os dois casos têm.
 *
 * **REMARCAÇÃO REPOSICIONA A RÉGUA (issue #2230).** `created_at` não muda quando a
 * reunião é movida, e uma reunião criada dias antes remarcada para menos de 24h
 * mantinha a véspera "vencida" desde a marcação ORIGINAL: a varredura de
 * minutos depois da remarcação mandava o aviso, com a hora do degrau tendo
 * passado antes da NOVA data existir. A régua deixa de ser "quando a linha
 * nasceu" e passa a ser "quando ESTA data foi marcada" — `starts_at_marked_at`,
 * gravado pelo gatilho `trg_starts_at_marked_at` (migration 0323, porte da 0536
 * do original) a cada remarcação, com fallback em `created_at` para a linha
 * nunca movida. As duas alternativas que a issue levantou foram medidas e
 * recusadas lá: `updated_at` reescreve com o link do Meet e com cada revisão
 * (mataria degrau ARMADO) e `revision_started_at` vira também com status e
 * conversa (confirmar um compromisso já dentro de 24h mataria a véspera armada).
 *
 * **REMARCAÇÃO PARA MAIS LONGE REARMA O DEGRAU DA DATA NOVA (issue #2243).**
 * `reminder_sent_offsets_minutes` responde "quais degraus já saíram", e a
 * resposta não tem data: a véspera que saiu para a reunião ANTIGA continuava
 * suprimida depois que a reunião era movida para a semana seguinte — a data
 * nova ficava sem lembrete nenhum, em silêncio, e a lista seguia "correta".
 * A limpeza mora AQUI, na leitura, e não na escrita da remarcação: a regra vira
 * exercitável sem banco. A régua é o ÚLTIMO CARIMBO — `reminder_sent_at`,
 * gravado ANTES do envio (#2226) — e não o instante da remarcação: uma ocasião
 * já disparada tem alvo <= carimbo (o carimbo é da mesma rodada do envio, com
 * `agora >= alvo`), logo `alvo > carimbo` só é verdadeiro para ocasião que
 * ainda não saiu, e o alvo de um degrau carimbado só ultrapassa o carimbo
 * quando o horário andou para além do último envio. Rearmar pelo instante da
 * remarcação reenviaria ocasião já disparada; pelo carimbo não consegue. Duas
 * guardas da triagem (#2249) estreitam o rearme: só linha com
 * `starts_at_marked_at` (remarcada depois da 0323), e só quando o alvo novo
 * fica a meio intervalo do degrau ou mais depois do último envio — ver
 * `degrausPendentes`. `reminder_sent_at` NÃO volta a ser filtro de quem recebe
 * (a 0254 proíbe, e o teste do cron prende): ele só dá o instante de
 * comparação para uma lista que guarda "quais" sem "quando".
 *
 * **O carimbo vai ANTES do envio.** O caso medido mandou o lembrete às
 * 18:35:01 e a MESMA mensagem saiu de novo às 18:40:01 — para o mesmo
 * compromisso, o mesmo degrau. O carimbo não chegava à linha por nenhum dos
 * dois caminhos que existiam: exceção no percurso do envio caía no `catch` que
 * só escrevia DEPOIS de enviar, e o `error` do próprio update era ignorado.
 * Carimbar depois transforma qualquer falha dessas em REENVIO, e reenvio em
 * sequência é o que faz o número ser denunciado — "envio em dobro é pior que
 * não-envio", a mesma régua do cron `recover-stuck-messages`. O carimbo segue
 * sendo da TENTATIVA (a entrega vive na mensagem); só a ordem mudou: agora ele
 * GARANTE o direito de enviar antes de o envio acontecer, e se ele não grava a
 * rodada NÃO envia.
 *
 * **E o carimbo é condicional** (divergência deste fork; spec
 * `docs/superpowers/specs/2026-10-06-lembrete-editavel-design.md`, 3.9). No
 * original ele filtra só `id` e `organization_id`. A rodada lê até 200 linhas no
 * começo e espaça cada envio; uma linha cancelada ou remarcada no meio, ou
 * carimbada por uma rodada sobreposta, seria carimbada e enviada assim mesmo.
 * Aqui o UPDATE só pega a linha COMO FOI LIDA (status, `starts_at`, lista e
 * instante do último carimbo) e, sem linha devolvida, a rodada não envia.
 *
 * ⚠️ **O contato é resolvido DENTRO da organização do compromisso.** É a
 * preocupação literal do handler de agendamentos: "esta linha vira a organização
 * A mandando WhatsApp para o cliente da B". Aqui `organization_id` sai sempre da
 * linha do compromisso e filtra a busca do contato, da conversa e do canal —
 * nunca de parâmetro. O `route.test.ts` ao lado prende isso.
 *
 * ⚠️ **ESTA ROTA NASCE DORMENTE, E ISSO É DE PROPÓSITO.** A migration 0194
 * (`lembrete_nasce_desligado`) pôs `calendar_event_types.reminder_enabled` em
 * `default false` e zerou o histórico, justamente porque não havia disparador —
 * e escreveu por extenso que "ligar lembrete por padrão fica com o dono do
 * produto NO DIA em que o disparador nascer". Este é o disparador; a decisão
 * segue sendo dele, e nada aqui a toma por ele.
 *
 * A superfície de configuração, que faltava quando esta rota nasceu, existe:
 * Configurações › Agenda (`app/app/settings/tenant/agenda/_client.tsx`) liga o
 * aviso por tipo, escolhe os degraus e, desde a 0323, o texto. O PATCH de
 * `app/api/v1/agenda/tipos/route.ts` valida. Quem não ligou não recebe nada:
 * o padrão continua desligado.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { ensureConversation } from "@/lib/automation/start-conversation";
import { adiarAteAJanelaAbrir } from "@/lib/automation/janela-do-canal";
import { espacarEnvio } from "@/lib/automation/throttle";
import { providersDeEnvioAutomatico } from "@/lib/channels";
import { env } from "@/lib/env";
import { aplicarMoldeDoLembrete, montarLembrete, variaveisDoMolde } from "@/lib/agenda/texto-do-lembrete";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

export const dynamic = "force-dynamic";

/** Teto de compromissos examinados por rodada — a varredura roda a cada 5 min. */
const LIMITE_DA_VARREDURA = 200;

/** Maior antecedência aceita pela coluna (43200 min = 30 dias). */
const MAIOR_ANTECEDENCIA_MS = 43_200 * 60_000;

interface TipoDoCompromisso {
  name: string;
  reminder_enabled: boolean;
  reminder_minutes_before: number;
  reminder_extra_offsets_minutes: number[] | null;
  reminder_template_name: string | null;
  /** Texto próprio do lembrete (0323). Nulo = a frase padrão. */
  reminder_body: string | null;
  location_details: string | null;
}

interface CompromissoAVencer {
  id: string;
  organization_id: string;
  contact_id: string;
  title: string;
  starts_at: string;
  /**
   * O fuso em que o horário foi decidido (o da jornada, que segue a unidade).
   * `not null default 'America/Sao_Paulo'` no banco, e toda marcação grava
   * `fusoDaRegra` — é nele que a hora e o "hoje/amanhã" do lembrete saem.
   */
  time_zone: string;
  /** O profissional dono, para `{{profissional}}`. */
  owner_user_id: string | null;
  /** A unidade, embutida pela FK composta (mesma organização por construção). */
  calendar_units: { name: string } | Array<{ name: string }> | null;
  /** Quando a reunião foi MARCADA — a régua do degrau vencido na marcação (#2223). */
  created_at: string | null;
  /**
   * Quando o `starts_at` ATUAL foi gravado — `null` = a linha nunca foi
   * remarcada (#2230). Com ela a régua vira "quando ESTA data foi marcada";
   * sem ela, vale `created_at`.
   */
  starts_at_marked_at: string | null;
  location_details: string | null;
  reminder_sent_offsets_minutes: number[] | null;
  /**
   * `reminder_sent_at` — instante do ÚLTIMO carimbo de envio (#2243): a
   * referência contra a qual um degrau já carimbado volta a ser candidato
   * quando a remarcação leva o horário para além do último envio, e a condição
   * do carimbo da rodada (spec 3.9). Não é filtro de quem recebe — a 0254
   * proíbe. `null` = a limpeza fica de fora.
   */
  reminder_sent_at: string | null;
  calendar_event_types: TipoDoCompromisso | TipoDoCompromisso[] | null;
}

/** O join do PostgREST devolve objeto ou array conforme a cardinalidade inferida. */
function tipoDe(linha: CompromissoAVencer): TipoDoCompromisso | null {
  const t = linha.calendar_event_types;
  if (!t) return null;
  return Array.isArray(t) ? (t[0] ?? null) : t;
}

/**
 * O texto do lembrete mora em `lib/agenda/texto-do-lembrete.ts`, puro, porque a
 * prévia da tela de Configurações › Agenda usa a MESMA função. Reexportado aqui
 * para o teste desta rota e a forma do original continuarem valendo.
 */
export { aplicarMoldeDoLembrete, montarLembrete };

/**
 * Por qual número o lembrete sai.
 *
 * Antes era `channel_sessions` WORKING com `.limit(1)` sem ordem nem filtro de
 * provider: numa organização com Instagram e WhatsApp conectados o lembrete
 * caía em qualquer um, e a escolha podia mudar de uma rodada para a outra.
 *
 * Agora: só canal de envio automático (`providersDeEnvioAutomatico()`, que
 * exclui o Instagram sem nomeá-lo); entre eles, o número da conversa mais
 * recente do contato, onde a pessoa já fala; senão, o primeiro da lista, que
 * quem consulta entrega em ordem fixa. Nenhum: `null`, e a rodada pula.
 *
 * A regra repete o filtro de provider de propósito: se a consulta mudar, o
 * Instagram continua sem ganhar. Pura e exportada, como `degrausPendentes`.
 */
export function escolherCanalDoLembrete(
  sessoes: ReadonlyArray<{ id: string; provider: string }>,
  conversas: ReadonlyArray<{ channel_session_id: string | null }>,
): string | null {
  const automaticos = new Set<string>(providersDeEnvioAutomatico());
  const elegiveis = new Set(sessoes.filter((s) => automaticos.has(s.provider)).map((s) => s.id));
  const daConversa = conversas.find((c) => c.channel_session_id && elegiveis.has(c.channel_session_id));
  return daConversa?.channel_session_id ?? [...elegiveis][0] ?? null;
}

/**
 * Está na hora de lembrar?
 *
 * Pura, e exportada, porque é a regra que o teste precisa exercitar sem banco:
 * cedo demais não manda, tarde demais (já começou) também não.
 */
export function estaNaHora(agora: Date, comeca: Date, antecedenciaMin: number): boolean {
  if (comeca.getTime() <= agora.getTime()) return false;
  return comeca.getTime() - antecedenciaMin * 60_000 <= agora.getTime();
}

/**
 * A hora deste degrau já tinha passado quando a reunião foi marcada?
 *
 * Issue #2223: reunião marcada às 18:30 para as 16h do dia seguinte tem o degrau
 * de 1440 min às 16:00 de hoje — INSTANTE ANTERIOR À EXISTÊNCIA DA PRÓPRIA LINHA.
 * `estaNaHora` só olha `agora`, e ele respondia `true` na primeira varredura:
 * o lembrete de véspera saía um minuto depois de o agente confirmar a reunião,
 * e a cada nova tentativa (o carimbo que não saía) saía outra vez.
 *
 * A régua é o instante da MARCAÇÃO DESTA DATA, e não `updated_at`: o link do
 * Meet e cada revisão reescrevem a linha, e usar `updated_at` descartaria
 * degraus ARMADOS quando o link ficasse pronto dentro da última hora antes da
 * reunião — sumindo com o lembrete em silêncio, que é o defeito simétrico ao
 * deste fix. É a mesma razão pela qual a régua não é `revision_started_at`
 * (#2230): ele vira também com `status` e `conversation_id`, e confirmar um
 * compromisso já dentro de 24h reposicionaria a régua para DEPOIS da hora da
 * véspera.
 *
 * Quem ESCOLHE o instante é `degrausPendentes`: `starts_at_marked_at` quando a
 * linha já foi remarcada, `created_at` quando nunca foi (#2230). Esta função
 * continua perguntando só "a hora passou antes de quem marcou marcar?".
 *
 * Sem `marcadoEm` a guarda fica fora do caminho (linha que não sabe quando foi
 * marcada não é punida). `<=`, e não `<`: marcado no MESMO instante da hora do
 * degrau também é descartado — lembrete que sai no segundo em que a reunião é
 * marcada é exatamente o que a issue reporta.
 */
export function vencidoNaMarcacao(
  comeca: Date,
  degrauMin: number,
  marcadoEm: Date | null | undefined,
): boolean {
  if (!marcadoEm) return false;
  return comeca.getTime() - degrauMin * 60_000 <= marcadoEm.getTime();
}

/**
 * Quais degraus de lembrete estão vencidos e ainda não saíram.
 *
 * Um tipo pode pedir mais de um aviso — um dia antes e de novo três horas antes,
 * por exemplo. O degrau principal é `reminder_minutes_before`; os demais vêm de
 * `reminder_extra_offsets_minutes`.
 *
 * ⚠️ **Devolve todos os vencidos, e quem chama manda UMA mensagem só.** Se o
 * cron ficou parado e dois degraus venceram no intervalo, o certo é avisar uma
 * vez e dar os dois por cumpridos: mandar dois textos iguais em sequência é o
 * que faz a pessoa bloquear o número, e o degrau mais antecipado já perdeu a
 * função quando o mais próximo venceu.
 *
 * Pura e exportada pelo mesmo motivo que `estaNaHora`: é a regra que decide se
 * alguém recebe mensagem, e ela precisa ser exercitável sem banco.
 */
export function degrausPendentes(input: {
  agora: Date;
  comeca: Date;
  principal: number;
  extras: number[] | null;
  jaEnviados: number[] | null;
  /**
   * `created_at` da linha — QUANDO A REUNIÃO ORIGINALMENTE FOI MARCADA
   * (issue #2223).
   *
   * `null`/ausente = a linha não diz (registro anterior à coluna, ou dublê de
   * teste): a regra fica DESLIGADA e vale o comportamento antigo. Falha fechada
   * na direção de não perder lembrete legítimo — só o degrau que PROVA ter
   * vencido antes da marcação é descartado.
   */
  criadoEm?: Date | null;
  /**
   * `starts_at_marked_at` da linha — QUANDO ESTA DATA FOI MARCADA na última
   * remarcação (issue #2230).
   *
   * `created_at` não acompanha a remarcação, então uma reunião criada dias
   * antes e movida para menos de 24h mantinha a véspera "vencida" desde a
   * marcação ORIGINAL e saía minutos depois do agente confirmar o novo horário.
   * Com esta coluna a régua vira o instante da remarcação — que, por construção,
   * nunca é ANTERIOR a `criadoEm` (o gatilho só escreve em UPDATE), por isso
   * `??` escolhe a mais recente e não há o que comparar.
   *
   * `null`/ausente = a linha nunca foi remarcada; cai em `criadoEm`, que é o
   * comportamento de antes, sem mudança para dado legado.
   */
  remarcadoEm?: Date | null;
  /**
   * `reminder_sent_at` da linha — o instante do ÚLTIMO CARIMBO DE ENVIO
   * (issue #2243).
   *
   * A lista `jaEnviados` diz QUAIS degraus saíram, mas não QUANDO — e sem o
   * quando não há como distinguir "a véspera da data antiga já saiu" de "a da
   * data nova já saiu" depois que a remarcação move o horário. É o que a
   * #2243 reporta: remarcada para mais longe, a véspera que já tinha saído
   * seguia suprimida e a data nova ficava sem lembrete algum.
   *
   * A comparação é contra o carimbo, e não contra a remarcação: o carimbo é
   * gravado ANTES do envio (#2226), na mesma rodada, com `agora >= alvo` —
   * logo toda ocasião já disparada tem `alvo <= enviadoEm`, e `alvo >
   * enviadoEm` só é verdadeiro para ocasião que ainda não saiu. Rearmar pelo
   * instante da remarcação reenviaria ocasião disparada; pelo carimbo, não.
   *
   * `null`/ausente = a linha não diz quando saiu o último lembrete: a
   * limpeza fica de fora e vale o comportamento antigo (falha fechada na
   * direção de nunca reenviar).
   */
  enviadoEm?: Date | null;
}): number[] {
  const enviados = new Set(input.jaEnviados ?? []);
  // ─── REMARCAÇÃO PARA MAIS LONGE REARMA O DEGRAU DA DATA NOVA (#2243) ──────
  //
  // Um degrau carimbado só volta a ser candidato quando o horário NOVO dele
  // ficou DEPOIS do último carimbo: a remarcação andou para além do último
  // envio, então a ocasião que a lista suprimia é a da data antiga, e a da
  // data nova ainda não saiu. Sem isto a lista é eterna e a data nova nunca
  // ganha lembrete — o defeito da issue.
  //
  // A referência é o carimbo: "o alvo deste degrau já tinha passado quando o
  // último lembrete saiu?" — sim = saiu, mantém suprimido. A guarda 2 abaixo
  // aperta esse "depois" para "meio intervalo do degrau depois".
  // `enviados` é cópia em memória: a lista gravada continua sendo a
  // autoridade do que saiu, e o carimbo da rodada a regrava como sempre.
  //
  // Duas guardas da triagem (#2249):
  //
  // 1. Só rearma linha com `remarcadoEm`. A 0323 (0536 no original) nasceu sem
  //    backfill: linha remarcada antes dela tem `starts_at_marked_at` NULL, a
  //    régua do #2239 cai em `created_at` e não vê a remarcação — rearmar ali
  //    soltaria, na primeira rodada depois do update, uma véspera cuja hora já
  //    tinha passado. E a lista que o backfill da 0254 escreveu (`[principal
  //    ATUAL]`) não é envio do cron, então o carimbo não a data. Sem a
  //    coluna, vale o comportamento de antes: não rearma.
  // 2. Só rearma se o alvo novo ficou a pelo menos METADE DO INTERVALO do
  //    degrau depois do último envio. Empurrar a reunião 30 min depois de a
  //    véspera sair não pode gerar uma segunda véspera 30 min depois da
  //    primeira — mandar dois textos em sequência é o que faz a pessoa
  //    bloquear o número (a regra do cabeçalho desta função). A régua é o
  //    intervalo do próprio degrau: "há pouco" para a véspera é horas, para
  //    o aviso de 1h são minutos. Metade, e não o intervalo cheio: o envio
  //    sai minutos DEPOIS do alvo (o cron roda a cada 5 min), então
  //    "mesmo horário, no dia seguinte" — a remarcação mais comum — deixa o
  //    alvo novo a 24h MENOS esses minutos do último envio, e a régua cheia
  //    o recusaria, devolvendo a data nova ao silêncio da #2243.
  if (input.enviadoEm && input.remarcadoEm) {
    for (const degrau of [...enviados]) {
      const alvo = input.comeca.getTime() - degrau * 60_000;
      if (alvo - input.enviadoEm.getTime() >= (degrau * 60_000) / 2) {
        enviados.delete(degrau);
      }
    }
  }
  const todos = new Set([input.principal, ...(input.extras ?? [])]);
  // A régua de `vencidoNaMarcacao` é UM instante: o da última marcação DESTA
  // data. `remarcadoEm` vem antes de propósito — é ele que sabe do movimento.
  const marcadoEm = input.remarcadoEm ?? input.criadoEm ?? null;
  return [...todos]
    .filter(
      (degrau) =>
        !enviados.has(degrau) &&
        estaNaHora(input.agora, input.comeca, degrau) &&
        !vencidoNaMarcacao(input.comeca, degrau, marcadoEm),
    )
    .sort((a, b) => b - a);
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const fornecido = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const aceitos = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (aceitos.length === 0 || !fornecido || !aceitos.includes(fornecido)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();

  // `!inner` no tipo: só interessa compromisso cujo TIPO pede lembrete. O corte
  // por `starts_at` usa a maior antecedência possível — o corte fino, que depende
  // do `reminder_minutes_before` de cada linha, é `estaNaHora` logo abaixo.
  const { data, error } = await admin
    .from("calendar_appointments")
    .select(
      "id, organization_id, contact_id, title, starts_at, time_zone, owner_user_id, created_at, starts_at_marked_at, location_details, reminder_sent_offsets_minutes, reminder_sent_at, " +
        "calendar_event_types!inner(name, reminder_enabled, reminder_minutes_before, reminder_extra_offsets_minutes, reminder_template_name, reminder_body, location_details), " +
        // A unidade pela FK composta `(organization_id, unit_id)`: só casa
        // unidade da MESMA organização, e poupa uma consulta por linha.
        "calendar_units!calendar_appointments_unit_fk(name)",
    )
    .eq("status", "confirmed")
    .eq("calendar_event_types.reminder_enabled", true)
    .not("contact_id", "is", null)
    // ⚠️ NÃO se filtra por `reminder_sent_at is null` aqui, e a ausência é a
    // feature: com ela, o compromisso que recebeu o aviso de um dia nunca
    // voltaria para receber o de três horas. Quem decide o que falta é
    // `degrausPendentes`, sobre `reminder_sent_offsets_minutes`.
    //
    // O teto da varredura continua sendo o de sempre, e a ordem por `starts_at`
    // crescente é o que o torna seguro: quando ele corta, corta os compromissos
    // mais distantes, que só precisam do degrau mais antecipado e voltam nas
    // próximas rodadas. Os próximos — os únicos com degrau curto vencendo —
    // estão sempre no começo da lista.
    .gt("starts_at", agora.toISOString())
    .lte("starts_at", new Date(agora.getTime() + MAIOR_ANTECEDENCIA_MS).toISOString())
    .order("starts_at", { ascending: true })
    .limit(LIMITE_DA_VARREDURA);

  if (error) {
    logger.error("[agenda-reminder] consulta falhou", { error: error.message, requestId });
    return fail("internal_error", "Falha ao buscar compromissos.", 500, { requestId });
  }

  const linhas = (data ?? []) as unknown as CompromissoAVencer[];
  let enviados = 0;
  let pulados = 0;
  const motivos: Record<string, number> = {};
  const pular = (motivo: string) => {
    pulados += 1;
    motivos[motivo] = (motivos[motivo] ?? 0) + 1;
  };

  for (const linha of linhas) {
    const tipo = tipoDe(linha);
    if (!tipo) {
      pular("sem_tipo");
      continue;
    }
    const pendentes = degrausPendentes({
      agora,
      comeca: new Date(linha.starts_at),
      principal: tipo.reminder_minutes_before,
      extras: tipo.reminder_extra_offsets_minutes,
      jaEnviados: linha.reminder_sent_offsets_minutes,
      criadoEm: linha.created_at ? new Date(linha.created_at) : null,
      // A régua da remarcação (#2230): nulo = nunca remarcada, e aí vale
      // `created_at` — a rota não decide nada, só repassa os dois instantes.
      remarcadoEm: linha.starts_at_marked_at ? new Date(linha.starts_at_marked_at) : null,
      // O instante do último carimbo (#2243): sem ele a limpeza dos degraus
      // da data antiga fica de fora e a remarcação para mais longe não rearma.
      enviadoEm: linha.reminder_sent_at ? new Date(linha.reminder_sent_at) : null,
    });
    if (pendentes.length === 0) {
      pular("ainda_nao");
      continue;
    }

    // ⚠️ organization_id SEMPRE da linha do compromisso — ver o cabeçalho.
    const org = linha.organization_id;

    const { data: contato } = await admin
      .from("contacts")
      .select("id, name, display_name, phone_number, is_blocked")
      .eq("id", linha.contact_id)
      .eq("organization_id", org)
      .maybeSingle();

    if (!contato) {
      pular("contato_fora_da_org");
      continue;
    }
    if (contato.is_blocked) {
      pular("contato_bloqueado");
      continue;
    }
    if (!contato.phone_number) {
      pular("sem_telefone");
      continue;
    }

    // O canal: WhatsApp (envio automático), de preferência o da conversa em
    // que o paciente já fala. Ver `escolherCanalDoLembrete`. Não reutiliza
    // `sessaoProntaParaEnvio`: ela cai para sessão NÃO WORKING, e com o carimbo
    // antes do envio mandar por número desconectado perderia o lembrete em
    // silêncio. Sem canal, pula e tenta na próxima rodada.
    const { data: sessoes } = await admin
      .from("channel_sessions")
      .select("id, provider")
      .eq("organization_id", org)
      .eq("status", "WORKING")
      .in("provider", [...providersDeEnvioAutomatico()])
      .is("archived_at", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    const { data: conversas } = await admin
      .from("conversations")
      .select("channel_session_id")
      .eq("organization_id", org)
      .eq("contact_id", contato.id)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(20);
    const canalId = escolherCanalDoLembrete(sessoes ?? [], conversas ?? []);

    if (!canalId) {
      pular("sem_canal");
      continue;
    }

    const foraDaJanela = await adiarAteAJanelaAbrir(admin, org, canalId);
    if (foraDaJanela) {
      pular("fora_da_janela");
      continue;
    }

    const { data: organizacao } = await admin
      .from("organizations")
      .select("locale")
      .eq("id", org)
      .maybeSingle();

    // O texto próprio do tipo vence; sem ele, o modelo legado
    // (`reminder_template_name`) sai CRU, como sempre saiu; sem os dois, a
    // frase padrão.
    const molde = tipo.reminder_body?.trim() || null;
    // O GoTrue custa uma chamada HTTP por pessoa: só quando o molde usa a
    // variável, e pela MESMA extração da validação (sem diferenciar
    // maiúsculas). O e-mail nunca entra no lugar do nome.
    const profissional =
      molde && linha.owner_user_id && variaveisDoMolde(molde).includes("profissional")
        ? ((await nomesDosAtendentes([linha.owner_user_id])).get(linha.owner_user_id) ?? null)
        : null;
    const unidade = Array.isArray(linha.calendar_units) ? linha.calendar_units[0] : linha.calendar_units;

    let corpo = montarLembrete({
      nomeDoContato: nomeDoContato(contato),
      titulo: linha.title,
      quando: new Date(linha.starts_at),
      timezone: linha.time_zone,
      local: linha.location_details ?? tipo.location_details ?? null,
      idioma: normalizarIdioma(organizacao?.locale),
      molde,
      tipoNome: tipo.name,
      unidade: unidade?.name ?? null,
      profissional,
      agora,
    });

    if (!molde && tipo.reminder_template_name) {
      const { data: modelo } = await admin
        .from("message_templates")
        .select("body")
        .eq("organization_id", org)
        .or(`shortcut.eq.${tipo.reminder_template_name},title.eq.${tipo.reminder_template_name}`)
        .limit(1)
        .maybeSingle();
      if (modelo?.body) corpo = modelo.body;
    }

    // ─── O CARIMBO ANTES DO ENVIO (issue #2223) ────────────────────────────
    //
    // Carimba TODOS os degraus vencidos, não só o que motivou este texto: os
    // outros já venceram, e deixá-los pendentes faria a próxima rodada mandar a
    // mesma mensagem de novo.
    //
    // E carimba ANTES de enviar. Com o carimbo depois do envio, qualquer
    // exceção do caminho — `espacarEnvio`, `ensureConversation`,
    // `sendMessageHandler` — caía no `catch` abaixo SEM escrever o carimbo, e a
    // mensagem já saída voltava na varredura seguinte: é o mecanismo que a
    // issue #2223 mediu (18:35:01 e de novo 18:40:01, idênticas) e o motivo de
    // o carimbo ser a garantia ANTES, não o balanço DEPOIS. Agora o envio
    // falhado NÃO reenvia — perder um lembrete é melhor que repetir um em
    // sequência ("envio em dobro é pior que não-envio", a mesma régua do
    // `recover-stuck-messages`). O carimbo segue sendo da TENTATIVA, não da
    // entrega: o desfecho da entrega vive na mensagem.
    //
    // Se o carimbo não grava, a rodada NÃO envia. O erro era ignorado antes, e
    // um update recusado em silêncio é a outra forma de o mesmo degrau sair
    // toda varredura.
    //
    // E só carimba a linha COMO FOI LIDA (spec 3.9): status, horário, lista e
    // instante do último carimbo. `.eq` no instante só quando ele existe — o
    // `.is` nulo é o filtro que o teste do cron proíbe; sem carimbo anterior
    // não há rearme, e a lista, que sempre cresce, basta.
    const lidos = linha.reminder_sent_offsets_minutes ?? [];
    let carimbo = admin
      .from("calendar_appointments")
      .update({
        reminder_sent_at: new Date().toISOString(),
        reminder_sent_offsets_minutes: [...new Set([...lidos, ...pendentes])],
      })
      .eq("id", linha.id)
      .eq("organization_id", org)
      .eq("status", "confirmed")
      .eq("starts_at", linha.starts_at)
      .filter("reminder_sent_offsets_minutes", "eq", `{${lidos.join(",")}}`);
    if (linha.reminder_sent_at) carimbo = carimbo.eq("reminder_sent_at", linha.reminder_sent_at);
    const { data: carimbada, error: erroCarimbo } = await carimbo.select("id");
    if (erroCarimbo) {
      logger.error("[agenda-reminder] carimbo falhou", {
        appointmentId: linha.id,
        error: erroCarimbo.message,
        requestId,
      });
      pular("carimbo_falhou");
      continue;
    }
    if (!carimbada || carimbada.length === 0) {
      // Sem envio não há audit (rodada sem efeito não audita), então o log é
      // o único rastro se o UPDATE condicional passar a não casar NUNCA.
      logger.warn("[agenda-reminder] mudou_na_rodada: a linha mudou entre a leitura e o carimbo", {
        appointmentId: linha.id,
        requestId,
      });
      pular("mudou_na_rodada");
      continue;
    }

    try {
      await espacarEnvio(canalId);
      const conversaId = await ensureConversation(admin, org, contato.id, canalId);
      // `webhook_source` é o ator que esta base dá a envio nascido de worker —
      // o mesmo que `lib/followup/enviar-texto-fixo.ts` usa. O `id` é o
      // compromisso, para o audit da mensagem correlacionar com a linha que a
      // originou.
      await sendMessageHandler(
        admin,
        {
          organization_id: org,
          actor: { type: "webhook_source", id: linha.id },
          requestId: `agenda-reminder:${linha.id}`,
        },
        { conversation_id: conversaId, type: "text", body: corpo } as Parameters<
          typeof sendMessageHandler
        >[2],
      );
      enviados += 1;
    } catch (err) {
      const mensagem = err instanceof Error ? err.message : String(err);
      logger.error("[agenda-reminder] envio falhou", { appointmentId: linha.id, error: mensagem, requestId });
      pular("erro_no_envio");
    }
  }

  // Rodada que não avisou ninguém NÃO é mutação, e não audita — a lei está no
  // CLAUDE.md §Audit log, e `tests/unit/cron-audita-so-quando-ha-efeito.test.ts`
  // varre o AST de toda rota deste diretório atrás de `audit` incondicional.
  if (enviados > 0) {
    await audit({
      action: "agenda.lembrete_enviado",
      resourceType: "calendar_appointment",
      requestId,
      metadata: { enviados, pulados, motivos },
    });
  }

  return ok({ examinados: linhas.length, enviados, pulados, motivos }, { requestId });
}

export const GET = handle;
export const POST = handle;
