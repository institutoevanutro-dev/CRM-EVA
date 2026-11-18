"use client";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/hooks/i18n/useT";

import { Button } from "@/components/ui/button";
import { CircleNotch, Microphone, PaperPlaneTilt, Trash } from "@/lib/ui/icons";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import { useUploadMedia } from "@/hooks/inbox/useUploadMedia";

const PREFERRED_MIMES = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus"];

/**
 * A extensão vem do mime que o navegador DE FATO gravou (porte do original
 * #3191). O Safari do iPhone (antes do 18.4) ignora os dois preferidos e grava
 * `audio/mp4`: subir isso como `.webm` mentia o formato para quem lê o arquivo.
 */
function extensaoDaGravacao(mime: string): "ogg" | "webm" | "m4a" {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4") || mime.includes("aac") || mime.includes("m4a")) return "m4a";
  return "webm";
}

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return PREFERRED_MIMES.find((m) => MediaRecorder.isTypeSupported(m));
}

interface Props {
  conversationId: string;
  disabled?: boolean;
}

/** Uma gravação pronta, à espera de subir. */
interface Gravacao {
  blob: Blob;
  filename: string;
}

/**
 * Gravação de voz estilo WhatsApp: mic → timer + cancelar/enviar → PTT.
 *
 * O ENVIO SE MOSTRA, E A FALHA NÃO PERDE A GRAVAÇÃO (item 35 da auditoria de
 * 17/11). Nada mostrava que o áudio estava subindo, e se a subida falhava a
 * gravação sumia. Agora: "Enviando áudio…" enquanto sobe; se falhar, a
 * gravação fica guardada aqui, com "Tentar de novo" e a lixeira para descartar.
 */
export function AudioRecorder({ conversationId, disabled }: Props) {
  const t = useT();
  const [recording, setRecording] = useState(false);
  const [pendente, setPendente] = useState<Gravacao | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const startingRef = useRef(false);
  const upload = useUploadMedia();
  const send = useSendMessage();

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  const cleanupStream = () => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
  };

  // Trocar de conversa/rota no meio de uma gravação não pode deixar o mic aberto.
  useEffect(
    () => () => {
      discardRef.current = true;
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      cleanupStream();
    },
    [],
  );

  async function start() {
    if (startingRef.current || recording) return;
    startingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      discardRef.current = false;
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        cleanupStream();
        setRecording(false);
        setElapsed(0);
        if (discardRef.current || chunksRef.current.length === 0) return;
        const type = rec.mimeType || "audio/webm";
        enviar({ blob: new Blob(chunksRef.current, { type }), filename: `ptt.${extensaoDaGravacao(type)}` });
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      cleanupStream();
      // permissão negada / sem mic — não gravar é o estado final; toast simples
      const { showApiError } = await import("@/components/feedback/ApiErrorToast");
      showApiError(new Error(t("Não consegui acessar o microfone. Verifique a permissão do navegador.")));
    } finally {
      startingRef.current = false;
    }
  }

  function enviar(gravacao: Gravacao) {
    setPendente(gravacao);
    setFalhou(false);
    void upload
      .mutateAsync({
        conversationId,
        file: gravacao.blob,
        filename: gravacao.filename,
        // "É nota de voz": só com esta marca o servidor converte o AAC do
        // iPhone em opus, o único formato de nota de voz dos canais oficiais.
        notaDeVoz: true,
      })
      .then((uploaded) =>
        send.mutate(
          {
            conversation_id: conversationId,
            type: "audio",
            media_storage_path: uploaded.storage_path,
            media_mime: uploaded.media_mime,
            media_size_bytes: uploaded.media_size_bytes,
          },
          { onSuccess: () => setPendente(null), onError: () => setFalhou(true) },
        ),
      )
      // O aviso do motivo já saiu pelo onError de useUploadMedia.
      .catch(() => setFalhou(true));
  }

  function stopIfRecording() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  if (pendente && !recording) {
    return falhou ? (
      <div className="flex shrink-0 items-center gap-1">
        <span className="text-xs text-error-fg">{t("Áudio não enviado.")}</span>
        <Button type="button" size="sm" variant="outline" onClick={() => enviar(pendente)}>
          {t("Tentar de novo")}
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="shrink-0"
          aria-label={t("Descartar áudio")}
          title={t("Descartar áudio")}
          onClick={() => {
            setPendente(null);
            setFalhou(false);
          }}
        >
          <Trash size={16} weight="regular" aria-hidden />
        </Button>
      </div>
    ) : (
      <span role="status" className="flex shrink-0 items-center gap-1.5 px-1 text-xs text-muted-foreground">
        <CircleNotch size={14} weight="bold" className="motion-safe:animate-spin" aria-hidden />
        {t("Enviando áudio…")}
      </span>
    );
  }

  if (!recording) {
    return (
      <Button
        type="button"
        size="icon"
        // Redondo, como o botão de enviar que toma o lugar dele quando há texto.
        className="shrink-0 rounded-full"
        aria-label={t("Gravar áudio")}
        onClick={start}
        disabled={disabled}
      >
        <Microphone size={16} weight="fill" aria-hidden />
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="shrink-0 text-destructive"
        aria-label={t("Cancelar gravação")}
        onClick={() => {
          discardRef.current = true;
          stopIfRecording();
        }}
      >
        <Trash size={16} weight="regular" aria-hidden />
      </Button>
      <span className="flex items-center gap-1.5 text-sm tabular-nums text-destructive">
        <span className="h-2 w-2 animate-pulse rounded-full bg-destructive" aria-hidden />
        {fmt(elapsed)}
      </span>
      <Button
        type="button"
        size="icon"
        className="shrink-0"
        aria-label={t("Enviar áudio")}
        onClick={stopIfRecording}
      >
        <PaperPlaneTilt size={16} weight="fill" aria-hidden />
      </Button>
    </div>
  );
}
