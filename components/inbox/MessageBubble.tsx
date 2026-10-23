"use client";

import { memo, useEffect, useState } from "react";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { format } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { ArrowBendUpLeft, Check, Checks, Clock, Robot, WarningOctagon } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ApiError } from "@/lib/api/types";
import { FRASES_DE_FALHA, fraseDaFalhaDeCanal } from "@/lib/channels/frases-de-falha";
import { reenvioDaMensagem } from "@/lib/messaging/reenvio";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Message } from "@/lib/types/messaging";
import { CitationButton } from "@/components/ai/CitationButton";
import { MediaRenderer } from "@/components/inbox/media/MediaRenderer";
import { MediaUnavailable } from "@/components/inbox/media/MediaUnavailable";
import { ContactCard } from "@/components/inbox/media/ContactCard";
import { resolveSharedContact } from "@/lib/messaging/contact-card";
import {
  extractCitations,
  isAiGeneratedMessage,
} from "@/lib/ai/citations/types";

interface Props {
  message: Message;
  /** A bolha casa com a busca dentro da conversa. */
  searchMatch?: boolean;
  debugCitations?: boolean;
  /** Escolher esta mensagem para responder "em cima" dela. */
  onResponder?: (m: Message) => void;
  /** A mensagem citada por ESTA, quando houver — desenha o fio. */
  citada?: Message | null;
  /**
   * QUEM está lendo a conversa. É o que separa "Você" de "Atendente": a coluna
   * `sent_via='user'` só diz *"um humano digitou no CRM"*, nunca QUAL humano.
   *
   * Sem este id, uma organização com dois atendentes mostrava "Você" nas
   * mensagens do colega — cada um lia o atendimento do outro como se fosse o
   * seu. Por isso a ausência do id NÃO cai em "Você": quem não sabe quem está
   * lendo (a leitura do super-admin em `AdminThread`, por exemplo) rotula
   * "Atendente", que é verdadeiro para todo mundo.
   */
  viewerUserId?: string | null;
  /** Nome de quem da equipe enviou, quando a lista da equipe o conhece. */
  nomeDoAutor?: string | null;
  /**
   * Enviar de novo uma mensagem que falhou ou ficou parada. Só quem tem a
   * conversa na mão passa (o `ChatThread`); a leitura do super-admin não
   * passa, e a bolha não desenha o botão. Quem decide SE a mensagem pode ser
   * reenviada é `reenvioDaMensagem`, a mesma regra da rota. Recebe a mensagem
   * para o `ChatThread` passar UMA função estável e o `memo` seguir valendo.
   */
  onReenviar?: (m: Message, confirmado: boolean) => Promise<void>;
  /** Gerente para cima reenvia mensagem de colega — a mesma régua da rota. */
  podeReenviarDeOutros?: boolean;
}

function AckIndicator({ status, paradaSemConexao, saiSozinha, t }: {
  status: string; paradaSemConexao: boolean; saiSozinha: boolean; t: (texto: string) => string;
}) {
  // Só a linha que o envio PAROU por falta de conexão (`queued_reason`). Todo
  // envio nasce `queued` por um instante; mostrar o relógio nele diria
  // "aguardando" a cada mensagem que sai normalmente.
  if (paradaSemConexao) {
    // "Aguardando" só promete o que acontece: o watchdog reenvia sozinho só a
    // linha da IA quando o número volta; a de pessoa fica com o botão.
    return saiSozinha ? (
      <span className="inline-flex items-center gap-0.5 font-semibold">
        <Clock size={10} weight="bold" aria-hidden /> {t("Aguardando conexão")}
      </span>
    ) : (
      <span className="inline-flex items-center gap-0.5 font-semibold">
        <WarningOctagon size={10} weight="bold" aria-hidden /> {t("Não enviada: sem conexão")}
      </span>
    );
  }
  if (status === "read") {
    return <Checks size={12} weight="bold" className="text-info" aria-label={t("Lida")} />;
  }
  if (status === "delivered") {
    return <Checks size={12} weight="bold" className="text-current/70" aria-label={t("Entregue")} />;
  }
  if (status === "sent") {
    return <Check size={12} weight="bold" className="text-current/70" aria-label={t("Enviada")} />;
  }
  return null;
}

