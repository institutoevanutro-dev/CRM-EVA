"use client";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth, usePermission } from "@/hooks/auth/AuthProvider";
import { useBulkConversations, type AcaoEmLote } from "@/hooks/inbox/useBulkConversations";
import { useSelecaoEmLote } from "@/hooks/inbox/useSelecaoEmLote";
import { estadoDaJanela, formatarDecorrido } from "@/lib/channels/janela";
import { canalRespondePeloCrm, capabilitiesOf } from "@/lib/channels/capabilities";
import type { ChannelProvider } from "@/lib/channels/types";
import { JanelaFechadaAviso } from "@/components/inbox/JanelaFechadaAviso";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useCloseConversation } from "@/hooks/inbox/useCloseConversation";
import { useMarkAsRead } from "@/hooks/inbox/useMarkAsRead";
import {
  useConversationsRealtime,
  type ConversationsFilters,
  type ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";
import { useConversation, isNotFound } from "@/hooks/inbox/useConversation";
import { ConversationList } from "./ConversationList";
import { BarraDeAcoesEmLote } from "./BarraDeAcoesEmLote";
import { InboxFilters, type InboxFiltersValue, type InboxTab } from "./InboxFilters";
import { ChatThread } from "./ChatThread";
import { Composer, type ComposerHandle } from "./Composer";
import { ConversationHeader } from "./ConversationHeader";
import { BotaoIniciarConversa } from "./PainelIniciarConversa";
import { RetentionNotice } from "./RetentionNotice";
import { CRMSidePanel } from "./CRMSidePanel";
import type { Message as ConversationMensagem } from "@/lib/types/messaging";
import { InboxKeyboardShortcuts } from "./InboxKeyboardShortcuts";
import { ComentariosPainel } from "./comentarios/ComentariosPainel";

import { ShortcutsHelpDialog } from "./ShortcutsHelpDialog";
import { EncaminharDialog } from "./EncaminharDialog";
import { useEncaminharMensagem } from "@/hooks/inbox/useEncaminharMensagem";
import { OpenConversationProvider } from "@/hooks/notifications/OpenConversationContext";
// ADR-05: ícone de feature sai do mapa canônico, nunca do pacote direto.
import { CaretLeft, ChatCircle, IdentificationCard, MagnifyingGlass, X } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { comandosDaFila } from "@/lib/inbox/comando-da-conversa";
import { togglePainelDoContato } from "@/app/actions/inbox/togglePainelDoContato";
import { buscaValeConsulta } from "@/lib/inbox/termo-de-busca";
import { useAutomaticoAtivo } from "@/hooks/ai/useAutomaticoAtivo";
import { useAlturaVisivel } from "@/lib/ui/altura-visivel";
import { APARENCIA_PADRAO } from "@/lib/inbox/aparencia-da-conversa";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  LIMITES_FICHA,
  LIMITES_LISTA,
  faixaDaLargura,
  gravarLarguras,
  largurasPadrao,
  lerLarguras,
  moverPorSeta,
  resolverLarguras,
  type Faixa,
  type LargurasDoInbox,
} from "@/lib/inbox/larguras-do-inbox";

/**
 * QUAL COLUNA APARECE NO CELULAR — as duas saem da MESMA pergunta.
 *
 * Abaixo do `md` só cabe uma coluna por vez, então a lista e a conversa se
 * alternam. O defeito que esta função existe para tornar impossível é as duas
 * decidirem por dados DIFERENTES: a lista somia com `selectedId` (o id) e a
 * conversa aparecia com `selectedConversation` (o objeto já carregado). Entre
 * uma coisa e a outra existe uma janela em que nenhuma das duas aparece — e
 * essa janela tem dois casos reais no telefone:
 *
 *   1. o deep-link `/inbox/<id>`, enquanto a busca única ainda responde;
 *   2. a conversa fora do acesso, que é estado PERMANENTE — e cuja mensagem
 *      ("Conversa não encontrada") ficava escondida junto, deixando o dono
 *      numa tela branca sem nem o botão de voltar.
 *
 * Com uma pergunta só, "as duas escondidas" deixa de ser representável.
 * `md:flex` em ambas: no desktop as duas colunas convivem e a regra não vale.
 *
 * CONVERSA EM TELA CHEIA (porte do original #3190). Escolhida, a conversa vira
 * uma camada `fixed` abaixo do `md`, em vez de um layout novo:
 *
 *   - `z-[45]` cobre o TopBar (z-30) sem que ninguém o edite, e fica abaixo
 *     das faixas de cima e dos portais Radix (z-50);
 *   - o topo desconta `--faixas-de-cima`: o aviso de canal caído é o único
 *     sinal de "nada entra nem sai" quando só há um número;
 *   - `--vv-topo`/`--vv-altura` (`useAlturaVisivel`) colam a camada na área
 *     visível com o teclado aberto; sem eles vale o `100dvh`;
 *   - a área segura de baixo sai quando o teclado abre, porque aí o indicador
 *     de home não está na tela.
 *
 * A lista fica `invisible`, e não `hidden`: sai da frente, do foco e da
 * árvore de acessibilidade, mas guarda a rolagem para quando a pessoa voltar.
 * Nenhum ancestral pode ter `transform`/`filter`/`contain`: isso quebraria o
 * `fixed`.
 */
const CAMADA_DA_CONVERSA = [
  "max-md:fixed max-md:inset-x-0 max-md:z-[45] max-md:bg-background",
  "max-md:top-[max(var(--vv-topo,0px),var(--faixas-de-cima,0px))]",
  "max-md:h-[calc(var(--vv-topo,0px)+var(--vv-altura,100dvh)-max(var(--vv-topo,0px),var(--faixas-de-cima,0px)))]",
  "max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)] max-md:data-[teclado-aberto]:pb-0",
].join(" ");

export function colunasDoCelular(temSelecao: boolean): { lista: string; conversa: string } {
  return {
    lista: temSelecao ? "max-md:invisible flex" : "flex",
    conversa: temSelecao ? `flex ${CAMADA_DA_CONVERSA}` : "hidden md:flex",
  };
}

/** A marca que o Inbox põe na entrada do histórico: conversas abertas desde a lista. */
const MARCA_DO_INBOX = "inboxProfundidade";

/**
 * Abaixo do `md` (o `max-md:` do Tailwind, 48rem) a lista e a conversa são
 * telas separadas, e só ali a seleção entra no histórico (`handleSelect`). No
 * computador as duas convivem e a seleção segue sendo estado da tela, como
 * sempre foi neste fork.
 */
function telaDeCelular(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(max-width: 47.99rem)").matches === true;
}

/**
 * VOLTAR DESFAZ O PASSO, EM VEZ DE EMPILHAR (porte do original #3190).
 *
 * Abrir a partir da lista empilha uma entrada com profundidade 1; abrir outra
 * conversa a partir dessa soma 1 (o j/k, por exemplo). Voltar anda a
 * profundidade inteira para trás, e o `popstate` devolve a lista pela URL
 * (`idNaUrl`): o gesto do sistema e o botão "‹ Conversas" passam a concordar.
 *
 * Sem marca (link direto, clique no aviso) voltar troca a entrada no lugar, e
 * trocar de conversa também: a pilha não cresce, e o gesto do sistema não
 * reabre a conversa que a pessoa acabou de fechar.
 *
 * Uma navegação do próprio Next (`router.push`) DESCARTA a marca, porque o
 * roteador grava o próprio estado por cima: a entrada nasce sem marca e o "‹"
 * troca no lugar. É o preço de não reabrir conversa, não um laço.
 *
 * O Next 16 copia o estado interno dele para dentro do objeto passado ao
 * `pushState` (`copyNextJsInternalHistoryState`), então a marca sobrevive.
 * Devolve `"pelo-historico"` quando quem troca a seleção é o `popstate`.
 */
