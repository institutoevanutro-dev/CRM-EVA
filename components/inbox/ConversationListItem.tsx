"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import { format, formatDistanceToNowStrict } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { Check, Robot } from "@/lib/ui/icons";
import { AvatarDoContato } from "@/components/inbox/AvatarDoContato";
import { SeloDoCanal } from "@/components/inbox/SeloDoCanal";
import { comandoDaConversa, esperaDaConversa } from "@/lib/inbox/comando-da-conversa";
import { cn } from "@/lib/utils";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { previaNaTela } from "@/lib/messaging/previa-da-mensagem";
import { phoneForDisplay } from "@/lib/channels/phone-variants";

interface Props {
  conversation: ConversationWithContact;
  isSelected: boolean;
  onSelect: (id: string) => void;
  /** Posição 1-based na fila (G5-03). Presente só na visão Fila. */
  queuePosition?: number;
  /**
   * Mostrar o ícone de robô na prévia da mensagem, quando quem manda é o
   * automático. Só quando DISCRIMINA. Na
   * aba "Automático" toda linha já é robô, e o ícone repetido em cada uma vira
   * ruído. Ausente ou `true` = mostra (comportamento anterior, seguro para o
   * teste que não passa esta prop).
   */
  mostrarAutomatico?: boolean;
  /**
   * A org tem atendimento automático de pé? Vem por PROP e não por hook: um hook
   * por linha faria 50 assinaturas de query na mesma lista para responder a MESMA
   * pergunta org-wide. `undefined` = "não sei", e a função trata isso como "não
   * afirme nada".
   */
  automaticoDaOrg?: boolean;
  /** Marca esta linha no lote (porte do upstream #2909). */
  selecionado?: boolean;
  /**
   * Liga o modo de seleção: com esta prop a linha ganha a caixa de marcação.
   * Marcar e abrir são gestos separados: quem marca não abre a conversa.
   */
  onAlternarSelecao?: (id: string) => void;
}

function relativeTime(iso: string | null, locale: Locale): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return format(d, "HH:mm");
  const diff = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  if (diff < 7) return formatDistanceToNowStrict(d, { addSuffix: false, locale: locale });
  return format(d, "dd/MM");
}

/**
 * "Aguardando há 5 min" — desde quando o cliente ESPERA.
 *
 * A régua é `esperaDaConversa`, a mesma `awaiting_since` que ordena a Fila
 * (DeskcommCRM #990): `last_inbound_at` é a ÚLTIMA mensagem do cliente, então a
 * pílula de quem insistia voltava para "há 1 min" a cada mensagem dele — o tempo
 * na linha contradizia a posição do lado e a ordem da lista. O fallback segue
 * sendo a criação, para a conversa que nunca recebeu mensagem.
 */
function waitingLabel(
  conversation: ConversationWithContact,
  t: (texto: string) => string = (texto) => texto, locale: Locale,
): string {
  const since = esperaDaConversa(conversation);
  if (!since) return t("Aguardando");
  return `${t("Aguardando")} ${formatDistanceToNowStrict(new Date(since), { addSuffix: true, locale: locale })}`;
}

