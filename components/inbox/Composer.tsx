"use client";
import { useT } from "@/hooks/i18n/useT";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { DotsThree, PaperPlaneTilt } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { AttachMenu } from "@/components/inbox/composer/AttachMenu";
import { AttachmentPreviewDialog } from "@/components/inbox/composer/AttachmentPreviewDialog";
import {
  RespostaComImagensDialog,
  type ImagemDaResposta,
} from "@/components/inbox/composer/RespostaComImagensDialog";
import { ContactPickerDialog } from "@/components/inbox/composer/ContactPickerDialog";
import { AudioRecorder } from "@/components/inbox/composer/AudioRecorder";
import { ReplyReviewPanel } from "@/components/inbox/composer/ReplyReviewPanel";
import { DraftReplyButton } from "@/components/inbox/composer/DraftReplyButton";
import { EmojiButton } from "@/components/inbox/composer/EmojiButton";
import {
  MentionMenu,
  opcoesDeMencao,
  resolverMencao,
  type OpcaoDeMencao,
} from "@/components/inbox/composer/MentionMenu";
import { resolveSlash, TemplateMenu } from "@/components/inbox/composer/TemplateMenu";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useCreateNote } from "@/hooks/inbox/useCreateNote";
import { useMessageTemplates, type MessageTemplate } from "@/hooks/inbox/useMessageTemplates";
import { useRascunhoAssistido } from "@/hooks/inbox/useRascunhoAssistido";
import { BarraDeRecursos } from "@/components/inbox/composer/BarraDeRecursos";
import { X } from "lucide-react";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import { useUploadMedia, type DestinoDoUpload } from "@/hooks/inbox/useUploadMedia";
import { imagemDoClipboard } from "@/lib/inbox/clipboard-image";
import {
  interpolateTemplate,
  motivoDoCuringaLiteral,
  payloadDeUso,
  type TemplateContact,
} from "@/lib/inbox/template-vars";
import { ApiError } from "@/lib/api/types";
import { embutirMencoes, podarMencoes, type MencaoEscolhida } from "@/lib/notifications/mentions";
import { cn } from "@/lib/utils";
import { classeDaFaixa, useRevelacao } from "@/hooks/inbox/useRevelacao";
import { resolveSharedContact } from "@/lib/messaging/contact-card";

export interface ComposerHandle {
  focus: () => void;
}