/**
 * Memorizado: o inbox redesenha a cada 30s (relógio da janela de 24h) e a cada
 * releitura da conversa. Sem `memo`, toda bolha da conversa se redesenhava junto.
 * As props chegam estáveis — o react-query preserva a identidade das mensagens
 * que não mudaram — e a bolha tem o próprio relógio para o que depende de hora.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  searchMatch = false,
  debugCitations,
  onResponder,
  citada,
  viewerUserId,
  nomeDoAutor,
  onReenviar,
  podeReenviarDeOutros = false,
}: Props) {
  const [ocupado, setOcupado] = useState(false);
  const [confirmandoReenvio, setConfirmandoReenvio] = useState(false);
  // Relógio de 60s: tira da tela o "Transcrevendo…" vencido sem chamar
  // `Date.now()` no render (DeskcommCRM e5216e26a).
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setAgora(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const localeDaData = useLocaleDeData();
  const t = useT();
  const isOutbound = message.direction === "outbound";
  const time = format(new Date(message.sent_at), "HH:mm", { locale: localeDaData });
  const isFailed = message.status === "failed";
  const hasMedia = Boolean(
    message.media_url || message.media_storage_path || message.media_library_item_id,
  );
  // Item da biblioteca apagado depois do envio: a FK zera e só a variante resta.
  const semMidiaDaBiblioteca =
    !hasMedia &&
    (message.type === "image" || message.type === "video") &&
    Boolean((message.metadata as { media_variant?: unknown } | null)?.media_variant);
  // A retenção marcou `metadata.media_status = 'expired'` (migration 0341) e a
  // poda anulou os DOIS campos — a partir daí `hasMedia` é false e esta mensagem
  // de mídia perde o render. O aviso é o do issue #1534.
  const mediaExpirada = (message.metadata as Record<string, unknown> | null)?.media_status === "expired";
  // O texto do aviso carrega os DIAS que a organização configurou — a 0341
  // guarda `media_retention_days` (já com o piso de 30) junto do marcador,
  // porque a bolha não tem acesso à configuração da organização e "por política"
  // sem o número é uma promessa sem medida. Sem o campo (mensagem marcada por
  // uma versão anterior), o aviso genérico.
  const diasDaRetencao = (() => {
    const meta = message.metadata as Record<string, unknown> | null;
    return typeof meta?.media_retention_days === "number" ? meta.media_retention_days : null;
  })();
  const avisoDeExpiracao =
    diasDaRetencao !== null
      ? t("Mídia apagada pela política de retenção ({n} dias)").replace("{n}", String(diasDaRetencao))
      : t("Mídia apagada pela política de retenção.");
  const isContact = message.type === "contact";
  // Figurinha sem caption: sem moldura de bolha (padrão WhatsApp).
  const isBareSticker = hasMedia && message.type === "sticker" && !message.body;
  // Apagada pelo autor ("apagar para todos"). A linha continua no histórico —
  // sumir com ela deixaria a resposta seguinte respondendo ao nada —, mas o
  // texto não aparece: mostrá-lo seria expor justamente o que o cliente pediu
  // para tirar do ar.
  const apagada = Boolean(message.revoked_at);
  const editada = Boolean(message.edited_at) && !apagada;
  const reenvio = onReenviar
    ? reenvioDaMensagem(message, { userId: viewerUserId, podeReenviarDeOutros, agora })
    : "nenhum";
  const paradaSemConexao = message.status === "queued" && Boolean(message.metadata?.queued_reason)
    && !message.metadata?._optimistic;
  // O MOTIVO à vista, e não só no Tooltip: o dedo não abre Tooltip. O texto
  // cru do canal fica fora daqui — ele pode trazer endereço interno do serviço.
  const codigoDaFalha = message.error_code ?? "";
  const motivoDaFalha = fraseDaFalhaDeCanal(codigoDaFalha)
    ? t(FRASES_DE_FALHA[codigoDaFalha] as string)
    : t("Não foi possível enviar esta mensagem.");
  const aiGenerated = isAiGeneratedMessage(message.metadata);
  const citations = extractCitations(message.metadata);
  const showCitationButton =
    isOutbound && aiGenerated && (debugCitations ?? false);
  // De quem saiu esta linha. `external_device` é a resposta pelo CELULAR — o
  // operador atendeu pelo WhatsApp do telefone, fora do CRM, e o ingest carimba
  // aqui. Antes isto voltava null para tudo que não fosse IA, e a bolha ficava
  // sem nome: o dono lia a conversa como se tudo tivesse sido digitado no CRM.
  // Os rótulos passam por t() no render (ver dicionario.ts para o espanhol).
  //
  // NÃO HÁ RAMO PARA `'automation'`. O CHECK do banco aceita o valor e o union
  // de `Message` o declara, mas nenhuma linha de app/, lib/ ou workers/ o
  // grava: as ações de automação chamam `sendMessageHandler` com
  // `actor.type === "webhook_source"`, e `_handler.ts` carimba `'ai'` em tudo
  // que não é `"user"`. Um ramo aqui seria controle decorativo — a tela
  // prometendo uma distinção que o motor não faz. Carimbar `'automation'` na
  // origem é decisão de produto com efeito colateral medido (o dedup de eco da
  // ingestão de canal filtra `sent_via in ('ai','user')`, e o valor novo
  // duplicaria a mensagem na conversa), então fica para uma issue própria.
  // Vigiado nas duas direções por tests/unit/rotulo-de-origem-tem-emissor.
  const senderLabel = (() => {
    if (!isOutbound) return null;
    if (message.sent_via === "ai") {
      // Texto escrito pela organização e enviado SEM modelo
      // (`lib/agent-engine/agent/resposta-pronta.ts` carimba a metadata). O
      // atendente precisa saber que não foi a IA nem uma pessoa.
      return typeof message.metadata?.resposta_pronta_id === "string" ? "Resposta pronta" : "IA";
    }
    if (message.sent_via === "external_device") return "Celular";
    if (message.sent_via === "user" || message.sent_via === "crm") {
      // "Você" exige as DUAS pontas: saber quem lê e saber quem enviou. Falta
      // qualquer uma, o rótulo cai para "Atendente" — que continua dizendo o
      // que `sent_via` de fato garante (um humano, pelo CRM) sem afirmar uma
      // identidade que o dado não sustenta.
      return viewerUserId != null && message.sent_by_user_id === viewerUserId
        ? "Você"
        : "Atendente";
    }
    return null;
  })();

  async function reenviar(confirmado: boolean) {
    if (!onReenviar || ocupado) return;
    setOcupado(true);
    try { await onReenviar(message, confirmado); setConfirmandoReenvio(false); }
    catch (err) {
      // A rota viu "pode ter chegado" onde a bolha viu "nada saiu": pergunta antes.
      // Os outros erros o hook mostra; a bolha continua com o botão.
      if (err instanceof ApiError && err.code === "confirmacao_necessaria") setConfirmandoReenvio(true);
    }
    finally { setOcupado(false); }
  }

  return (
    <div
      data-search-match={searchMatch || undefined}
      className={cn(
        "group flex w-full min-w-0 items-center gap-1 px-4 py-1",
        isOutbound ? "justify-end" : "justify-start",
      )}
    >
      {/*
        RESPONDER — aparece ao passar o mouse, como no WhatsApp Web.
        Fica FORA da bolha para não disputar espaço com o texto, e do lado de
        dentro da conversa (à esquerda no que sai, à direita no que entra), que
        é onde a mão já está.

        `opacity` e não `hidden`: esconder de verdade faria o layout pular
        quando o mouse entra. Em telas de toque não há hover — por isso
        `focus-visible` também revela, e o teclado alcança.
      */}
      {onResponder && isOutbound && (
        <button
          type="button"
          onClick={() => onResponder(message)}
          aria-label={t("Responder a esta mensagem")}
          className={cn(
            "rounded-md p-1 text-muted-foreground transition-opacity hover:bg-muted",
            // VISÍVEL POR PADRÃO, e escondido só onde EXISTE hover.
            //
            // A primeira versão era `opacity-0` + `group-hover`, copiando o
            // WhatsApp Web. No celular isso deixa o botão invisível para
            // sempre: não há como passar o mouse, e `focus-visible` só chega
            // por teclado. Ou seja, a função sumia exatamente onde o dono
            // deste CRM mais atende.
            //
            // `@media (hover: hover)` pergunta pelo DISPOSITIVO, não pela
            // largura: um tablet largo com toque continua mostrando, e um
            // desktop estreito continua escondendo. Largura não é a pergunta.
            "opacity-100 [@media(hover:hover)]:opacity-0",
            "[@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100",
          )}
        >
          <ArrowBendUpLeft size={14} />
        </button>
      )}
      <div
        // Identidade, não aparência: specs contam bolhas por este id, não pela classe.
        data-testid="message-bubble"
        className={cn(
          "max-w-[75%] min-w-0 text-sm",
          isBareSticker
            ? "px-0 py-0"
            : cn(
                "rounded-2xl px-3 py-2",
                // Três vozes, três tons — quem lê a conversa precisa saber de
                // relance se foi o paciente, o automático ou alguém da equipe:
                // paciente em branco sobre o fundo creme; automático em verde
                // claro; equipe no verde da marca.
                //
                // Paciente e equipe aceitam a cor que CADA PESSOA escolheu em
                // "Aparência da conversa" (variáveis postas pelo ChatThread); o
                // segundo termo do `var()` é o desenho de sempre, para quem
                // nunca escolheu e para onde a bolha é usada fora do Inbox. O
                // automático fica fixo: é a terceira voz, e trocá-lo junto
                // apagaria a diferença entre robô e gente.
                !isOutbound
                  ? "rounded-bl-sm border border-border bg-[var(--bolha-recebida-fundo,var(--color-surface))] text-[var(--bolha-recebida-texto,var(--color-text))]"
                  : message.sent_via === "ai"
                    ? "rounded-br-sm border border-accent/25 bg-accent-soft text-text"
                    : "rounded-br-sm bg-[var(--bolha-enviada-fundo,var(--primary))] text-[var(--bolha-enviada-texto,var(--primary-foreground))]",
              ),
          isFailed && "border border-destructive",
          // Apagada sai das cores da DIREÇÃO e vai para o CINZA: a diferença
          // entre o que foi apagado e o que está vivo tem de ser vista de
          // relance, e o fundo é justamente o que diz de quem é a mensagem —
          // trocá-lo é o ponto. (Porte do DeskcommCRM #3279.)
          apagada && "bg-muted/60 text-muted-foreground ring-1 ring-border",
          // A marca da busca é ANEL, não cor de fundo: o fundo já diz de quem é
          // a mensagem, e trocá-lo apagaria essa leitura justo na bolha achada.
          searchMatch && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
        )}
      >
        {/*
          A CITAÇÃO, dentro da bolha e acima do texto — o fio.

          Mostra de quem era e um trecho. `line-clamp-2` porque serve para
          reconhecer, não para reler: a original está logo acima no histórico.
        */}
        {citada && (
          <div
            className={cn(
              "mb-1 rounded-md border-l-2 px-2 py-1 text-xs",
              // `current`, e não a cor da marca: o texto da bolha da equipe agora
              // muda com a aparência escolhida, e a citação acompanha.
              isOutbound
                ? "border-current/50 bg-current/10"
                : "border-primary bg-background/60",
            )}
          >
            <div className="font-medium opacity-80">
              {citada.direction === "outbound" ? t("Você") : t("Cliente")}
            </div>
            {/*
              A CITADA PODE TER SIDO APAGADA — e aí o texto dela não volta aqui.

              A bolha principal já trata isto (`apagada`, acima): "mostrá-lo
              seria expor justamente o que o cliente pediu para tirar do ar". A
              citação é o mesmo texto, num segundo lugar da tela — sem esta
              linha, o "apagar para todos" do cliente sumia da bolha original e
              continuava legível dentro de cada resposta que a citou. O fio
              permanece (a citação some, não a resposta); o conteúdo, não.
            */}
            <div className={cn("line-clamp-2 wrap-anywhere opacity-70", citada.revoked_at && "italic")}>
              {citada.revoked_at
                ? t("Esta mensagem foi apagada")
                : citada.type === "contact"
                  ? resolveSharedContact(citada)?.name || t("Contato")
                  : citada.body?.trim() || t("(sem texto)")}
            </div>
          </div>
        )}
        {senderLabel && (
          <div className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold opacity-80">
            {senderLabel === "IA" ? (
              <Robot size={10} weight="duotone" aria-hidden />
            ) : null}
            {senderLabel && t(senderLabel)}
            {/* O NOME de quem respondeu, ao lado do papel: "Atendente" sozinho
                não dizia quem da equipe falou com o paciente. */}
            {senderLabel === "Atendente" && nomeDoAutor ? ` · ${nomeDoAutor}` : null}
          </div>
        )}

        {apagada ? (
          // Nem corpo nem mídia: o anexo apagado também sai. Em itálico e
          // esmaecido porque não é texto de ninguém — é o CRM narrando o que
          // aconteceu com aquele lugar da conversa.
          // O marcador diz QUEM apagou: a recebida, o contato; a enviada, a
          // equipe (pelo celular do número). O texto continua fora da tela nos
          // dois sentidos.
          <p className="whitespace-pre-wrap wrap-anywhere italic leading-snug opacity-80">
            {isOutbound ? t("Esta mensagem foi apagada pelo atendente") : t("Esta mensagem foi apagada pelo contato")}
          </p>
        ) : (
          <>
            {hasMedia && (
              <div className={cn(message.body && "mb-1")}>
                <MediaRenderer message={message} agora={agora} />
              </div>
            )}

            {semMidiaDaBiblioteca && (
              <p className="text-xs italic text-muted-foreground">{t("Mídia removida da biblioteca")}</p>
            )}

            {!hasMedia && mediaExpirada && (
              <div className={cn(message.body && "mb-1")}>
                <MediaUnavailable kind={avisoDeExpiracao} />
              </div>
            )}

            {isContact && !hasMedia && !mediaExpirada && (
              <div className={cn(message.body && isContact && "mb-1")}>
                <ContactCard message={message} />
              </div>
            )}

            {message.body && !isContact && (
              <p className="whitespace-pre-wrap wrap-anywhere leading-snug">{message.body}</p>
            )}
          </>
        )}

        <div
          className={cn(
            "mt-1 flex items-center justify-end gap-1 text-[10px]",
            // Só o balão da equipe é escuro; o do automático é claro e pede texto escuro.
            // A apagada é cinza: o carimbo claro da equipe sumiria nela.
            !apagada && isOutbound && message.sent_via !== "ai"
              ? "text-[var(--bolha-enviada-texto,var(--primary-foreground))]"
              : "text-muted-foreground",
          )}
        >
          {editada && (
            // Ao lado da hora, não no corpo: o texto mostrado JÁ é o novo, e o
            // que falta é avisar que ele mudou. Sem isso, um combinado de preço
            // ou endereço é lido como se sempre tivesse dito aquilo — e a
            // divergência só aparece quando alguém cobra o que não foi.
            <span title={t("O autor editou esta mensagem")}>{t("editada")}</span>
          )}
          <span>{time}</span>
          {showCitationButton && (
            <CitationButton citations={citations} messageId={message.id} />
          )}
          {isOutbound && !isFailed && <AckIndicator status={message.status} paradaSemConexao={paradaSemConexao}
            saiSozinha={message.sent_via === "ai"} t={t} />}
          {isFailed && (
            // Provider local: o painel do inbox não tem TooltipProvider ancestral e
            // este Tooltip só monta em mensagem failed — sem o provider, abrir uma
            // conversa com falha de envio derrubava o painel inteiro (error boundary).
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-0.5 font-semibold text-destructive">
                    <WarningOctagon size={10} weight="fill" aria-hidden /> {t("Falhou")}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {message.error_message ? t(message.error_message) : (message.error_code ?? t("Erro desconhecido"))}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        {(isFailed || reenvio !== "nenhum") && (
          <div className="mt-1.5 space-y-1.5 border-t border-current/20 pt-1.5">
            {isFailed && <p data-testid="motivo-da-falha" className="text-xs leading-snug">{motivoDaFalha}</p>}
            {reenvio !== "nenhum" && (
              <Button size="sm" variant="secondary" disabled={ocupado}
                onClick={() => (reenvio === "confirmar" ? setConfirmandoReenvio(true) : void reenviar(false))}>
                {t("Tentar de novo")}
              </Button>
            )}
          </div>
        )}
      </div>
      {onResponder && !isOutbound && (
        <button
          type="button"
          onClick={() => onResponder(message)}
          aria-label={t("Responder a esta mensagem")}
          className={cn(
            "rounded-md p-1 text-muted-foreground transition-opacity hover:bg-muted",
            // VISÍVEL POR PADRÃO, e escondido só onde EXISTE hover.
            //
            // A primeira versão era `opacity-0` + `group-hover`, copiando o
            // WhatsApp Web. No celular isso deixa o botão invisível para
            // sempre: não há como passar o mouse, e `focus-visible` só chega
            // por teclado. Ou seja, a função sumia exatamente onde o dono
            // deste CRM mais atende.
            //
            // `@media (hover: hover)` pergunta pelo DISPOSITIVO, não pela
            // largura: um tablet largo com toque continua mostrando, e um
            // desktop estreito continua escondendo. Largura não é a pergunta.
            "opacity-100 [@media(hover:hover)]:opacity-0",
            "[@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100",
          )}
        >
          <ArrowBendUpLeft size={14} />
        </button>
      )}
      <AlertDialog open={confirmandoReenvio} onOpenChange={setConfirmandoReenvio}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Enviar esta mensagem de novo?")}</AlertDialogTitle>
            <AlertDialogDescription>{t("Pode ser que esta mensagem já tenha chegado. Confira no WhatsApp do cliente antes de enviar de novo.")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={ocupado}>{t("Cancelar")}</AlertDialogCancel>
            <Button disabled={ocupado} onClick={() => void reenviar(true)}>{t("Enviar de novo")}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});
