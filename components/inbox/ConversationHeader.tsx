"use client";
import { useRef, useState, type RefObject } from "react";
import { useT } from "@/hooks/i18n/useT";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { JanelaSelo } from "@/components/inbox/JanelaSelo";
import { capabilitiesOf } from "@/lib/channels/capabilities";
import type { ChannelProvider } from "@/lib/channels/types";
import {
  InstagramLogo,
  ArrowRight,
  MagnifyingGlass,
  IdentificationCard,
  DotsThree,
  ArrowsLeftRight,
  CheckCircle,
  Archive,
} from "@/lib/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { acaoPrincipalDaConversa } from "@/lib/inbox/acao-principal";
import { cn } from "@/lib/utils";
import { AparenciaDaConversa } from "@/components/inbox/AparenciaDaConversa";
import type { AparenciaDaConversa as AparenciaDaConversaValor } from "@/lib/inbox/aparencia-da-conversa";
import { AvatarDoContato } from "@/components/inbox/AvatarDoContato";
import { useAuth, usePermission } from "@/hooks/auth/AuthProvider";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useReleaseConversation } from "@/hooks/inbox/useReleaseConversation";
import {
  useArchiveConversation,
  useCloseConversation,
  useReopenConversation,
} from "@/hooks/inbox/useCloseConversation";
import { useResumeAiAttendance } from "@/hooks/inbox/useResumeAiAttendance";
import { usePauseAiAttendance } from "@/hooks/inbox/usePauseAiAttendance";
import { useAutomaticoAtivo } from "@/hooks/ai/useAutomaticoAtivo";
import { OwnerBadge } from "@/components/kanban/OwnerBadge";
import { comandoDaConversa, ROTULO_DO_MOTIVO } from "@/lib/inbox/comando-da-conversa";
import { ExportarConversaEmPdf } from "@/components/inbox/ExportarConversaEmPdf";
import { OcultarDoInbox, SeloDeOculto } from "@/components/inbox/OcultarDoInbox";
import { ReassignDialog } from "@/components/inbox/ReassignDialog";
import { ConfirmarNaTela } from "@/components/inbox/ConfirmarNaTela";
import { SeloDoCanal } from "@/components/inbox/SeloDoCanal";
import { SnoozeButton } from "@/components/inbox/SnoozeButton";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";

interface Props {
  conversation: ConversationWithContact;
  /**
   * A busca DENTRO da conversa: abre um campo que filtra só as mensagens já
   * carregadas. A busca mora no menu ⋯ (I3); o ref fica no ⋯, para o foco ter
   * aonde voltar quando o campo fecha.
   */
  onBuscar?: () => void;
  buscaAberta?: boolean;
  botaoBuscaRef?: RefObject<HTMLButtonElement | null>;
  /**
   * Abre a ficha do contato em painel lateral. Abaixo de `xl` a ficha não cabe
   * ao lado da conversa, e até aqui o único jeito de vê-la era no celular — em
   * notebook ela simplesmente não existia (print de 07/10/2026).
   */
  onAbrirFicha?: () => void;
  /** Fundo e balões desta pessoa — o controle mora no menu ⋯. */
  aparencia?: AparenciaDaConversaValor;
  onAparenciaChange?: (proximo: AparenciaDaConversaValor) => void;
}

/**
 * O CHIP NOMEIA CICLO DE VIDA, NÃO COMANDO.
 *
 * Ele afirmava quem manda — "Automático atendendo", "Aguardando atendente" — a
 * 20px de um selo que responde a MESMA pergunta por outra fonte, e as duas se
 * contradiziam na tela: `conversations.status` não acompanha silêncio, trava de
 * contato nem atribuição, e o motor nunca o lê. Medido em 2026-08-30 num print
 * do dono: "Aguardando atendente" e "Automático" no mesmo cabeçalho.
 *
 * Quem responde "quem manda" é o `OwnerBadge`, que vem de `comandoDaConversa`.
 * Aqui fica só o que o status realmente sabe: o episódio está aberto ou acabou.
 *
 * Cobre os SETE valores do CHECK de propósito — o call site é
 * `t(STATUS_LABEL[status] ?? status)`, e um buraco imprime o token cru em inglês
 * no rosto do atendente. Vigiado pelo invariante de espelho.
 */
const STATUS_LABEL: Record<string, string> = {
  open: "Aberta",
  pending: "Aberta",
  claimed: "Aberta",
  ai_handling: "Aberta",
  resolved: "Resolvida",
  closed: "Fechada",
  archived: "Arquivada",
};