interface Props {
  conversationId: string;
  disabled?: boolean;
  /** Set true when contact is blocked / anonymized — explanation shown. */
  blockedReason?: string | null;
  /**
   * Janela de 24h fechada: barra a RESPOSTA, e só ela.
   *
   * Separado de `blockedReason` porque a nota interna nunca chega ao cliente —
   * a regra da plataforma não a alcança, e barrá-la tira do atendente
   * justamente o lugar onde ele registra por que a conversa esfriou. A primeira
   * versão deste bloqueio usava `blockedReason` e levou a nota junto.
   */
  janelaFechada?: string | null;
  /**
   * O canal desta conversa só RECEBE (capability `canSend: false`): barra a
   * resposta, como a janela, e mostra o motivo. A nota interna segue livre.
   */
  semEnvio?: string | null;
  /**
   * Limite de caracteres do canal (Instagram: 1000, capability
   * `limiteDeTexto`). `null`/ausente = sem limite, sem contador — inventar
   * uma régua que o WhatsApp não tem seria ruído.
   */
  limiteDeTexto?: number | null;
  /**
   * Canal que só manda foto (Instagram: `midiaDeEnvio: "so_foto"`). Some o
   * gravador de áudio — o Direct não aceita o ogg/opus que ele grava — e
   * repassa ao `AttachMenu`, que reduz o menu "+" a "Fotos".
   */
  soFoto?: boolean;
  /**
   * A mensagem que esta resposta CITA, quando o atendente escolheu responder
   * "em cima" de uma. `null` = envio solto, o caso comum.
   *
   * Vem de fora e não daqui porque quem escolhe é a lista de mensagens: o
   * composer só precisa mostrar o que foi escolhido e mandá-lo junto.
   */
  respondendo?: {
    id: string;
    body: string | null;
    direction: string;
    /** Com `type: "contact"` a faixa mostra o nome do contato, e não o vCard bruto. */
    type?: string;
    metadata?: Record<string, unknown>;
  } | null;
  /** Desfaz a escolha — o `x` da faixa de citação. */
  onCancelarResposta?: () => void;
  /** Contato da conversa (name + display_name), para interpolar {{nome}}/{{primeiro_nome}}
   *  do template escolhido. O helper resolve o nome — não resolva aqui. */
  contact?: TemplateContact | null;
  /** Contato da conversa — excluído do seletor de cartão compartilhado. */
  currentContactId?: string | null;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  {
    conversationId,
    disabled,
    blockedReason,
    janelaFechada,
    semEnvio,
    limiteDeTexto,
    soFoto,
    contact,
    currentContactId,
    respondendo,
    onCancelarResposta,
  },
  ref,
) {
  const t = useT();
  const [text, setText] = useState("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  /**
   * A resposta rápida com imagens da Biblioteca de mídia escolhida, à espera da
   * prévia (portado do original, DeskcommCRM PR #2704). O texto vira legenda.
   */
  const [respostaComImagens, setRespostaComImagens] = useState<{
    templateId: string;
    legenda: string;
    imagens: ImagemDaResposta[];
  } | null>(null);
  /**
   * O modo em que o arquivo foi ESCOLHIDO, congelado na escolha — e não o modo
   * em que o diálogo está aberto agora. Sem isto, um anexo escolhido em "Nota
   * interna" e enviado depois de trocar para "Responder" sairia pela rota de
   * MENSAGEM e iria para o cliente.
   */
  const [pendingEm, setPendingEm] = useState<"reply" | "note">("reply");
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [mode, setMode] = useState<"reply" | "note">("reply");
  /**
   * Menção de atendente em nota interna (portado do DeskcommCRM, PRs #2461,
   * #2489 e #2586 de @webtecnica e @Tong-bit-art). `caret` porque o `@` é
   * relativo ao cursor; `mencoes` é o que foi ESCOLHIDO na lista — o campo
   * mostra o nome, e o id entra só quando o corpo sai (`embutirMencoes`).
   */
  const [caret, setCaret] = useState(0);
  const [mencoes, setMencoes] = useState<MencaoEscolhida[]>([]);
  const [mencaoDispensada, setMencaoDispensada] = useState(false);
  const [mencaoIndice, setMencaoIndice] = useState(0);
  /**
   * A FAIXA DE CIMA DO CAMPO (assistência do agente + Responder/Nota interna)
   * fica recolhida até ser pedida — pelo mouse, pelo foco ou pelo botão de
   * faísca ao lado do emoji. Ela comia ~70px da conversa o tempo todo, e no
   * celular empurrava o campo para baixo da dobra.
   *
   * Recolher NUNCA esconde estado: em "Nota interna" ou com sugestão para
   * revisar ela fica aberta e no fluxo (`forcado`), porque escrever achando que
   * é nota quando é resposta ao cliente é o erro que não tem volta.
   */
  // "Há sugestão" é a MESMA consulta que o `ReplyReviewPanel` lê (porte do
  // original #3234): uma chave, um cache, sem um segundo estado para divergir.
  // Desligada em nota e com o compositor bloqueado (o GET exige `agent`; quem
  // só lê levaria 403 a cada 4s).
  const { sugestao, invalidar } = useRascunhoAssistido(
    conversationId,
    mode === "reply" && !blockedReason,
  );
  const temSugestao = !!sugestao;
  const ferramentas = useRevelacao({
    forcado: mode === "note" || temSugestao,
    chave: conversationId,
  });
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // A citação ATUAL, para o `onSuccess` de um envio que já saiu comparar com a
  // que foi junto com ele (ver `handleSubmit`).
  const respondendoAgora = useRef(respondendo?.id ?? null);
  useEffect(() => {
    respondendoAgora.current = respondendo?.id ?? null;
  }, [respondendo?.id]);
  const send = useSendMessage();
  const upload = useUploadMedia();
  const createNote = useCreateNote();
  const templates = useMessageTemplates();
  const slash = resolveSlash(text);
  const menuOpen = mode === "reply" && slash.open && !menuDismissed;

  // SÓ em nota: menção no campo de resposta sairia para o cliente.
  const gatilho = mode === "note" && !mencaoDispensada ? resolverMencao(text, caret) : null;
  const membros = useAssignableMembers(gatilho !== null);
  const opcoes = gatilho ? opcoesDeMencao(membros.data ?? [], gatilho.query, t) : [];
  const mencaoAberta = gatilho !== null;
  const opcaoAtual = opcoes[mencaoIndice] ?? opcoes[0];

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
  }));

  // send/createNote fora do disable: o texto some na hora do envio; travar o campo
  // até a API voltar impedia digitar a próxima mensagem com o campo ainda cheio.
  const isDisabled = disabled || !!blockedReason || upload.isPending;
  // A janela só alcança o que SAI. Em modo nota o composer segue liberado: a
  // nota interna nunca chega ao cliente, e é onde o atendente registra por que
  // a conversa esfriou — barrá-la tira exatamente o que ainda dá para fazer.
  // Acima do limite do canal (Instagram: 1000 caracteres), o envio trava —
  // inclusive pelo Enter, que passa pelo MESMO `handleSubmit`.
  const acimaDoLimite = mode === "reply" && !!limiteDeTexto && text.length > limiteDeTexto;
  const respostaBarrada =
    isDisabled ||
    (mode === "reply" && !!janelaFechada) ||
    (mode === "reply" && !!semEnvio) ||
    acimaDoLimite;
  // O CURINGA DE NOME LITERAL (porte do upstream #2844, issue
  // #2744): contato sem nome + `{{nome}}`/`{{primeiro_nome}}` no texto iria cru
  // para o cliente. É um sinal IRMÃO do `respostaBarrada`, e não um termo a mais
  // nele: aquele desabilita o CAMPO, e aqui a instrução é justamente editar. Só
  // o ENVIO é barrado, só em resposta (a nota interna não sai para o cliente).
  const motivoCuringa = mode === "reply" ? motivoDoCuringaLiteral(text, contact ?? {}) : null;
  const envioBarrado = respostaBarrada || !!motivoCuringa;

  /** Escolhe o arquivo e MARCA o modo da escolha (ver `pendingEm`). */
  function escolherArquivo(file: File) {
    setPendingFile(file);
    setPendingEm(mode);
  }

  function autoresize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  /** Escolhe da lista e escreve o NOME no campo; o id entra só ao salvar. */
  function escolherMencao(opcao: OpcaoDeMencao): void {
    const gatilhoAqui = resolverMencao(text, caret);
    if (!gatilhoAqui) return;
    const inserido = `@${opcao.rotulo} `;
    setText(text.slice(0, gatilhoAqui.start) + inserido + text.slice(caret));
    setMencoes((atual) => [...atual, { id: opcao.membro.user_id, nome: opcao.rotulo }]);
    const pos = gatilhoAqui.start + inserido.length;
    setCaret(pos);
    setMencaoIndice(0);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(pos, pos);
      autoresize();
    });
  }

  function handleSubmit() {
    const body = text.trim();
    if (!body || (mode === "note" ? isDisabled : envioBarrado)) return;

    setText("");
    requestAnimationFrame(() => autoresize());

    // Se a pessoa já começou a próxima resposta, preserve os dois textos.
    const restaurar = (current: string) => (current ? `${body}\n${current}` : body);
    const restoreOnError = () => {
      setText(restaurar);
      requestAnimationFrame(() => autoresize());
    };

    if (mode === "note") {
      // As escolhas DESTA nota: o campo segue editável durante o envio.
      const mencoesEnviadas = mencoes;
      createNote.mutate(
        { conversation_id: conversationId, body: embutirMencoes(body, mencoes) },
        {
          onError: () => {
            restoreOnError();
            const restaurado = restaurar(taRef.current?.value ?? "");
            setMencoes((atual) =>
              podarMencoes(restaurado, [...mencoesEnviadas, ...atual.filter((m) => !mencoesEnviadas.includes(m))]),
            );
          },
          // Só as escolhas DESTA nota: a lista pode já ter a menção da próxima.
          onSuccess: () => setMencoes((atual) => atual.filter((m) => !mencoesEnviadas.includes(m))),
        },
      );
      return;
    }
    const citadaNoEnvio = respondendo?.id ?? null;
    // O curinga DIGITADO interpola como o template aplicado (porte do upstream
    // #2920, issue #2891): quem escreve `{{primeiro_nome}}` à mão quer o nome do
    // cliente, não o token cru. Mesma `interpolateTemplate` e mesmo `contact` do
    // `applyTemplate` e da trava acima. A nota interna (acima) segue como escrita,
    // e o `restoreOnError` devolve o texto digitado, não o interpolado.
    send.mutate(
      {
        conversation_id: conversationId,
        body: interpolateTemplate(body, contact ?? {}),
        type: "text",
        ...(respondendo ? { reply_to_message_id: respondendo.id } : {}),
      },
      {
        onSuccess: () => {
          // O campo já foi limpo no envio. Limpar de novo aqui apagava o que a
          // atendente começou a digitar enquanto esta saía (DeskcommCRM f82545d00).
          // A citação vale para UMA mensagem. Mantê-la depois do envio faria a
          // próxima frase sair citando algo que o atendente já respondeu. Mas
          // só sai a que foi JUNTO: a escolhida para o rascunho seguinte,
          // enquanto este envio estava no ar, é do rascunho (revisão do #134).
          if (citadaNoEnvio && respondendoAgora.current === citadaNoEnvio) onCancelarResposta?.();
          requestAnimationFrame(() => autoresize());
        },
        // Do upstream, e fica: sem isto o texto some quando o envio falha, e
        // quem escreveu um parágrafo o perde sem ter como recuperá-lo.
        onError: restoreOnError,
      },
    );
  }

  function applyTemplate(t: MessageTemplate) {
    const payload = payloadDeUso(t, contact ?? {});
    // Com imagens, em resposta ao cliente e com envio liberado: prévia com as
    // imagens e o texto como legenda. Nota interna, ou resposta barrada, segue
    // só com o texto no campo (item da biblioteca não vai para nota).
    if (payload.midias.length > 0 && mode === "reply" && !respostaBarrada) {
      // O "/atalho" digitado sai do campo: o texto agora mora na legenda.
      setText("");
      setMenuDismissed(true);
      setRespostaComImagens({
        templateId: t.id,
        legenda: payload.texto,
        imagens: payload.midias.map((itemId, indice) => ({ itemId, indice })),
      });
      return;
    }
    const filled = payload.texto;
    setText(filled);
    setMenuDismissed(true);
    const ta = taRef.current;
    if (!ta) return;
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = filled.length;
      autoresize();
    });
  }

  /** Devolve o texto ao campo (cancelar a prévia não perde o que foi escolhido). */
  function textoDeVoltaAoCampo(conteudo: string) {
    setText(conteudo);
    const ta = taRef.current;
    if (!ta) return;
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = conteudo.length;
      autoresize();
    });
  }

  /**
   * Envia as imagens da resposta rápida UMA A UMA, pelo envio de item da
   * biblioteca (`media_library_item_id`), que resolve o arquivo e confere o
   * termo de uso de imagem. A legenda vai com a primeira que SAIR. Item que o
   * servidor recusa (sem termo, termo vencido, sem arquivo) é PULADO com o
   * aviso do próprio envio, e as outras seguem; qualquer outra falha para a
   * fila e deixa a prévia aberta com o que faltou. Se nenhuma imagem saiu, o
   * texto sai sozinho — ele não some junto com elas.
   */
  async function enviarRespostaComImagens(legenda: string) {
    const atual = respostaComImagens;
    if (!atual) return;
    let legendaPendente = legenda;
    const restantes = [...atual.imagens];
    while (restantes.length > 0) {
      const img = restantes[0]!;
      try {
        await send.mutateAsync({
          conversation_id: conversationId,
          type: "image",
          media_library_item_id: img.itemId,
          ...(legendaPendente ? { body: legendaPendente } : {}),
        });
        legendaPendente = "";
      } catch (err) {
        const pulavel = err instanceof ApiError && err.status === 422;
        if (!pulavel) {
          setRespostaComImagens({ ...atual, legenda: legendaPendente, imagens: restantes });
          return;
        }
      }
      restantes.shift();
    }
    if (legendaPendente) {
      try {
        await send.mutateAsync({ conversation_id: conversationId, body: legendaPendente });
      } catch {
        setRespostaComImagens(null);
        textoDeVoltaAoCampo(legendaPendente);
        return;
      }
    }
    setRespostaComImagens(null);
  }

  /**
   * Ctrl/Cmd+V com imagem no clipboard cai no MESMO caminho do menu "+":
   * abre o preview com legenda e envia por ali. Nada de atalho paralelo — a
   * validação, o toast de erro e o retry já vivem lá.
   *
   * As DUAS guardas antes de olhar o clipboard não são zelo: com um anexo já em
   * preview a colagem substituiria em silêncio o que o operador escolheu, e
   * desabilitado é desabilitado. Em qualquer um desses casos o Ctrl+V precisa
   * continuar sendo o Ctrl+V de sempre.
   *
   * O MODO saiu da guarda (#1863, F3): "Nota interna" passou a aceitar anexo,
   * e a imagem colada ali vira exatamente o mesmo preview de sempre — com o
   * modo congelado na escolha (`escolherArquivo`), para ela não escapar para o
   * cliente se o operador trocar de aba no meio. `respostaBarrada` já cobre os
   * dois modos: em nota ele é só `isDisabled` (a janela fechada barra a
   * RESPOSTA, e só ela — a nota continua sendo o lugar onde se registra por que
   * a conversa esfriou).
   */
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (respostaBarrada || pendingFile) return;
    const imagem = imagemDoClipboard(e.clipboardData, new Date());
    if (!imagem) return; // colagem de texto segue o caminho normal do browser
    e.preventDefault();
    escolherArquivo(imagem);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && menuOpen) {
      setMenuDismissed(true);
      return;
    }
    // Com a lista de menções aberta, Enter escolhe — não envia.
    if (mencaoAberta) {
      if (e.key === "Escape") {
        setMencaoDispensada(true);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMencaoIndice((i) => (opcoes.length ? (i + 1) % opcoes.length : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMencaoIndice((i) => (opcoes.length ? (i - 1 + opcoes.length) % opcoes.length : 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (opcaoAtual) escolherMencao(opcaoAtual);
        return;
      }
      if (e.key === "Tab" && opcaoAtual) {
        e.preventDefault();
        escolherMencao(opcaoAtual);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (menuOpen) {
        e.preventDefault(); // deixa o Enter pro menu; não envia /query como mensagem
        return;
      }
      // No toque (porte do original #3191), a tecla de retorno do teclado
      // virtual QUEBRA LINHA, como no próprio WhatsApp; quem envia é o botão.
      // Ctrl/Cmd+Enter envia sempre (iPad com teclado físico). Lido aqui, no
      // keydown, e não no render: o servidor não sabe o ponteiro.
      const forcaEnvio = e.ctrlKey || e.metaKey;
      if (!forcaEnvio && window.matchMedia?.("(pointer: coarse)").matches) return;
      e.preventDefault();
      handleSubmit();
    }
  }

  if (blockedReason) {
    return (
      <div className="border-t border-border bg-muted/40 px-4 py-3 text-center text-xs text-muted-foreground">
        {blockedReason}
      </div>
    );
  }

  return (
    <>
      <div
        {...ferramentas.zonaProps}
        className={cn(
          "relative border-t border-border bg-bg px-3 py-2.5",
          mode === "note" && "border-warning/40 bg-warning-bg",
        )}
      >
        <TemplateMenu
          open={menuOpen}
          query={slash.query}
          templates={templates.data ?? []}
          onPick={applyTemplate}
          onClose={() => setMenuDismissed(true)}
        />
        <MentionMenu
          open={mencaoAberta}
          opcoes={opcoes}
          indice={opcaoAtual ? opcoes.indexOf(opcaoAtual) : 0}
          onPick={escolherMencao}
        />
        <div
          {...ferramentas.painelProps}
          role="group"
          aria-label={t("Assistência do agente e nota interna")}
          className={cn(
            ferramentas.noFluxo
              ? "mb-1.5"
              : "absolute inset-x-0 bottom-full z-20 border-t border-border bg-bg px-3 pt-2 pb-1.5 shadow-md",
            classeDaFaixa(ferramentas.visivel),
          )}
        >
        {/* O bloco só existe COM sugestão (#3234): sem ela, quem oferece o gesto
            é o ícone "Sugerir resposta" da linha de ações, lá embaixo. Com o
            teclado virtual aberto (#3191), ele sai da frente: num iPhone sobram
            ~250px de tela, e o fio da conversa vale mais. O marcador é da camada
            da conversa (`useAlturaVisivel`); o `max-md:` deixa o computador igual.
            `not-focus-within`: se o teclado abriu para editar a PRÓPRIA sugestão
            (ou escrever o motivo da rejeição), o bloco fica onde a pessoa digita. */}
        {mode === "reply" && sugestao && (
          <div
            data-testid="sugestao-sai-com-teclado"
            className="max-md:group-data-[teclado-aberto]/conversa:not-focus-within:hidden"
          >
            <ReplyReviewPanel conversationId={conversationId} disabled={isDisabled} />
          </div>
        )}
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setMode("reply")}
            className={cn(
              "min-h-11 rounded-full px-3 py-1 text-xs font-medium transition-colors lg:min-h-0 lg:px-2.5",
              mode === "reply"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {t("Responder")}
          </button>
          <button
            type="button"
            onClick={() => setMode("note")}
            className={cn(
              "min-h-11 rounded-full px-3 py-1 text-xs font-medium transition-colors lg:min-h-0 lg:px-2.5",
              mode === "note"
                ? "bg-warning text-warning-fg"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {t("Nota interna")}
          </button>
        </div>
        </div>
        {/*
          A FAIXA DA CITAÇÃO — o que o atendente escolheu responder.

          Fica ACIMA do campo, como no WhatsApp, e não dentro dele: o texto
          citado pode ter várias linhas, e empurrá-lo para dentro do campo faria
          o que se digita disputar espaço com o que se cita.

          `line-clamp-2` porque o objetivo é reconhecer qual mensagem é, não
          relê-la — ela está logo acima, no fio.
        */}
        {respondendo && mode === "reply" && (
          <div className="mb-1 flex items-start gap-2 rounded-md border-l-2 border-primary bg-muted/60 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium text-primary">
                {respondendo.direction === "outbound" ? t("Você") : t("Cliente")}
              </div>
              <div className="line-clamp-2 text-xs text-muted-foreground">
                {respondendo.type === "contact"
                  ? resolveSharedContact({
                      type: "contact",
                      body: respondendo.body,
                      metadata: respondendo.metadata ?? {},
                    })?.name || t("Contato")
                  : respondendo.body?.trim() || t("(sem texto)")}
              </div>
            </div>
            <button
              type="button"
              onClick={onCancelarResposta}
              aria-label={t("Cancelar resposta")}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:size-auto lg:p-0.5"
            >
              <X className="size-4" />
            </button>
          </div>
        )}
        {semEnvio && mode === "reply" && (
          <p className="mb-1.5 text-xs text-muted-foreground">{semEnvio}</p>
        )}
        {/* O aviso do curinga literal: PERSISTENTE, junto do campo, enquanto o
            literal sobreviver no texto (digitado ou vindo de um modelo). */}
        {motivoCuringa && (
          <p
            data-testid="aviso-curinga-literal"
            className="mb-1.5 rounded-md border-l-2 border-warning bg-warning-bg px-2 py-1.5 text-xs text-warning-fg"
          >
            {t("Contato sem nome no CRM: {{nome}}/{{primeiro_nome}} ficaram literais no texto. Edite antes de enviar.")}
          </p>
        )}
        {/* A BARRA DE RESPOSTAS RÁPIDAS (#2833): um botão por título. O clique
            NÃO envia: entrega a resposta ao MESMO `applyTemplate` do `/`. */}
        {mode === "reply" && (
          <BarraDeRecursos
            respostas={templates.data ?? []}
            disabled={respostaBarrada}
            onEscolher={applyTemplate}
          />
        )}
        <div className="flex items-end gap-2">
          {/* O "+" existe nos DOIS modos: em "Nota interna" a nota aceita anexo
              (foto/vídeo e documento). Contato some — cartão de contato é uma
              MENSAGEM para o cliente — e a restrição do canal (`soFoto`) não
              vale, porque a nota não sai para canal nenhum. */}
          <AttachMenu
            disabled={respostaBarrada}
            onPick={escolherArquivo}
            onPickContact={mode === "reply" ? () => setContactPickerOpen(true) : undefined}
            soFoto={mode === "reply" ? soFoto : false}
          />
          <EmojiButton
            disabled={isDisabled}
            onPick={(emoji) => {
              const ta = taRef.current;
              if (!ta) {
                setText((t) => t + emoji);
                return;
              }
              const start = ta.selectionStart ?? text.length;
              const end = ta.selectionEnd ?? text.length;
              const next = text.slice(0, start) + emoji + text.slice(end);
              setText(next);
              requestAnimationFrame(() => {
                ta.focus();
                ta.selectionStart = ta.selectionEnd = start + emoji.length;
                autoresize();
              });
            }}
          />
          {/* "Sugerir resposta" em um clique, sem faixa (porte do original
              #3234): gera pelo MESMO POST do bloco, e o rascunho criado chega
              pela consulta compartilhada, que monta o bloco com o texto e as
              ações. Nunca os dois juntos: com o bloco na tela, o botão de
              gerar outra é o dele. O texto não cai no campo: quem revisa é o
              bloco. */}
          {mode === "reply" && !sugestao && (
            <DraftReplyButton
              conversationId={conversationId}
              disabled={isDisabled}
              onDraft={() => void invalidar()}
            />
          )}
          {/* A porta explícita da faixa de cima (toque e teclado). Três
              pontos, e não faísca: a faísca é do "Sugerir resposta" ao lado,
              e sem sugestão o que mora na faixa é o Responder/Nota interna.
              Desabilitada enquanto a faixa está presa aberta por estado
              (nota, sugestão): ali fechar não é opção, e o botão continua no
              lugar para o campo não mudar de largura. */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("shrink-0", ferramentas.visivel && "bg-muted")}
            aria-label={t("Opções de resposta")}
            title={t("Assistência do agente e nota interna")}
            disabled={mode === "note" || temSugestao}
            {...ferramentas.alternadorProps}
            onClick={ferramentas.alternar}
          >
            <DotsThree size={16} weight="bold" aria-hidden />
          </Button>
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              const pos = e.target.selectionStart ?? e.target.value.length;
              setCaret(pos);
              setMencaoIndice(0);
              // A escolha que sumiu do texto sai da lista agora: senão roubava
              // o `@Nome` de um homônimo e notificava a pessoa errada.
              setMencoes((atual) => podarMencoes(e.target.value, atual));
              if (!resolveSlash(e.target.value).open) setMenuDismissed(false);
              if (!resolverMencao(e.target.value, pos)) setMencaoDispensada(false);
              autoresize();
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            // O atalho saiu do placeholder e foi para o diálogo de atalhos (`?`)
            // e para o `title` aqui. Dois motivos, nesta ordem: ele some assim
            // que se digita a primeira letra — isto é, some justamente quando
            // você ia quebrar linha —; e, com a coluna do inbox mais estreita
            // depois do conserto do layout, a frase quebrava em duas linhas
            // dentro de um campo de uma linha só.
            //
            // "(só o time vê)" FICA: não é atalho, é consequência. Quem escreve
            // uma nota interna precisa saber que ela não vai para o cliente, e
            // essa informação não pode depender de abrir um diálogo.
            placeholder={
              mode === "note"
                ? t("Escreva uma nota interna… (só o time vê)")
                : t("Escreva uma mensagem…")
            }
            title={
              mode === "note"
                ? t("Enter salva a nota · Shift+Enter quebra linha")
                : t("Enter envia · Shift+Enter quebra linha")
            }
            // `placeholder:truncate` + `text-ellipsis`: o placeholder fica numa
            // linha com reticências. Com o botão de faísca na fileira, em 390px
            // o campo tem ~140px e "Escreva uma mensagem…" quebrava em duas
            // linhas cortadas dentro do campo de uma linha (medido pelo
            // `scrollHeight` no e2e). O texto digitado continua quebrando.
            className={cn(
              // `text-base` no celular (porte do #3190): com menos de 16px o
              // iPhone amplia a página ao focar o campo.
              // `min-w-0`: com os alvos de 44px do toque (porte do #3191) a
              // fileira de 390px não cabe o campo na largura intrínseca dele, e
              // quem encolhe tem de ser o campo, não o botão de enviar.
              "max-h-40 min-h-11 min-w-0 flex-1 resize-none rounded-xl border border-border bg-surface px-3.5 py-2.5 text-base text-ellipsis md:text-sm lg:min-h-10",
              "placeholder:truncate placeholder:text-muted-foreground focus:ring-1 focus:ring-ring focus:outline-hidden",
            )}
            disabled={mode === "note" ? isDisabled : respostaBarrada}
            aria-label={t("Mensagem")}
          />
          {text.trim() || mode === "note" ? (
            <Button
              type="button"
              size="icon"
              className="shrink-0 rounded-full"
              onClick={handleSubmit}
              disabled={(mode === "note" ? isDisabled : envioBarrado) || !text.trim()}
              aria-label={t("Enviar")}
            >
              <PaperPlaneTilt size={16} weight="fill" aria-hidden />
            </Button>
          ) : soFoto ? null : (
            // O Direct não aceita o ogg/opus que este gravador produz —
            // `soFoto` some com ele em vez de deixar gravar um áudio que o
            // servidor (Task 3) vai recusar no envio.
            <AudioRecorder conversationId={conversationId} disabled={respostaBarrada} />
          )}
        </div>
        {mode === "reply" && limiteDeTexto && (
          <p
            className={cn(
              "mt-1 text-right text-[11px] text-muted-foreground",
              acimaDoLimite && "text-destructive",
            )}
          >
            {text.length}/{limiteDeTexto}
          </p>
        )}
      </div>
      <AttachmentPreviewDialog
        file={pendingFile}
        sending={upload.isPending || send.isPending || createNote.isPending}
        onCancel={() => setPendingFile(null)}
        onSend={async (caption) => {
          if (!pendingFile) return;
          // A BIFURCAÇÃO (#1863, F3) — e ela é decidida pelo modo CONGELADO NA
          // ESCOLHA (`pendingEm`), não pelo modo de agora.
          //
          //   reply  → upload em `whatsapp-media` + `useSendMessage`: exatamente
          //            o que era antes, byte por byte. Nada aqui mudou para o
          //            cliente.
          //   note   → upload em `internal-media` + `useCreateNote`, com o trio
          //            como `anexo`. Não existe passo de envio: a nota não é
          //            mensagem, não tem `type`, não tem destino no WhatsApp.
          //
          // O `try/catch` continua cobrindo SÓ o upload (falha de gravação da
          // nota é tratada pelo onError do próprio hook, e o diálogo fica aberto
          // nos dois casos).
          const destino: DestinoDoUpload = pendingEm === "note" ? "nota" : "mensagem";
          try {
            const uploaded = await upload.mutateAsync({ conversationId, file: pendingFile, destino });
            if (destino === "nota") {
              createNote.mutate(
                {
                  conversation_id: conversationId,
                  body: caption,
                  anexo: {
                    storage_path: uploaded.storage_path,
                    media_mime: uploaded.media_mime,
                    media_size_bytes: uploaded.media_size_bytes,
                  },
                },
                { onSuccess: () => setPendingFile(null) },
              );
              return;
            }
            send.mutate(
              {
                conversation_id: conversationId,
                type: uploaded.kind,
                body: caption || undefined,
                media_storage_path: uploaded.storage_path,
                media_mime: uploaded.media_mime,
                media_size_bytes: uploaded.media_size_bytes,
              },
              { onSuccess: () => setPendingFile(null) },
            );
          } catch {
            // toast já disparado pelo onError de useUploadMedia; dialog fica aberto p/ retry
            return;
          }
        }}
      />
      <RespostaComImagensDialog
        key={`${respostaComImagens?.templateId ?? ""}:${respostaComImagens?.imagens.length ?? 0}:${respostaComImagens?.legenda ?? ""}`}
        templateId={respostaComImagens?.templateId ?? null}
        imagens={respostaComImagens?.imagens ?? []}
        legendaInicial={respostaComImagens?.legenda ?? ""}
        sending={send.isPending}
        onCancel={(legenda) => {
          setRespostaComImagens(null);
          if (legenda) textoDeVoltaAoCampo(legenda);
        }}
        onRemove={(itemId, legenda) => {
          const r = respostaComImagens;
          if (!r) return;
          const imagens = r.imagens.filter((i) => i.itemId !== itemId);
          // A legenda editada sobrevive à troca da fila.
          if (imagens.length > 0) return setRespostaComImagens({ ...r, imagens, legenda });
          // A última imagem saiu: a resposta vira texto no campo, como no cancelar.
          setRespostaComImagens(null);
          if (legenda) textoDeVoltaAoCampo(legenda);
        }}
        onSend={(legenda) => void enviarRespostaComImagens(legenda)}
      />
      <ContactPickerDialog
        open={contactPickerOpen}
        onOpenChange={setContactPickerOpen}
        excludeContactId={currentContactId}
        sending={send.isPending}
        onPick={(payload) => {
          send.mutate(
            {
              conversation_id: conversationId,
              type: "contact",
              metadata: payload.contactId
                ? { shared_contact_id: payload.contactId }
                : {
                    shared_contact: {
                      name: payload.name,
                      phone_number: payload.phone_number,
                    },
                  },
            },
            { onSuccess: () => setContactPickerOpen(false) },
          );
        }}
      />
    </>
  );
});