export function navegarNoInbox(
  url: string,
  de: string | null,
  para: string | null,
): "trocou" | "pelo-historico" {
  const historia = window.history;
  const marca: unknown = (historia.state as Record<string, unknown> | null)?.[MARCA_DO_INBOX];
  const profundidade = typeof marca === "number" && marca > 0 ? marca : 0;
  if (para !== null) {
    const proxima = de === null ? 1 : profundidade > 0 ? profundidade + 1 : 0;
    if (proxima > 0) historia.pushState({ [MARCA_DO_INBOX]: proxima }, "", url);
    else historia.replaceState(null, "", url);
    return "trocou";
  }
  if (profundidade > 0) {
    historia.go(-profundidade);
    return "pelo-historico";
  }
  historia.replaceState(null, "", url);
  return "trocou";
}

/**
 * A LISTA ESCONDIDA NÃO GUARDA O FOCO. No celular a lista fica `invisible`
 * atrás da conversa, e no Safari do iPhone tocar num botão não tira o foco do
 * campo: a busca seguiria focada, com o teclado aberto, filtrando uma lista
 * que ninguém vê. Só age com a lista de fato escondida: no computador ela
 * segue visível e o foco (do teclado, inclusive) fica onde a pessoa o deixou.
 */
export function soltarFocoEscondido(lista: HTMLElement | null): void {
  const ativo = document.activeElement;
  if (!lista || !(ativo instanceof HTMLElement) || !lista.contains(ativo)) return;
  if (getComputedStyle(lista).visibility === "hidden") ativo.blur();
}

/**
 * O QUE CADA ABA SIGNIFICA. Exportada porque é a definição em si — o defeito
 * que este mapa já teve (Minhas mostrando tudo que o atendente fechou) não
 * aparece em nenhuma tela até alguém reclamar, então vale prender por teste.
 */
export function tabToFilter(
  tab: InboxFiltersValue["tab"],
  automaticoDaOrg?: boolean,
): Partial<ConversationsFilters> {
  switch (tab) {
    case "unassigned":
      // A FILA PERGUNTA POR QUEM MANDA, NÃO POR STATUS.
      //
      // Antes ela pedia `assigned_to=unassigned` + os dois estados de espera. Só
      // que "sem dono e aberta" é também a conversa que o robô está atendendo
      // agora — medido na VPS em 2026-08-30, a aba dizia 83 e 47 daquelas tinham
      // o automático no comando. O atendente abria a Fila e via como trabalho
      // dele quase tudo que já estava sendo respondido.
      //
      // `comandosDaFila` é quem cruza isso com o fato org-wide: numa instalação
      // sem nenhum agente no ar, `automatico` também é "esperando gente".
      return { comando: comandosDaFila(automaticoDaOrg) };
    case "mine":
      // Sem `exclude_finished` a aba mostra tudo que o atendente JÁ atendeu —
      // `Fechar` muda o status mas não solta o dono (de propósito: quem atendeu
      // é histórico). O lugar de "minhas fechadas" é a aba Fechadas.
      return { assigned_to: "me", exclude_finished: true };
    case "closed":
      return { status: "closed" };
    case "archived":
      // O ARQUIVO É UM ESTADO SÓ ELE, não `in(terminais)`.
      //
      // `CONVERSATION_TERMINAL_STATUSES` responde outra pergunta ("o que sai do
      // fluxo vivo", usada pelo `exclude_finished` de Minhas). Reaproveitá-la
      // aqui faria a aba Arquivadas listar também as fechadas — duas abas com a
      // mesma lista e badges diferentes, que é a mentira de tela que o mapa
      // abaixo existe para impedir.
      return { status: "archived" };
    case "ocultos":
      // Só as conversas de contato oculto do Inbox (migration 0372). As outras
      // abas não precisam pedir nada: o servidor nunca as devolve fora daqui.
      return { ocultos: true };
    case "ai":
      // `ai_handling` é escrito por UM caminho só em produção (a volta pelo botão
      // "Devolver ao automático"), então a aba vivia mostrando 2 enquanto o robô
      // atendia 47. Agora ela pergunta a régua do MOTOR.
      return { comando: ["automatico"] };
    case "all":
    default:
      return {};
  }
}

const FILTER_TABS: InboxTab[] = ["unassigned", "mine", "all", "closed", "archived", "ai", "comentarios", "ocultos"];

/**
 * Lê ?filter= (G4-02, deep-link). ?filter=all é HONRADO mesmo para agent — a
 * lista volta RLS-scoped (a tab só some cosmeticamente); default: fila.
 */
function parseFilterParam(v: string | null): InboxTab {
  return v && FILTER_TABS.includes(v as InboxTab) ? (v as InboxTab) : "unassigned";
}

/**
 * O getter de `window.localStorage` LANÇA (`SecurityError`) quando o navegador
 * bloqueia o armazenamento do site. O `try` de `lerLarguras`/`gravarLarguras`
 * só protege `getItem`/`setItem`; o getter tem de ser lido aqui dentro.
 */