export function ConversationHeader({
  conversation,
  onBuscar,
  buscaAberta,
  botaoBuscaRef,
  onAbrirFicha,
  aparencia,
  onAparenciaChange,
}: Props) {
  const t = useT();
  const { user } = useAuth();
  const claim = useClaimConversation();
  const release = useReleaseConversation();
  const close = useCloseConversation();
  const reopen = useReopenConversation();
  const arquivar = useArchiveConversation();
  const retomar = useResumeAiAttendance();
  const pausar = usePauseAiAttendance();
  // "Existe automático nesta org?" — sem isto o selo afirmava que o robô estava
  // atendendo em instalação que nunca configurou agente nenhum.
  const automaticoDaOrg = useAutomaticoAtivo();
  // Quem só visualiza não vê o que a rota recusaria (item 37 da auditoria de
  // 17/11): Assumir, Transferir, Fechar e o resto voltavam "sem permissão".
  const podeAgir = usePermission("inbox.reply");
  const [reassignOpen, setReassignOpen] = useState(false);
  // I6 (passo 1): a confirmação guarda a conversa e a revisão do MOMENTO do
  // clique. Com o diálogo aberto, `j`/`k` ainda trocam a conversa da tela; sem
  // a foto, o "Fechar conversa" fecharia a que entrou no lugar.
  const [confirmando, setConfirmando] = useState<
    { acao: "fechar" | "arquivar"; id: string; revisao: typeof conversation.service_revision } | null
  >(null);
  // O menu ⋯ (I3). Fecha ao trocar de conversa: ele fala da conversa da tela.
  const [menuAberto, setMenuAberto] = useState(false);
  const [menuDaConversa, setMenuDaConversa] = useState(conversation.id);
  if (menuDaConversa !== conversation.id) {
    setMenuDaConversa(conversation.id);
    setMenuAberto(false);
  }
  // Fechar o menu devolve o foco ao ⋯ — menos quando o item escolhido leva o
  // foco a outro lugar (a busca abre um campo com `autoFocus`).
  const focoFicaOnde = useRef(false);

  const c = conversation.contacts ?? null;
  const displayName = rotuloDoContato(c, t);
  const phone = c?.phone_number ? phoneForDisplay(c.phone_number) : null;
  const status = conversation.status;
  const isMineAssigned = conversation.assigned_to_user_id === user.id;
  const isOpen = status === "open" || conversation.assigned_to_user_id == null;

  /**
   * QUEM MANDA, uma pergunta com uma resposta.
   *
   * Este bloco era três leituras parciais. O selo e o botão de volta liam duas
   * travas (`bot_silenced_until || force_human`); a linha da lista lia uma, por
   * COR; o painel não lia nenhuma. Desde a 0173 há uma quarta situação —
   * "alguém assumiu" — e continuar somando condições à mão aqui é como as três
   * leituras divergiram em primeiro lugar. A regra mora em `lib/inbox`,
   * espelhando os gates que o MOTOR lê, e esta tela só a consome.
   */
  const { comando, automaticoAtivo, travaVigente, motivo } = comandoDaConversa({
    status,
    assigned_to_user_id: conversation.assigned_to_user_id,
    assigned_to_user_name: conversation.assigned_to_user_name ?? null,
    assignee_kind: conversation.assignee_kind ?? null,
    bot_silenced_until: conversation.bot_silenced_until ?? null,
    force_human: c?.force_human ?? null,
    is_blocked: conversation.contacts?.is_blocked ?? null,
    automaticoDaOrg: automaticoDaOrg.data,
  });

  const encerrada = status === "closed" || status === "archived" || status === "resolved";
  /**
   * A VOLTA aparece sempre que há algo a devolver — inclusive em conversa
   * ENCERRADA. Antes ela era condicionada a `status !== "closed"`, e o resultado
   * era um beco sem saída medido: atendente assume, fecha, sai de férias; a
   * conversa fica com o automático parado e, para qualquer colega, sem NENHUMA
   * porta — "Liberar" só existe para o próprio dono e a rota recusa quem não é.
   * `devolverAtendimentoAoAgente` funciona nesse estado (o status fechado está na
   * lista de reativáveis), então esconder o botão escondia uma ação que existe.
   *
   * A condição é `travaVigente`, e NÃO `!automaticoAtivo`: conversa encerrada tem
   * o automático inativo sem ter trava nenhuma, e sair do segundo faria o botão
   * aparecer em toda conversa fechada — clicá-lo REABRIRIA uma conversa que
   * ninguém pediu para reabrir. Oferecer uma ação que não deveria acontecer é
   * pior que não oferecer nenhuma.
   */
  // Canal onde a IA nunca responde (o Instagram): não há automático para
  // devolver, pausar ou "voltar em instantes". Provider nulo/desconhecido faz
  // `capabilitiesOf` lançar; aí vale o comportamento de sempre.
  let iaResponde = true;
  const providerDaConversa = conversation.channel_sessions?.provider;
  if (providerDaConversa) {
    try {
      iaResponde = capabilitiesOf(providerDaConversa as ChannelProvider).iaResponde;
    } catch {
      iaResponde = true;
    }
  }
  const podeDevolver = travaVigente && iaResponde;
  /**
   * PAUSAR só aparece quando pausar é um gesto DIFERENTE de assumir.
   *
   * Desde a 0173 "Assumir" já cala o automático (a RPC grava o silêncio). Numa
   * conversa sem dono, portanto, "Assumir" e "Pausar o automático" teriam
   * exatamente o mesmo efeito — dois botões para um ato é a confusão que esta
   * entrega existe para acabar, não para dobrar.
   *
   * Sobra o caso em que ele é próprio: a conversa JÁ tem dono e o automático
   * continua de pé. Isso é real e não é raro — o rodízio (`reason='routing'`)
   * distribui sem calar, de propósito, senão uma org em round_robin ficaria sem
   * automático nenhum.
   */
  const podePausar =
    iaResponde && automaticoAtivo && !encerrada && conversation.assigned_to_user_id !== null;

  if (user.support?.access_mode === "support_readonly") return <header className="flex items-center justify-between border-b p-4">
    <strong>{displayName}</strong><span className="text-sm text-muted-foreground">{STATUS_LABEL[status] ?? status} · Somente leitura</span>
  </header>;
  const acaoPrincipal = !podeAgir ? null : acaoPrincipalDaConversa({
    encerrada,
    minha: isMineAssigned,
    semDono: isOpen,
    podeDevolver,
  });
  // Item do menu ⋯: fecha o menu e faz o gesto. Os que abrem coisa própria
  // (Aparência, Ocultar, PDF com o seu "gerando…") NÃO passam por aqui — fechar
  // o menu desmontaria o que eles abriram.
  const doMenu = (fn: () => void) => () => {
    setMenuAberto(false);
    fn();
  };
  const ITEM = "w-full justify-start gap-2 px-2";

  const assumir = () =>
    claim.mutate({
      conversation_id: conversation.id,
      expected_assignee: conversation.assigned_to_user_id,
    });
  const devolver = () => retomar.mutate({ conversation_id: conversation.id });
  // O ALCANCE DA VOLTA NÃO É SEMPRE O MESMO, e a tela precisa dizer qual é.
  // `devolverAtendimentoAoAgente` limpa `contacts.force_human`, que é do
  // CLIENTE e não desta conversa: quando foi ela que travou, o clique religa o
  // automático para TODAS as conversas daquela pessoa.
  const dicaDaVolta =
    motivo === "contato_travado"
      ? t("Religa o atendimento automático para este cliente — vale para todas as conversas dele.")
      : t("Devolve esta conversa ao atendimento automático.");

  // O subtítulo é o NÚMERO, como no WhatsApp. Sem telefone (Instagram), a conta
  // por onde ela escreveu. Quando o nome já é o número, não repete.
  const viaInstagram =
    conversation.channel === "instagram"
      ? conversation.channel_sessions?.display_name
        ? `${t("via")} ${conversation.channel_sessions.display_name}`
        : t("Instagram")
      : null;
  const subtitulo = phone && phone !== displayName ? phone : !phone ? viaInstagram : null;

  return (
    // CABEÇALHO DE APP DE MENSAGEM (pedido do André, 18/11/2026): só a foto, o
    // nome e o número, como no WhatsApp. NENHUMA ação some: todas moram no ⋯ da
    // direita, com a ação principal (Assumir, Devolver ao automático ou
    // Reabrir) em primeiro. Quem responde, o porquê, a situação e a janela de
    // 24 h vão para o alto do mesmo menu — informação a um clique, não selos
    // disputando a linha do nome. Os atalhos de teclado (a, e, r) seguem no
    // InboxLayout, e o menu é aberto por clique, Enter ou espaço.
    <div
      data-cabecalho-da-conversa=""
      className="relative flex min-w-0 items-center gap-3 border-b border-border bg-surface px-3 py-2 md:px-4"
    >
      <div className="relative shrink-0">
        <AvatarDoContato contato={c} nome={displayName} reserva={phone ?? displayName} className="h-10 w-10" />
        <SeloDoCanal
          canal={conversation.channel === "instagram" ? "instagram" : "whatsapp"}
          tamanho="pequeno"
          className="absolute -bottom-0.5 -left-0.5"
        />
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[15px] font-semibold leading-5">{displayName}</h2>
        {subtitulo && (
          <p className="truncate text-xs leading-4 text-text-muted tabular-nums" data-testid="numero-do-contato">
            {subtitulo}
          </p>
        )}
      </div>

      {/* O MENU ⋯, aberto por CLIQUE (nunca por hover). Popover não-modal, e
          não DropdownMenu, de propósito: Aparência, Lembrar e Ocultar abrem
          coisa própria que precisa continuar montada. O nome "Ações da
          conversa" é o que as specs e o leitor de tela conhecem; o estado vai
          em `aria-expanded`. */}
      <Popover open={menuAberto} onOpenChange={setMenuAberto}>
        <PopoverTrigger asChild>
          <Button
            ref={botaoBuscaRef}
            type="button"
            size="sm"
            variant={menuAberto ? "secondary" : "ghost"}
            // 44px no celular (o `size="sm"` dá `h-11` abaixo do `lg`); a
            // partir do `md`, os 36px de antes.
            className="w-11 shrink-0 px-0 md:h-9 md:w-9"
            title={t("Mais ações")}
            aria-label={t("Ações da conversa")}
          >
            <DotsThree size={20} weight="bold" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="flex max-h-[min(36rem,calc(100dvh-6rem))] w-72 flex-col gap-0.5 overflow-y-auto p-1.5"
          data-testid="menu-da-conversa"
          // A busca abre um campo com foco próprio; devolver o foco ao ⋯
          // tiraria o cursor dele.
          onCloseAutoFocus={(e) => {
            if (focoFicaOnde.current) {
              e.preventDefault();
              focoFicaOnde.current = false;
            }
          }}
        >
          {/* 1. A AÇÃO PRINCIPAL, em primeiro. Rótulo "Assumir" e atalho `a`
              são contrato (o dicionário de espanhol e a ajuda de atalhos). */}
          {acaoPrincipal === "assumir" && (
            <Button
              size="sm"
              variant="default"
              className="w-full justify-start"
              data-acao-principal="assumir"
              disabled={claim.isPending}
              // Desde a 0173 assumir também para o atendimento automático, e um
              // botão que muda duas coisas precisa anunciar as duas.
              title={t("Você passa a responder esta conversa e o atendimento automático para aqui.")}
              onClick={doMenu(assumir)}
            >
              {t("Assumir")}
            </Button>
          )}
          {/* O `data-testid` da VOLTA é o mesmo, principal ou não:
              `escalacao-ciclo` o clica, e testid visível é contrato. */}
          {acaoPrincipal === "devolver" && (
            <Button
              size="sm"
              variant="default"
              className="w-full justify-start"
              data-acao-principal="devolver"
              disabled={retomar.isPending}
              data-testid="devolver-ao-automatico"
              title={dicaDaVolta}
              onClick={doMenu(devolver)}
            >
              {retomar.isPending ? t("Devolvendo...") : t("Devolver ao automático")}
            </Button>
          )}
          {/* "Reabrir" continua como sempre foi: `status: "open"`, de volta à
              fila. Quem quer responder usa a barra no lugar do campo de texto,
              que reabre já com a pessoa como dona. */}
          {acaoPrincipal === "reabrir" && (
            <Button
              size="sm"
              variant="default"
              className="w-full justify-start"
              data-acao-principal="reabrir"
              disabled={reopen.isPending}
              onClick={doMenu(() =>
                reopen.mutate({ conversation_id: conversation.id, expected_revision: conversation.service_revision }),
              )}
            >
              {t("Reabrir")}
            </Button>
          )}

          {/* 2. A SITUAÇÃO: quem responde (por GEOMETRIA, o mesmo componente do
              funil e do dossiê), o porquê, o estado do episódio e a janela. Os
              testids são contrato das specs (`comando-da-conversa`,
              `badge-atendimento-humano`). */}
          <div
            role="group"
            aria-label={t("Situação da conversa")}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 text-xs"
          >
            <div className="flex items-center gap-2" data-testid="comando-da-conversa">
              {comando.quem === "humano" ? (
                <OwnerBadge ownerKind="user" ownerName={comando.nome ?? t("Atendente")} />
              ) : comando.quem === "automatico" ? (
                <OwnerBadge ownerKind="ai" ownerName={t("Automático")} />
              ) : (
                // `ninguem`, `aguardando` e `encerrada` sem dono: o disco
                // TRACEJADO, que é como o funil já desenha "ninguém".
                <OwnerBadge ownerKind={null} ownerName={null} />
              )}
            </div>
            {/* Sem IA no canal, o selo falaria de um automático que não existe;
                o opt-out do cliente continua valendo e aparecendo. */}
            {motivo !== null && (iaResponde || motivo === "contato_descadastrado") && (
              <Badge variant="outline" className="h-5 px-1.5 text-xs leading-none" data-testid="badge-atendimento-humano">
                {t(ROTULO_DO_MOTIVO[motivo])}
              </Badge>
            )}
            {conversation.contato_oculto && <SeloDeOculto className="h-5 px-1.5 text-xs leading-none" />}
            <Badge variant="outline" className="h-5 px-1.5 text-xs leading-none">
              {t(STATUS_LABEL[status] ?? status)}
            </Badge>
            {/* "Dá para escrever agora?" — a janela de 24 h do canal oficial. */}
            <JanelaSelo
              provider={conversation.channel_sessions?.provider ?? null}
              lastInboundAt={conversation.last_inbound_at}
            />
            {viaInstagram && subtitulo !== viaInstagram && (
              <span className="flex items-center gap-1 text-canal-instagram">
                <InstagramLogo size={11} weight="regular" aria-hidden />
                {viaInstagram}
              </span>
            )}
          </div>

          {/* 3. O DIA A DIA: Transferir, Lembrar, Fechar. */}
          {podeAgir && !encerrada && (
            <>
              <div role="separator" className="my-1 h-px bg-border" />
              <Button size="sm" variant="ghost" className={ITEM} onClick={doMenu(() => setReassignOpen(true))}>
                <ArrowsLeftRight size={16} aria-hidden />
                {t("Transferir")}
              </Button>
              <SnoozeButton
                conversationId={conversation.id}
                snoozeUntil={conversation.snooze_until ?? null}
                variante="item"
              />
              <Button
                size="sm"
                variant="ghost"
                className={ITEM}
                disabled={close.isPending}
                onClick={doMenu(() =>
                  setConfirmando({ acao: "fechar", id: conversation.id, revisao: conversation.service_revision }),
                )}
              >
                <CheckCircle size={16} aria-hidden />
                {t("Fechar conversa")}
              </Button>
            </>
          )}

          {/* 4. O que muda o comando e não é o principal agora. "Liberar"
              devolve a conversa ao AUTOMÁTICO (RPC da 0173); num canal onde a
              IA nunca responde, isso tiraria a conversa da Fila sem pôr
              ninguém no lugar. Quem pegou por engano ainda tem "Transferir". */}
          {podeAgir && ((isMineAssigned && iaResponde) || (podeDevolver && acaoPrincipal !== "devolver") || podePausar) && (
            <div role="separator" className="my-1 h-px bg-border" />
          )}
          {podeAgir && isMineAssigned && iaResponde && (
            <Button
              size="sm"
              variant="ghost"
              className={ITEM}
              disabled={release.isPending}
              onClick={doMenu(() => release.mutate({ conversation_id: conversation.id }))}
            >
              {t("Liberar")}
            </Button>
          )}
          {/* A VOLTA aparece sempre que há algo a devolver — inclusive em
              conversa ENCERRADA, onde "Liberar" não alcança quem não é dono. */}
          {podeAgir && podeDevolver && acaoPrincipal !== "devolver" && (
            <Button
              size="sm"
              variant="ghost"
              className={ITEM}
              disabled={retomar.isPending}
              data-testid="devolver-ao-automatico"
              title={dicaDaVolta}
              onClick={doMenu(devolver)}
            >
              {retomar.isPending ? t("Devolvendo...") : t("Devolver ao automático")}
            </Button>
          )}
          {/* PAUSAR só quando é um gesto diferente de assumir: com dono e o
              automático de pé (o rodízio distribui sem calar). */}
          {podeAgir && podePausar && (
            <Button
              size="sm"
              variant="ghost"
              className={ITEM}
              disabled={pausar.isPending}
              data-testid="pausar-o-automatico"
              title={t("O atendimento automático para nesta conversa. O dono não muda.")}
              onClick={doMenu(() => pausar.mutate({ conversation_id: conversation.id }))}
            >
              {pausar.isPending ? t("Pausando...") : t("Pausar o automático")}
            </Button>
          )}

          {/* 5. Ferramentas de LEITURA e o resto. */}
          <div role="separator" className="my-1 h-px bg-border" />
          {onBuscar && (
            <Button
              size="sm"
              variant="ghost"
              className={ITEM}
              onClick={() => {
                setMenuAberto(false);
                focoFicaOnde.current = !buscaAberta;
                onBuscar();
              }}
              aria-expanded={buscaAberta}
            >
              <MagnifyingGlass size={16} aria-hidden />
              {t("Buscar nesta conversa")}
            </Button>
          )}
          {podeAgir && <ExportarConversaEmPdf conversationId={conversation.id} comNome />}
          {aparencia && onAparenciaChange && (
            <AparenciaDaConversa valor={aparencia} onChange={onAparenciaChange} comNome />
          )}
          {/* `xl:hidden`: a partir de 1280px o painel lateral entra na tela com
              a ficha e o "Ver contato" próprios. Abaixo, esta é a única porta. */}
          {onAbrirFicha && (
            <Button size="sm" variant="ghost" className={cn(ITEM, "xl:hidden")} onClick={doMenu(onAbrirFicha)}>
              <IdentificationCard size={16} aria-hidden />
              {t("Ficha")}
            </Button>
          )}
          {c?.id && (
            <Button asChild size="sm" variant="ghost" className={cn(ITEM, "xl:hidden")}>
              <Link href={`/app/contacts/${c.id}`} onClick={() => setMenuAberto(false)}>
                <ArrowRight size={16} weight="regular" aria-hidden />
                {t("Ver contato")}
              </Link>
            </Button>
          )}
          {/* Ocultar do Inbox (migration 0372). Grupo não tem contato. */}
          {podeAgir && c?.id && (
            <OcultarDoInbox
              contactId={c.id}
              conversationId={conversation.id}
              nome={displayName}
              oculto={conversation.contato_oculto === true}
              variante="item"
            />
          )}
          {/* ARQUIVAR (#923): tira da frente sem destruir. Pergunta antes. */}
          {podeAgir && status !== "archived" && (
            <Button
              size="sm"
              variant="ghost"
              className={ITEM}
              disabled={arquivar.isPending}
              onClick={doMenu(() =>
                setConfirmando({ acao: "arquivar", id: conversation.id, revisao: conversation.service_revision }),
              )}
            >
              <Archive size={16} aria-hidden />
              {arquivar.isPending ? t("Arquivando...") : t("Arquivar")}
            </Button>
          )}
        </PopoverContent>
      </Popover>
      <ReassignDialog
        conversationId={conversation.id}
        open={reassignOpen}
        onOpenChange={setReassignOpen}
      />
      {/* A confirmação precisa dizer o que ACONTECE, e o que acontece depende do
          estado. `fn_conversation_set_status` trata `archived` como terminal:
          encerra o atendimento (grava `service_closed_at`, incrementa a revisão)
          e, com isso, desfaz a pausa do automático. Um atendente que leia
          "arquivar = tirar da vista, volto depois" encerraria o atendimento sem
          saber — e o robô voltaria a responder no próximo "oi" do cliente. */}
      <ConfirmarNaTela
        aberto={confirmando !== null}
        onAbertoChange={(aberto) => !aberto && setConfirmando(null)}
        titulo={confirmando?.acao === "arquivar" ? t("Arquivar esta conversa?") : t("Fechar esta conversa?")}
        descricao={
          confirmando?.acao === "arquivar"
            ? encerrada
              ? undefined
              : t("Arquivar encerra este atendimento e guarda a conversa no histórico. Se o cliente escrever de novo, ela volta.")
            : t("O atendimento termina. Se o paciente escrever de novo, a conversa volta para a fila, e o automático pode responder.")
        }
        acao={confirmando?.acao === "arquivar" ? t("Arquivar") : t("Fechar conversa")}
        onConfirmar={() => {
          if (!confirmando) return;
          const alvo = { conversation_id: confirmando.id, expected_revision: confirmando.revisao };
          if (confirmando.acao === "arquivar") arquivar.mutate(alvo);
          else close.mutate(alvo);
        }}
      />
    </div>
  );
}