export function ConversationListItem({
  conversation,
  isSelected,
  onSelect,
  queuePosition,
  mostrarAutomatico = true,
  automaticoDaOrg,
  selecionado = false,
  onAlternarSelecao,
}: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const c = conversation.contacts ?? null;
  const displayName = rotuloDoContato(c, t);
  const phoneFallback = c?.phone_number ? phoneForDisplay(c.phone_number) : displayName;
  const preview = previaNaTela(conversation.last_message_preview?.trim() ?? "", t) || t("Sem mensagens");
  const truncated = preview.length > 60 ? `${preview.slice(0, 60)}…` : preview;
  const naFila = queuePosition !== undefined;
  /**
   * A HORA DO CANTO RESPONDE À MESMA PERGUNTA QUE ORDENA A LISTA.
   *
   * Na Fila a lista sai por TEMPO DE ESPERA (`ORDEM_DA_ESPERA`: `last_inbound_at`
   * crescente), mas a hora do canto era sempre a da última mensagem de QUALQUER
   * lado. Bastava o atendente responder para o número daquela linha pular para
   * agora sem que a linha saísse do lugar: lida de cima para baixo, a coluna de
   * horas saía fora de ordem (#464 — "a lista parece aleatória") embaixo de uma
   * lista que estava certa.
   *
   * Fora da Fila a ordem é por atividade recente, e aí a última mensagem de
   * qualquer lado É a resposta certa — a régua do relógio segue a régua da lista.
   *
   * A origem é a MESMA da pílula "Aguardando há…" (`waitingLabel`), inclusive no
   * fallback: duas respostas para o mesmo "desde quando?" na mesma linha, a 40px
   * de distância, seriam a próxima divergência.
   */
  const horaDaOrdem = naFila
    ? esperaDaConversa(conversation)
    : conversation.last_message_at;
  const time = relativeTime(horaDaOrdem, localeDaData);
  const unread = conversation.unread_count_for_assignee ?? 0;


  /**
   * Quem manda, pela MESMA regra do cabeçalho.
   *
   * `status === 'ai_handling'` era um proxy ruim e foi medido: o único escritor
   * desse status em produção é o botão "Devolver ao automático", então o ícone de
   * robô aparecia só em conversa que já tinha sido escalada E devolvida — nunca
   * na que o automático atendeu do começo ao fim, que é a maioria.
   */
  const { comando } = comandoDaConversa({
    status: conversation.status,
    assigned_to_user_id: conversation.assigned_to_user_id,
    assigned_to_user_name: conversation.assigned_to_user_name ?? null,
    assignee_kind: conversation.assignee_kind ?? null,
    bot_silenced_until: conversation.bot_silenced_until ?? null,
    force_human: c?.force_human ?? null,
    is_blocked: c?.is_blocked ?? null,
    automaticoDaOrg,
  });
  const isAi = comando.quem === "automatico";
  const viaInstagram = conversation.channel === "instagram";
  // A ÚLTIMA MENSAGEM FOI NOSSA? O tique da prévia, como no WhatsApp. A lista
  // só conhece os horários (não o status da mensagem): o tique diz "nossa
  // mensagem", sem afirmar entregue ou lida.
  // ponytail: entregue/lida pedem o status da última mensagem na rota da lista.
  const ultimaFoiNossa =
    conversation.last_outbound_at != null &&
    (conversation.last_inbound_at == null ||
      new Date(conversation.last_outbound_at).getTime() >= new Date(conversation.last_inbound_at).getTime());

  // A LINHA DE APP DE MENSAGEM (pedido do André, 18/11/2026): foto, nome (ou
  // número), hora à direita, prévia com o tique e a bolinha de não lidas. Os
  // selos de etapa, etiqueta, situação e número do canal saíram da linha: moram
  // no painel do contato, no menu ⋯ da conversa e nos filtros. Fica só, na
  // Fila, a posição e a espera — é a régua por que ela é ordenada.
  const linha = (
    <button
      type="button"
      data-conversation-id={conversation.id}
      onClick={() => onSelect(conversation.id)}
      // Linha de app de mensagem: sem borda entre as linhas (o respiro separa),
      // a escolhida com fundo um tom acima e o foco do teclado num anel por dentro.
      className={cn(
        "group relative flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-elevated/60",
        onAlternarSelecao && "min-w-0 flex-1",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        isSelected && "bg-surface-elevated hover:bg-surface-elevated",
      )}
      aria-current={isSelected ? "true" : undefined}
    >
      <div className="relative shrink-0">
        <AvatarDoContato contato={c} nome={displayName} reserva={phoneFallback} className="h-12 w-12" />
        <SeloDoCanal
          canal={viaInstagram ? "instagram" : "whatsapp"}
          tamanho="pequeno"
          className="absolute -bottom-0.5 -left-0.5"
        />
      </div>

      <div className="min-w-0 flex-1">
        {naFila && (
          <div className="mb-0.5 flex items-center gap-1.5">
            <span
              className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent-soft px-1 text-xs font-medium tabular-nums text-text"
              aria-label={`${t("Posição")} ${queuePosition} ${t("na fila")}`}
            >
              {queuePosition}º
            </span>
            <span className="text-xs text-text-muted">
              {waitingLabel(conversation, t, localeDaData)}
            </span>
          </div>
        )}
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "truncate text-[15px] leading-5",
              unread > 0 ? "font-semibold text-text" : "font-medium text-text",
              c?.is_anonymized && "font-normal italic text-text-muted",
            )}
          >
            {displayName}
          </span>
          {/* Na Fila o tempo já está em "Aguardando há…" logo acima: dizê-lo de
              novo aqui era a mesma informação duas vezes na linha (item 212). */}
          {!naFila && (
            <span
              // Com não lidas a hora acende na cor da marca, junto com a bolinha.
              className={cn(
                "shrink-0 text-xs tabular-nums",
                unread > 0 ? "font-semibold text-accent" : "text-text-subtle",
              )}
            >
              {time}
            </span>
          )}
        </div>

        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p
            className={cn(
              "flex min-w-0 items-center gap-1 text-sm leading-5",
              unread > 0 ? "text-text" : "text-text-muted",
            )}
          >
            {ultimaFoiNossa && (
              <Check size={14} weight="bold" className="shrink-0 text-text-subtle" aria-label={t("Sua mensagem")} />
            )}
            {isAi && mostrarAutomatico ? (
              <Robot size={12} weight="duotone" className="shrink-0" aria-label={t("Automático")} />
            ) : null}
            <span className="truncate">{truncated}</span>
          </p>
          {unread > 0 && (
            <span
              className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-semibold tabular-nums text-accent-foreground"
              aria-label={unread === 1 ? t("1 não lida") : t("{n} não lidas").replace("{n}", String(unread))}
            >
              {unread}
            </span>
          )}
        </div>
      </div>
    </button>
  );

  // Sem seleção ligada, a linha é exatamente a de antes.
  if (!onAlternarSelecao) return linha;

  // A caixa fica FORA do botão da linha: controle interativo dentro de
  // `<button>` é HTML inválido, e marcar não pode abrir a conversa.
  return (
    <div
      className={cn(
        "relative flex w-full items-start",
        selecionado && "bg-accent-soft",
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={selecionado}
        // Com o nome (item 215): "Selecionar conversa" vinte vezes não diz qual.
        aria-label={`${t("Selecionar")} ${displayName}`}
        title={`${t("Selecionar")} ${displayName}`}
        data-testid={`selecao-em-lote-${conversation.id}`}
        onClick={() => onAlternarSelecao(conversation.id)}
        className={cn(
          "mt-7 ml-2 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition-colors",
          "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent",
          selecionado
            ? "border-accent bg-accent text-accent-foreground"
            : "border-input bg-background hover:bg-surface-elevated",
        )}
      >
        {selecionado && <Check size={12} weight="bold" aria-hidden />}
      </button>
      {linha}
    </div>
  );
}