function armazenamentoDoNavegador(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * A alça tem 8px no mouse e 24px no toque (`pointer-coarse`): com o dedo, 8px
 * não se acerta. `touch-none` entrega o gesto ao arraste em vez de rolar a
 * página. O fio de 1px é o que se vê; o resto é área de pegar.
 */
const CLASSE_DA_DIVISORIA =
  "group absolute inset-y-0 z-10 flex w-2 cursor-col-resize touch-none select-none items-stretch justify-center focus-visible:outline-hidden pointer-coarse:w-6";
const CLASSE_DO_FIO =
  "w-px bg-border transition-colors group-hover:bg-primary group-focus-visible:w-0.5 group-focus-visible:bg-primary";

/**
 * A largura do trilho do painel do contato RECOLHIDO (porte do original #3043):
 * o que sobra dele é um trilho estreito com o botão de expandir, e a conversa
 * recebe o resto da largura que era da ficha.
 */
const LARGURA_DO_TRILHO_DO_PAINEL = "2.75rem";

interface InboxLayoutProps {
  initialSelectedId?: string | null;
  /**
   * O painel do contato começa recolhido? Vem do cookie lido no SERVIDOR
   * (`app/app/inbox/page.tsx`), como o `sidebar_collapsed` do menu da esquerda:
   * é o que evita o painel nascer aberto e pular para trilho na hidratação.
   */
  painelRecolhidoInicial?: boolean;
}

export function InboxLayout({
  initialSelectedId = null,
  painelRecolhidoInicial = false,
}: InboxLayoutProps = {}) {
  const t = useT();
  const { activeOrg, user } = useAuth();
  const supportReadonly = user.support?.access_mode === "support_readonly";
  // Fundo e balões que ESTA pessoa escolheu. Nasce do perfil (vale em qualquer
  // computador) e muda aqui na hora; o controle grava e, se falhar, devolve.
  const [aparencia, setAparencia] = useState(user.aparencia_conversa ?? APARENCIA_PADRAO);
  // A faixa de ações do cabeçalho, quando fixada pelo botão "Ações", continua
  // fixada ao trocar de conversa e quando o cabeçalho remonta (a conversa que
  // sai da aba atual depois de "Assumir" ou "Fechar").
  const [acoesFixadas, setAcoesFixadas] = useState(false);
  const orgId = activeOrg?.orgId ?? null;

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = parseFilterParam(searchParams.get("filter"));
  const idNaUrl = searchParams.get("id");

  // tab vive na URL (?filter=); os demais filtros são estado local de sessão.
  const [aux, setAux] = useState<Omit<InboxFiltersValue, "tab">>({
    search: "",
    onlyUnread: false,
  });
  const filterValue: InboxFiltersValue = { tab, ...aux };
  const setFilterValue = useCallback(
    (next: InboxFiltersValue) => {
      if (next.tab !== tab) {
        const params = new URLSearchParams(searchParams);
        params.set("filter", next.tab);
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      }
      const { tab: _t, ...rest } = next;
      setAux(rest);
    },
    [tab, searchParams, router, pathname],
  );

  // Desliga só os AUXILIARES e mantém a aba: a aba é onde a pessoa está, e
  // limpá-la junto a tiraria do lugar sem ela ter pedido.
  const limparFiltrosAuxiliares = useCallback(() => {
    setFilterValue({ tab, search: "", onlyUnread: false });
  }, [tab, setFilterValue]);

  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  /** A ficha do contato como painel deslizante — só existe abaixo do `xl`. */
  const [fichaAberta, setFichaAberta] = useState(false);
  /**
   * O PAINEL DO CONTATO RECOLHIDO (porte do original #3043). O estado é da
   * TELA porque quem redistribui a largura é a grade; o painel só desenha o
   * controle. Nasce do cookie lido no servidor e cada clique grava pelo server
   * action, o mesmo caminho do `toggleSidebar`; o estado local dá o retorno
   * imediato do clique, sem esperar a volta do servidor.
   */
  const [painelRecolhido, setPainelRecolhido] = useState(painelRecolhidoInicial);
  const alternarPainelDoContato = useCallback(() => {
    setPainelRecolhido(!painelRecolhido);
    // O action recebe o estado ATUAL, como o `toggleSidebar`.
    startTransition(() => {
      void togglePainelDoContato(painelRecolhido);
    });
  }, [painelRecolhido]);
  /**
   * A busca dentro da conversa pertence à CONVERSA em que foi aberta. Guardar o
   * id junto fecha a busca em qualquer troca (clique, atalho j/k, voltar do
   * navegador) sem que cada caminho precise lembrar de limpá-la.
   */
  const [busca, setBusca] = useState<{ conversaId: string; termo: string } | null>(null);
  const buscaAberta = busca !== null && busca.conversaId === selectedId;
  const botaoBuscaRef = useRef<HTMLButtonElement | null>(null);
  const fecharBusca = useCallback(() => {
    setBusca(null);
    botaoBuscaRef.current?.focus();
  }, []);
  /**
   * A mensagem escolhida para responder "em cima".
   *
   * Mora aqui, e não no composer, porque quem ESCOLHE é a lista de mensagens e
   * quem MOSTRA é o composer — são irmãos, e o estado comum é do pai.
   */
  const [respondendo, setRespondendo] = useState<ConversationMensagem | null>(null);
  /**
   * A mensagem escolhida para ENCAMINHAR (DeskcommCRM #2835). Irmã do
   * `respondendo`: quem escolhe é o fio e quem mostra o destino é o diálogo.
   * `null` = diálogo fechado.
   */
  const [encaminhando, setEncaminhando] = useState<ConversationMensagem | null>(null);
  /**
   * A URL TAMBÉM TROCA A CONVERSA (porte do original #3190): o voltar do
   * celular devolve a lista pelo `popstate`, e um link para `?id=` com o Inbox
   * já aberto abre a conversa dele. Ajuste durante o render, o padrão do React
   * para estado que segue outro valor. No computador o Inbox não escreve `?id=`,
   * então aqui só chega navegação de fora.
   */
  const [idNaUrlVisto, setIdNaUrlVisto] = useState(idNaUrl);
  if (idNaUrlVisto !== idNaUrl) {
    setIdNaUrlVisto(idNaUrl);
    setSelectedId(idNaUrl);
    setRespondendo(null);
    setEncaminhando(null);
  }

  /**
   * A ORG tem automático de pé? Sobe para cá porque agora é a ABA que precisa —
   * `ConversationList` e `ConversationHeader` continuam lendo o mesmo hook, e o
   * react-query dedupa: segue sendo uma requisição só.
   *
   * `undefined` enquanto carrega, e `comandosDaFila` trata isso como "assume que
   * há" — a mesma convenção da regra. Numa org SEM automático a Fila nasce menor
   * e completa quando a resposta chega; a janela é de ~200ms e o rótulo nunca
   * discorda do filtro, porque os dois usam a mesma convenção.
   */
  const { data: automaticoDaOrg } = useAutomaticoAtivo();
  const composerRef = useRef<ComposerHandle | null>(null);

  const filters: ConversationsFilters = useMemo(
    () => ({
      ...tabToFilter(filterValue.tab, automaticoDaOrg),
      // O atendente escolhido pelo gerente. A aba Minhas já traz `assigned_to=me`,
      // e esse valor da aba vence (o seletor nem aparece ali).
      assigned_to: tabToFilter(filterValue.tab, automaticoDaOrg).assigned_to ?? filterValue.assigned_to,
      // A tela NÃO pede o que a rota recusa: o hook trata falha com
      // `showApiError`, então digitar a primeira letra de qualquer busca faria
      // piscar um erro na cara de quem digita. A regra é a MESMA que o schema
      // usa (`lib/inbox/termo-de-busca.ts`) — nunca repetida aqui.
      search: buscaValeConsulta(filterValue.search)
        ? filterValue.search
        : undefined,
      channel_session_id: filterValue.channel_session_id,
      // Sem esta linha o seletor mostrava "Só Instagram" e a lista seguia
      // com todos os canais: a contagem das abas filtrava, a lista não.
      canal: filterValue.canal,
      tag: filterValue.tag,
      tagMode: filterValue.tagMode,
      unread: filterValue.onlyUnread || undefined,
    }),
    [
      filterValue.tab,
      automaticoDaOrg,
      filterValue.assigned_to,
      filterValue.search,
      filterValue.channel_session_id,
      filterValue.canal,
      filterValue.tag,
      filterValue.tagMode,
      filterValue.onlyUnread,
    ],
  );


  // We need the selected conversation object for header / composer / side panel.
  // Source it from the same query the list uses to avoid an extra request.
  const listQ = useConversationsRealtime(filters, orgId);
  const inList = useMemo(() => {
    const all = listQ.data?.pages.flatMap((p) => p.data) ?? [];
    return all.find((c) => c.id === selectedId) ?? null;
  }, [listQ.data, selectedId]);

  // Deep-link para conversa fora do filtro atual (ou fora do escopo do agent):
  // busca única RLS-scoped. 404/vazio ⇒ inacessível ⇒ estado vazio claro (GAP D),
  // nunca stack trace. A RLS (G4-01) é quem garante o não-vazamento.
  //
  // ⚠️ ELA NÃO ESPERA A LISTA — e a espera custava DUAS voltas de rede inteiras.
  //
  // A condição tinha um terceiro termo, `&& !listQ.isLoading`, para poupar uma
  // requisição quando a conversa fosse aparecer na lista de qualquer jeito. O
  // preço real, medido no trace do CI (run 34226618108, deep-link para uma
  // conversa FECHADA — que nenhuma aba da Fila devolve, então a busca única é a
  // única fonte do objeto):
  //
  //   46.725  GET conversations?comando=aguardando               1091ms
  //   48.275  GET conversations?comando=aguardando,automatico     896ms
  //   49.183  GET conversations/<id>                              565ms
  //   49.775  GET contacts/<id>/crm-summary                    (>1034ms)
  //
  // São QUATRO idas em série depois do documento. A lista é pedida duas vezes
  // porque a `queryKey` muda quando `useAutomaticoAtivo` responde (ver
  // `comandosDaFila`), e `isLoading` volta a ser verdadeiro na chave nova — ou
  // seja, o gate segurava a busca única até a SEGUNDA lista assentar, e só
  // então o painel do contato podia começar a carregar. O painel do contato
  // aparecia ~4,7s depois da navegação, e é assim que `encerramento-atendimento`
  // ficou intermitente: a Memória do contato chegava ~0,1–0,6s DEPOIS dos 5s da
  // asserção (o screenshot de falha, tirado logo em seguida, já a mostra).
  //
  // Sem o gate, a busca única sai na primeira leva, em paralelo com a lista, e o
  // objeto existe uma volta depois do documento em vez de três. O custo é UMA
  // requisição extra por deep-link cuja conversa acabe aparecendo na lista —
  // clicar numa conversa da lista já carregada continua sem pedir nada, porque
  // aí `inList` já a tem no primeiro render.
  const needsFetch = !!selectedId && !inList;
  const single = useConversation(selectedId, needsFetch);
  const selectedConversation: ConversationWithContact | null = inList ?? single.data ?? null;
  const selectionNotFound =
    needsFetch && !single.isPending && !single.data && isNotFound(single.error);

  const colunas = colunasDoCelular(Boolean(selectedId));
  // O teclado do celular, medido só com conversa aberta (ver `colunasDoCelular`).
  const conversaRef = useRef<HTMLDivElement | null>(null);
  const tecladoAberto = useAlturaVisivel(conversaRef, Boolean(selectedId));
  const listaRef = useRef<HTMLDivElement | null>(null);
  // Depois de pintar: só então a lista já está `invisible` (ver `soltarFocoEscondido`).
  useEffect(() => {
    if (selectedId) soltarFocoEscondido(listaRef.current);
  }, [selectedId]);

  const claim = useClaimConversation();
  const close = useCloseConversation();
  // Encaminhar: o gesto abre a escolha do destino, e a execução é um POST que
  // reusa o caminho de envio do Inbox. Quem não responde não encaminha.
  const encaminhar = useEncaminharMensagem();
  const podeEncaminhar = usePermission("inbox.reply");
  // As conversas já carregadas são o universo de destinos, sem busca nova.
  const conversasDaLista = useMemo(() => listQ.data?.pages.flatMap((p) => p.data) ?? [], [listQ.data]);

  // LOTE (porte do upstream #2909): seleção múltipla e barra de ações. O
  // portão de tela é `inbox.reply`; a regra mora na API, que revalida.
  const podeAgirEmLote = usePermission("inbox.reply");
  const selecao = useSelecaoEmLote();
  const lote = useBulkConversations();
  const rodarLote = useCallback(
    (action: AcaoEmLote, toUserId?: string, reason?: string) => {
      const ids = Array.from(selecao.selecionados);
      if (ids.length === 0) return;
      lote.mutate(
        { ids, action, to_user_id: toUserId, reason },
        { onSuccess: () => selecao.limpar() },
      );
    },
    [lote, selecao],
  );

  // A leitura da conversa aberta é do upstream e fica: sem ela o contador de
  // não-lidas nunca zera para quem abre a conversa.
  useMarkAsRead(
    selectedConversation?.id ?? null,
    selectedConversation?.unread_count_for_assignee ?? 0,
  );

  // Aceita `null`: é o VOLTAR do celular, que limpa a seleção e devolve a lista.
  // É um SUPERCONJUNTO do `handleSelect` do upstream — o tipo dele não aceita
  // `null`, e sem isso o botão de voltar não teria o que chamar.
  //
  // NO CELULAR a seleção entra no histórico (porte do original #3190): abrir
  // pela lista empilha `?id=`, e o "‹ Conversas" e o gesto de voltar do sistema
  // desfazem esse passo (`navegarNoInbox`), em vez de o gesto sair do Inbox. No
  // computador a seleção continua sendo estado da tela, como sempre foi aqui: o
  // voltar do navegador não passeia pelas conversas clicadas.
  const handleSelect = useCallback((id: string | null) => {
    // Sem isto, escolher "responder" numa conversa e trocar para outra levaria
    // a citação junto — e a resposta sairia citando mensagem de outro cliente.
    setRespondendo(null);
    // O mesmo vale para o encaminhamento: a escolha não sobrevive à troca de conversa.
    setEncaminhando(null);
    if (id !== selectedId && telaDeCelular()) {
      const params = new URLSearchParams(searchParams.toString());
      if (id) params.set("id", id);
      else params.delete("id");
      const query = params.toString();
      // Voltar pela história deixa a troca para o `popstate` (ver `idNaUrl`).
      if (navegarNoInbox(query ? `${pathname}?${query}` : pathname, selectedId, id) === "pelo-historico") return;
    }
    setSelectedId(id);
  }, [selectedId, searchParams, pathname]);
  const handleVisibleChange = useCallback((ids: string[]) => setVisibleIds(ids), []);
  const handleFocusReply = useCallback(() => composerRef.current?.focus(), []);
  const handleClaim = useCallback(() => {
    if (!selectedConversation) return;
    claim.mutate({
      conversation_id: selectedConversation.id,
      expected_assignee: selectedConversation.assigned_to_user_id,
    });
  }, [claim, selectedConversation]);
  const handleClose = useCallback(() => {
    if (!selectedConversation) return;
    close.mutate({ conversation_id: selectedConversation.id });
  }, [close, selectedConversation]);

  // A janela vence SOZINHA com a aba aberta. Sem este relógio, quem deixa o
  // inbox aberto a tarde inteira seguiria com o composer liberado numa conversa
  // que já venceu — e o bloqueio só apareceria no próximo recarregamento.
  const [agoraJanela, setAgoraJanela] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setAgoraJanela(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  // A janela de 24h fecha o composer, e o motivo DIZ há quanto tempo fechou.
  //
  // Antes disto o texto livre saía, o CRM marcava `failed` e o operador via um
  // `131047` — descobrindo a regra pelo erro, uma mensagem por vez. Barrar aqui
  // é o pedido explícito do dono: se não dá para enviar, que não deixe tentar.
  //
  // Reusa o `blockedReason` que já existe (contato bloqueado/anonimizado) em vez
  // de um segundo mecanismo de bloqueio: dois caminhos para desabilitar o mesmo
  // composer divergem, e o segundo esquece de cobrir o áudio ou o anexo.
  const janela = estadoDaJanela(
    selectedConversation?.channel_sessions?.provider ?? null,
    selectedConversation?.last_inbound_at ?? null,
    agoraJanela,
  );
  // Canal que só RECEBE: nem janela nem modelo servem, a resposta simplesmente
  // não sai pelo CRM ainda. O aviso da janela ("só modelo aprovado") mentiria.
  const motivoSemEnvio = canalRespondePeloCrm(selectedConversation?.channel_sessions?.provider)
    ? null
    : t("Este canal ainda não envia pelo CRM; responda pelo app dele por enquanto.");
  // Vencimento de 7 dias (Instagram, `regra: "sete_dias"`): nem gente escreve
  // mais, e não há modelo aprovado no Direct — o texto muda, verbatim. Os
  // demais canais seguem no vencimento de 24h ("modelo"). Estado `humana`
  // (entre 24h e 7d, GENTE ainda responde) não entra aqui: não é `fechada`.
  const motivoDaJanela =
    !motivoSemEnvio && janela.tipo === "fechada"
      ? janela.regra === "sete_dias"
        ? janela.fechadaHaMs === null
          ? t(
              "Essa pessoa ainda não escreveu para este perfil. A Meta só deixa responder depois que ela mandar uma mensagem.",
            )
          : t(
              "A Meta só deixa responder até 7 dias depois da última mensagem dessa pessoa. Responda pelo app do Instagram se ela escrever de novo.",
            )
        : janela.fechadaHaMs === null
          ? t("O cliente ainda não escreveu — a janela de 24h nunca abriu. Só um modelo aprovado sai daqui.")
          : `${t("A janela de 24h fechou há")} ${formatarDecorrido(janela.fechadaHaMs)}. ${t("Só um modelo aprovado sai daqui — texto livre é recusado pela plataforma.")}`
      : null;

  // Limite de texto e mídia do canal, para o Composer — protegido para
  // provider nulo/desconhecido: `capabilitiesOf` lança fail-closed, e sem
  // provider resolvido a única resposta honesta é "sem limite conhecido".
  const providerDaConversa = selectedConversation?.channel_sessions?.provider ?? null;
  let caps: ReturnType<typeof capabilitiesOf> | null = null;
  if (providerDaConversa) {
    try {
      caps = capabilitiesOf(providerDaConversa as ChannelProvider);
    } catch {
      caps = null;
    }
  }

  const blockedReason = selectedConversation?.contacts?.is_blocked
    ? t("Contato bloqueado — envio de mensagens desabilitado.")
    : selectedConversation?.contacts?.is_anonymized
      ? t("Contato anonimizado — não é possível enviar mensagens.")
      : null;

  /* ─── DIVISÓRIAS ARRASTÁVEIS (porte do original #2604, de @webtecnica) ─
   *
   * A largura das colunas nasceu fixa no CSS (linha do `grid-cols` abaixo): em
   * monitor grande sobrava conversa e a lista e a ficha cortavam texto, sem
   * como ajustar. Aqui o CSS continua sendo o PADRÃO (quem nunca arrastou vê
   * exatamente a mesma grade de antes, pintada pelo servidor, sem esperar
   * JavaScript) e a largura ajustada entra por cima como `gridTemplateColumns`
   * inline, só depois da montagem.
   *
   * A regra (limites 240 a 520 / 260 a 560, piso de conversa de 420, memória
   * por faixa, teclado) mora em `lib/inbox/larguras-do-inbox.ts`, não aqui:
   * este arquivo posiciona a alça e chama a função; aquilo é o que o teste
   * prende.
   *
   * `faixa` é `null` até o efeito rodar (e sempre, no servidor e abaixo do
   * `md`): é o que garante primeiro render idêntico ao do servidor, sem
   * divisória nenhuma e sem estilo nenhum na grade. No celular nada muda.
   */
  const gradeRef = useRef<HTMLDivElement | null>(null);
  const [faixa, setFaixa] = useState<Faixa | null>(null);
  const [larguras, setLarguras] = useState<LargurasDoInbox | null>(null);
  // Espelho do estado para o fim do arraste (pointerup) persistir o valor mais
  // recente sem depender de um render que ainda não aconteceu.
  const largurasRef = useRef<LargurasDoInbox | null>(null);

  const aplicarLarguras = useCallback((proximas: LargurasDoInbox | null) => {
    largurasRef.current = proximas;
    setLarguras(proximas);
  }, []);

  /**
   * A FICHA OCUPA ESPAÇO AGORA? (porte do original #3152)
   *
   * Recolhida, a terceira trilha é o trilho de 44px, não a ficha; sem isto o
   * teto da lista continuava o de ficha ABERTA e arrastar a lista não
   * aproveitava nada do espaço liberado. Com o painel aberto o valor é o de
   * sempre (`faixa.temFicha`). Não contar o trilho é medido: na faixa `xl` o
   * container tem no mínimo ~992px, e com a lista no teto (520) a conversa
   * fica em 992 - 520 - 44 = 428px, acima do piso de 420.
   */
  const fichaOcupaEspaco = faixa?.temFicha === true && !painelRecolhido;

  const larguraDaGrade = (): number => {
    const grade = gradeRef.current;
    return grade ? grade.getBoundingClientRect().width : 0;
  };

  // Ao montar e a cada redimensionamento da janela: descobre a faixa e retoma a
  // largura SALVA DAQUELA faixa, já resolvida contra a largura real da grade.
  // A mesma chave `xl` cobre 1280 a 1535, e o piso da conversa tem de caber nos
  // dois extremos; por isso a releitura acontece também DENTRO da faixa (o
  // original só relia ao trocar de faixa, e encolher a janela deixava a
  // conversa abaixo do piso). Sem nada salvo, `null` = padrão do CSS.
  //
  // `painelRecolhido` entra nas deps (porte do #3152): recolher ou abrir o
  // painel muda o teto da lista. Uma largura esticada com o painel recolhido
  // seria aplicada crua ao reabrir e roubaria a conversa; re-resolvendo aqui,
  // quem limita continua sendo o `resolverLarguras`, nunca a chave salva.
  useEffect(() => {
    const medir = () => {
      const atual = faixaDaLargura(window.innerWidth);
      setFaixa(atual);
      const salvas = atual ? lerLarguras(armazenamentoDoNavegador(), atual.id) : null;
      aplicarLarguras(
        atual && salvas
          ? resolverLarguras({
              ...salvas,
              larguraContainer: gradeRef.current?.getBoundingClientRect().width ?? 0,
              temFicha: atual.temFicha && !painelRecolhido,
            })
          : null,
      );
    };
    medir();
    window.addEventListener("resize", medir);
    return () => window.removeEventListener("resize", medir);
  }, [aplicarLarguras, painelRecolhido]);

  /** O que vale AGORA na tela: o ajuste salvo, ou o padrão da faixa. */
  const efetivas: LargurasDoInbox | null = larguras ?? (faixa ? largurasPadrao(faixa) : null);

  const estiloDaGrade: CSSProperties | undefined =
    faixa && larguras
      ? {
          gridTemplateColumns: faixa.temFicha
            ? // Recolhido, o trilho entra no lugar da ficha; a largura ajustada
              // da ficha não se perde, volta inteira quando o painel reabre.
              `${larguras.lista}px minmax(0,1fr) ${painelRecolhido ? LARGURA_DO_TRILHO_DO_PAINEL : `${larguras.ficha}px`}`
            : `${larguras.lista}px minmax(0,1fr)`,
        }
      : undefined;

  const arrastar = (coluna: "lista" | "ficha", evento: ReactPointerEvent<HTMLSpanElement>) => {
    if (evento.button !== 0 || !faixa || !efetivas) return;
    const grade = gradeRef.current;
    if (!grade) return;
    // A medida é uma SÓ, lida no início do arraste: a grade não muda de
    // tamanho enquanto o ponteiro anda, e medi-la de novo a cada movimento
    // faria o alvo tremer contra o próprio valor que a pessoa está arrastando.
    const retangulo = grade.getBoundingClientRect();
    evento.preventDefault();
    evento.stopPropagation();
    evento.currentTarget.setPointerCapture?.(evento.pointerId);
    const base = largurasRef.current ?? efetivas;
    // O mesmo teto da resolução ao montar (porte do #3152): o arraste não
    // pode discordar da tela.
    const temFicha = fichaOcupaEspaco;
    const faixaAtual = faixa;

    const aoMover = (movimento: PointerEvent) => {
      const pedido =
        coluna === "lista"
          ? { ...base, lista: movimento.clientX - retangulo.left }
          : { ...base, ficha: retangulo.right - movimento.clientX };
      aplicarLarguras(
        resolverLarguras({ ...pedido, larguraContainer: retangulo.width, temFicha }),
      );
    };
    // `pointercancel` também encerra: no toque o navegador pode cancelar o
    // gesto (ligação, gesto do sistema) sem nunca mandar `pointerup`, e os
    // ouvintes ficariam pendurados na janela.
    const aoSoltar = () => {
      window.removeEventListener("pointermove", aoMover);
      window.removeEventListener("pointerup", aoSoltar);
      window.removeEventListener("pointercancel", aoSoltar);
      gravarLarguras(armazenamentoDoNavegador(), faixaAtual.id, largurasRef.current);
    };
    window.addEventListener("pointermove", aoMover);
    window.addEventListener("pointerup", aoSoltar);
    window.addEventListener("pointercancel", aoSoltar);
  };

  const teclarNaDivisoria = (
    coluna: "lista" | "ficha",
    evento: ReactKeyboardEvent<HTMLSpanElement>,
  ) => {
    if (!faixa || !efetivas) return;
    const proximo = moverPorSeta(coluna, (largurasRef.current ?? efetivas)[coluna], evento.key);
    if (proximo === null) return;
    evento.preventDefault();
    const base = { ...(largurasRef.current ?? efetivas), [coluna]: proximo };
    aplicarLarguras(
      resolverLarguras({ ...base, larguraContainer: larguraDaGrade(), temFicha: fichaOcupaEspaco }),
    );
    gravarLarguras(armazenamentoDoNavegador(), faixa.id, largurasRef.current);
  };

  /** Duplo clique na divisória: apaga a memória da faixa e volta ao CSS. */
  const restaurarPadrao = useCallback(() => {
    if (!faixa) return;
    gravarLarguras(armazenamentoDoNavegador(), faixa.id, null);
    aplicarLarguras(null);
  }, [faixa, aplicarLarguras]);

  // Altura da grade: a conta desconta TUDO que fica acima e abaixo dela.
  //   3.5rem            TopBar (`h-14`, em components/shell/TopBar.tsx)
  //   2 * --space-6     padding do <main> do AppShell (`p-6`, em cima e embaixo)
  //
  // Com `100vh-3.5rem` o padding ficava de fora e a grade media 48px a MAIS que a
  // tela. Quem pagava a diferença era o composer, que fica no rodapé: nascia
  // parcialmente abaixo da borda, atrapalhando justo na hora de escrever.
  //
  // As duas parcelas NÃO estão na mesma unidade, e por isso o padding entra pelo
  // token e não como `3rem`: o `@theme inline` de `app/globals.css` remapeia a
  // escala de spacing para `var(--space-N)` — `--space-6` é `24px` LITERAL —, mas
  // não remapeia o `14`, que o Tailwind 4 calcula pelo multiplicador `--spacing`
  // e segue sendo `3.5rem` de verdade. (Até o Tailwind 4 quem remapeava era o
  // `tailwind.config.ts`; o arquivo não existe mais, o efeito é o mesmo.)
  // Escrever a soma como
  // `6.5rem` só acerta enquanto a raiz for 16px; com acessibilidade de fonte maior
  // ou menor o composer sai da tela de novo. Pelo token, a conta se auto-corrige
  // se a escala de espaçamento mudar.
  //
  // `dvh` em vez de `vh` porque no celular a `vh` ignora a barra do navegador — o
  // mesmo corte, só que pior e mudando conforme se rola a página.

  // A ABA COMENTÁRIOS NÃO É CONVERSA — troca o corpo inteiro.
  //
  // `instagram_comments` não tem `selectedId`, não tem thread, não tem as três
  // colunas: é uma fila. Os hooks de conversa ACIMA continuam rodando de
  // qualquer jeito (regra do React — não dá pra pular hook por `if`), o custo é
  // uma query de conversas que esta tela não usa enquanto a aba está aqui.
  // `InboxFilters` segue no topo para poder trocar de aba de volta.
  if (filterValue.tab === "comentarios") {
    return (
      <div className="flex h-[calc(100dvh-var(--faixas-de-cima,0px)-3.5rem-var(--altura-das-abas,0px)-2*var(--space-6))] w-full flex-col">
        <InboxFilters value={filterValue} onChange={setFilterValue} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ComentariosPainel />
        </div>
      </div>
    );
  }

  // TRÊS COLUNAS QUE CABEM — medido, não estimado.
  //
  // O `xl` do Tailwind dispara em 1280px, e era ali que a terceira coluna
  // nascia: no ponto exato em que não havia espaço para ela. Com a barra de
  // navegação (240px) sobram 1040px, e o grid pedia 300 + 707 + 320 = 1327 —
  // o painel de CRM ficava 311px FORA da viewport, alcançável só rolando o
  // `main` de lado, que ninguém faz. Em 1280 o atendente simplesmente não via
  // contexto nenhum do cliente.
  //
  // Os 707px eram o `min-content` do `ConversationHeader` (a barra de ações
  // era `shrink-0`), e `1fr` é `minmax(auto, 1fr)`: não encolhe abaixo disso.
  // Consertado o header, o `1fr` volta a encolher sozinho — `minmax(0,1fr)`
  // foi medido aqui e não mudou um pixel, então não entrou.
  //
  // Duas faixas em vez de uma: compacta onde aperta, generosa onde há espaço.
  // Em 1280 isso dá 424px de conversa em vez de 372 — 54px de folga sobre o
  // piso do composer (370px), em vez dos 2px que a versão de uma faixa só
  // deixava. Margem de 2px não é margem, é sorte.
  return (
    <OpenConversationProvider conversationId={selectedId}>
    <div
      ref={gradeRef}
      style={estiloDaGrade}
      className={cn(
        "relative grid h-[calc(100dvh-var(--faixas-de-cima,0px)-3.5rem-var(--altura-das-abas,0px)-2*var(--space-6))] w-full grid-cols-1 md:grid-cols-[300px_1fr]",
        // Recolhido (porte do #3043), a terceira trilha vira o trilho do botão
        // de expandir. Literais inteiros: o Tailwind precisa deles para gerar o CSS.
        painelRecolhido
          ? "xl:grid-cols-[272px_1fr_2.75rem] 2xl:grid-cols-[300px_1fr_2.75rem]"
          : "xl:grid-cols-[272px_1fr_296px] 2xl:grid-cols-[300px_1fr_320px]",
      )}
      /*
       * O ESTADO DO TEMPO REAL, LEGÍVEL DE FORA — mesmo par que o dossiê do lead
       * já publica (`LeadDossier`), e pela mesma razão: quando a entrega morre,
       * nenhuma tela avisa. Foi o único achado que atravessou o dia intacto
       * quando o realtime quebrou pela primeira vez, e voltou a morder agora.
       *
       * `divergencias` é o que a rede de segurança contou: refetch trouxe estado
       * novo que o canal NÃO tinha entregue. Zero com o canal vivo; subindo é a
       * assinatura de canal que assina e não entrega — o defeito que não grita.
       *
       * ⚠️ `data-realtime-status` vem do STATUS do canal, não de um objeto que
       * existe sempre. A primeira versão desta linha derivava o valor de
       * `listQ.seguranca`, que nunca é nulo — ela diria `ativo` inclusive com o
       * canal morto. Controle decorativo é pior que controle nenhum: mente com
       * cara de instrumento.
       *
       * Atributo de dado e não texto na tela de propósito: quem lê isto é o
       * teste e quem depura, não o atendente. Pôr um aviso permanente na cara de
       * quem atende seria ruído; esconder o sinal do todo é o que custou o dia.
       */
      data-realtime-status={listQ.realtimeStatus}
      data-refetch-divergencias={listQ.seguranca?.divergencias ?? 0}
    >
      {/*
        NO CELULAR, UMA COISA POR VEZ.

        Antes as duas colunas caíam empilhadas em `grid-cols-1`: a lista inteira
        primeiro e a conversa DEPOIS dela. Para responder era preciso rolar a
        lista toda até o fim, e o composer ficava fora da tela — que é o
        "incômodo" relatado por quem atende do telefone.

        Sem media query em JavaScript de propósito: `useMediaQuery` decide DEPOIS
        da hidratação, então a primeira pintura mostra o layout errado e pisca. A
        classe condicional é resolvida pelo CSS, na primeira pintura, e some no
        `md` — onde as duas colunas cabem juntas e a regra não se aplica.
      */}
      <div
        ref={listaRef}
        className={cn(
          "h-full min-h-0 flex-col border-r border-border md:flex",
          colunas.lista,
        )}
      >
        {/* O título da coluna e a ação de criar na MESMA linha: hierarquia
            (o que é esta coluna → o que se faz nela) sem gastar uma faixa
            inteira com um botão. */}
        <div className="flex min-h-11 items-center justify-between gap-2 px-3 pt-2">
          <h2 className="text-sm font-semibold">{t("Conversas")}</h2>
          <BotaoIniciarConversa />
        </div>
        <InboxFilters value={filterValue} onChange={setFilterValue} />
        {podeAgirEmLote && (
          <BarraDeAcoesEmLote
            quantidade={selecao.quantidade}
            pendente={lote.isPending}
            onFechar={() => rodarLote("close")}
            onArquivar={() => rodarLote("archive")}
            onMarcarComoLida={() => rodarLote("mark-read")}
            onPausarIa={() => rodarLote("pause-ai")}
            onOcultar={() => rodarLote("hide")}
            onTransferir={(toUserId, reason) => rodarLote("transfer", toUserId, reason)}
            onLimpar={selecao.limpar}
          />
        )}
        <div className="min-h-0 flex-1 overflow-hidden">
          <ConversationList
            listQuery={listQ}
            filters={filters}
            selectedId={selectedId}
            onSelect={handleSelect}
            onVisibleChange={handleVisibleChange}
            onLimparFiltros={limparFiltrosAuxiliares}
            selecionados={selecao.selecionados}
            onAlternarSelecao={podeAgirEmLote ? selecao.alternar : undefined}
            onSelecionarTodosVisiveis={
              podeAgirEmLote
                ? () =>
                    selecao.selecionarTodos(
                      (listQ.data?.pages.flatMap((p) => p.data) ?? []).map((c) => c.id),
                    )
                : undefined
            }
          />
        </div>
      </div>

      {/*
        AS DUAS COLUNAS DECIDEM PELO MESMO DADO — `selectedId`, não o objeto.

        A da lista some quando há `selectedId`; se esta aparecesse só quando a
        conversa já está CARREGADA, a janela entre as duas coisas não mostra
        nenhuma das colunas. No celular isso é a tela em branco, e ela tem dois
        casos reais: o instante do deep-link `/inbox/<id>`, enquanto a busca
        única ainda responde; e o estado permanente de conversa fora do acesso,
        cuja mensagem ("Conversa não encontrada") é justamente o que ficava
        escondido — deixando o dono numa tela vazia, sem sequer o botão de
        voltar, porque ele morava dentro do ramo da conversa carregada.
      */}
      <div
        ref={conversaRef}
        data-teclado-aberto={tecladoAberto ? "" : undefined}
        className={cn(
          "group/conversa h-full min-h-0 min-w-0 flex-col md:flex",
          colunas.conversa,
        )}
      >
        {/*
          A barra do celular vive FORA do ramo da conversa carregada: o caminho
          de volta tem de existir inclusive quando não há o que mostrar — é aí
          que ele é a única saída. A porta da ficha, essa sim, depende da
          conversa, e só aparece quando há uma.
        */}
        {selectedId && (
          <div className="flex items-center gap-1 border-b border-border px-1 py-1 md:hidden">
            {/* Sem `h-9`: o `size="sm"` já dá 44px abaixo do `lg`, a altura de
                dedo (porte do #3190). Esta barra só existe abaixo do `md`. */}
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 px-2"
              onClick={() => handleSelect(null)}
            >
              <CaretLeft size={16} />
              {t("Conversas")}
            </Button>
            <div className="flex-1" />
            {selectedConversation && (
              <Button variant="ghost" size="sm" className="gap-1 px-2 xl:hidden" onClick={() => setFichaAberta(true)}>
                <IdentificationCard size={16} />
                {t("Ficha")}
              </Button>
            )}
          </div>
        )}
        {selectedConversation ? (
          <>
            {/* Uma ficha lateral só, aberta pelo botão do topo (notebook) e pelo da
                barra do celular. Antes ela morava dentro da barra do celular, e
                abaixo de 1280px fora do celular não havia como abri-la. */}
            <Sheet open={fichaAberta} onOpenChange={setFichaAberta}>
              <SheetContent side="right" className="w-[min(24rem,92vw)] overflow-y-auto p-0">
                <SheetTitle className="sr-only">{t("Ficha do contato")}</SheetTitle>
                <CRMSidePanel conversation={selectedConversation} />
              </SheetContent>
            </Sheet>
            <ConversationHeader
              onAbrirFicha={() => setFichaAberta(true)}
              conversation={selectedConversation}
              onBuscar={() =>
                buscaAberta ? fecharBusca() : setBusca({ conversaId: selectedConversation.id, termo: "" })
              }
              buscaAberta={buscaAberta}
              botaoBuscaRef={botaoBuscaRef}
              aparencia={aparencia}
              onAparenciaChange={setAparencia}
              acoesFixadas={acoesFixadas}
              onAcoesFixadasChange={setAcoesFixadas}
            />
            {buscaAberta && busca && (
              <div className="flex items-center gap-2 border-b border-border px-4 py-1.5">
                <MagnifyingGlass size={16} className="shrink-0 text-muted-foreground" aria-hidden />
                <input
                  type="search"
                  autoFocus
                  // 16px no celular: menos que isso o iPhone amplia a página no foco.
                  className="min-w-0 flex-1 bg-transparent py-1 text-base outline-hidden placeholder:text-muted-foreground md:text-sm"
                  aria-label={t("Buscar nas mensagens carregadas")}
                  placeholder={t("Buscar nas mensagens carregadas")}
                  value={busca.termo}
                  onChange={(e) => setBusca({ conversaId: busca.conversaId, termo: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") fecharBusca();
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-11 shrink-0 px-0 lg:w-8"
                  aria-label={t("Fechar busca")}
                  onClick={fecharBusca}
                >
                  <X size={16} aria-hidden />
                </Button>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-hidden">
              <ChatThread
                conversationId={selectedConversation.id}
                onResponder={setRespondendo}
                onEncaminhar={podeEncaminhar ? setEncaminhando : undefined}
                searchTerm={buscaAberta && busca ? busca.termo : ""}
                aparencia={aparencia}
              />
            </div>
            <RetentionNotice conversationId={selectedConversation.id} />
            {motivoDaJanela && (
              <JanelaFechadaAviso
                conversationId={selectedConversation.id}
                provider={selectedConversation.channel_sessions?.provider ?? null}
                motivo={motivoDaJanela}
              />
            )}
            <Composer
              ref={composerRef}
              conversationId={selectedConversation.id}
              blockedReason={supportReadonly ? "Acompanhamento somente leitura" : blockedReason}
              janelaFechada={motivoDaJanela}
              semEnvio={motivoSemEnvio}
              limiteDeTexto={caps?.limiteDeTexto ?? null}
              soFoto={caps?.midiaDeEnvio === "so_foto"}
              disabled={selectedConversation.status === "closed"}
              contact={selectedConversation.contacts}
              respondendo={respondendo}
              onCancelarResposta={() => setRespondendo(null)}
              currentContactId={selectedConversation.contact_id}
            />
          </>
        ) : selectionNotFound ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t("Conversa não encontrada ou fora do seu acesso.")}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <ChatCircle size={36} weight="thin" className="text-text-subtle" aria-hidden />
            <p className="text-sm font-medium text-text-muted">{t("Selecione uma conversa")}</p>
            <p className="text-xs text-text-muted">{t("Ou navegue com J e K")}</p>
          </div>
        )}
      </div>

      <div className="hidden h-full min-h-0 xl:block">
        <CRMSidePanel
          conversation={selectedConversation}
          recolhido={painelRecolhido}
          onAlternarRecolhido={alternarPainelDoContato}
        />
      </div>

      {/*
        AS DUAS DIVISÓRIAS: só a partir do `md`, quando as colunas convivem;
        abaixo disso `efetivas` é `null` e nenhuma nasce.

        `absolute` de propósito: a alça não é um item da grade (não ocupa
        trilha), ela se apoia em cima da borda entre as duas, e por isso a
        grade precisa do `relative`. A da lista anda pela ESQUERDA (o valor é
        a largura da lista); a da ficha pela DIREITA (o valor é a largura da
        ficha), o que evita medir a conversa para saber onde a terceira trilha
        começa.
      */}
      {efetivas && (
        <>
          <span
            role="separator"
            aria-orientation="vertical"
            aria-label={t("Ajustar largura da lista de conversas")}
            title={t("Arraste para ajustar a largura")}
            aria-valuenow={efetivas.lista}
            aria-valuemin={LIMITES_LISTA.min}
            aria-valuemax={LIMITES_LISTA.max}
            data-divisoria="lista"
            tabIndex={0}
            onPointerDown={(evento) => arrastar("lista", evento)}
            onDoubleClick={restaurarPadrao}
            onKeyDown={(evento) => teclarNaDivisoria("lista", evento)}
            className={CLASSE_DA_DIVISORIA + " -translate-x-1/2"}
            style={{ left: `${efetivas.lista}px` }}
          >
            <span aria-hidden className={CLASSE_DO_FIO} />
          </span>
          {faixa?.temFicha && !painelRecolhido && (
            <span
              role="separator"
              aria-orientation="vertical"
              aria-label={t("Ajustar largura da ficha do contato")}
              title={t("Arraste para ajustar a largura")}
              aria-valuenow={efetivas.ficha}
              aria-valuemin={LIMITES_FICHA.min}
              aria-valuemax={LIMITES_FICHA.max}
              data-divisoria="ficha"
              tabIndex={0}
              onPointerDown={(evento) => arrastar("ficha", evento)}
              onDoubleClick={restaurarPadrao}
              onKeyDown={(evento) => teclarNaDivisoria("ficha", evento)}
              className={CLASSE_DA_DIVISORIA + " translate-x-1/2"}
              style={{ right: `${efetivas.ficha}px` }}
            >
              <span aria-hidden className={CLASSE_DO_FIO} />
            </span>
          )}
        </>
      )}

      <InboxKeyboardShortcuts
        visibleIds={visibleIds}
        selectedId={selectedId}
        onSelect={handleSelect}
        onFocusReply={handleFocusReply}
        onClaim={supportReadonly ? () => {} : handleClaim}
        onClose={supportReadonly ? () => {} : handleClose}
        onToggleHelp={() => setHelpOpen((v) => !v)}
      />
      <ShortcutsHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <EncaminharDialog
        open={encaminhando !== null}
        onOpenChange={(aberto) => {
          if (!aberto) {
            setEncaminhando(null);
            // Diálogo fechado, intenção zerada: reabrir depois — outra mensagem
            // ou até a mesma — tem de poder encaminhar de novo, com chave nova.
            encaminhar.limparIntencao();
          }
        }}
        conversas={conversasDaLista}
        conversationIdAtual={selectedConversation?.id ?? null}
        enviando={encaminhar.isPending}
        onEscolher={(destino) => {
          if (!encaminhando) return;
          encaminhar.mutate(
            { id: encaminhando.id, conversationIdDestino: destino },
            { onSuccess: () => setEncaminhando(null) },
          );
        }}
      />
    </div>
    </OpenConversationProvider>
  );
}
