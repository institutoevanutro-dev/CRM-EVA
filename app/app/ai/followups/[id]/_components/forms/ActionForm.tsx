"use client";

import { useState } from "react";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { actionConfigSchema } from "@/lib/followup/graph-schema";
import { MODOS_DA_ACAO, opcoes, type ModoDaAcao } from "@/lib/followup/vocabulario";
import { useMessageTemplates } from "@/hooks/inbox/useMessageTemplates";
import { useT } from "@/hooks/i18n/useT";
import { useMidias } from "@/hooks/ai/useMidias";
import { SITUACAO_LEGIVEL } from "@/lib/midias/termo";

import type { ConfigOf } from "./shared";

/**
 * O seletor de modelo, no lugar dos dois `<Input>` que pediam um UUID colado à
 * mão. Trata os três estados em vez de fingir que a lista sempre chega:
 * carregando, vazia e erro — porque um seletor vazio sem explicação é o mesmo
 * beco sem saída que o campo de UUID era, só que mais bonito.
 */
function SeletorDeModelo({
  id,
  valor,
  onChange,
  permiteVazio,
}: {
  id: string;
  valor: string;
  onChange: (templateId: string) => void;
  permiteVazio: boolean;
}) {
  const t = useT();
  const { data: modelos, isLoading, isError } = useMessageTemplates();

  if (isLoading) return <p className="text-xs text-text-muted">{t("Carregando seus modelos…")}</p>;
  if (isError) {
    return (
      <p className="text-xs text-error-fg">
        {t("Não consegui carregar seus modelos de mensagem. Recarregue a página.")}
      </p>
    );
  }
  if (!modelos?.length) {
    return (
      <p className="text-xs text-text-muted">
        {t("Você ainda não tem modelos de mensagem. Crie um em Ajustes → Modelos e ele aparece aqui.")}
      </p>
    );
  }

  const SEM_MODELO = "__nenhum__";
  return (
    <Select
      value={valor === "" ? SEM_MODELO : valor}
      onValueChange={(v) => onChange(v === SEM_MODELO ? "" : v)}
    >
      <SelectTrigger id={id}>
        <SelectValue placeholder={t("Escolha um modelo")} />
      </SelectTrigger>
      <SelectContent>
        {permiteVazio && <SelectItem value={SEM_MODELO}>{t("Nenhum")}</SelectItem>}
        {modelos.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Mesmo molde do seletor de modelo; item que não pode sair fica visível, marcado. */
function SeletorDeMidia({ id, valor, onChange }: { id: string; valor: string; onChange: (mediaId: string) => void }) {
  const t = useT();
  const { data: itens, isLoading, isError } = useMidias();

  if (isLoading) return <p className="text-xs text-text-muted">{t("Carregando sua biblioteca de mídias…")}</p>;
  if (isError) {
    return (
      <p className="text-xs text-error-fg">
        {t("Não consegui carregar sua biblioteca de mídias. Recarregue a página.")}
      </p>
    );
  }
  if (!itens?.length) {
    return (
      <p className="text-xs text-text-muted">
        {t("Você ainda não tem mídias na biblioteca. Adicione uma e ela aparece aqui.")}
      </p>
    );
  }

  return (
    <Select value={valor === "" ? undefined : valor} onValueChange={onChange}>
      <SelectTrigger id={id}>
        <SelectValue placeholder={t("Escolha uma mídia")} />
      </SelectTrigger>
      <SelectContent>
        {itens.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.situacao === "pronta"
              ? m.title
              : `${m.title} (${t("não pode ser enviada agora")}: ${t(SITUACAO_LEGIVEL[m.situacao])})`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ActionForm({
  config,
  onChange,
}: {
  config: ConfigOf<"action">;
  onChange: (c: ConfigOf<"action">) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState(config.mode);
  const [body, setBody] = useState(config.mode === "text" ? config.body : "");
  const [promptHint, setPromptHint] = useState(config.mode === "ai_message" ? config.prompt_hint : "");
  const [fallbackTemplateId, setFallbackTemplateId] = useState(
    config.mode === "ai_message" ? (config.fallback_template_id ?? "") : "",
  );
  const [templateId, setTemplateId] = useState(config.mode === "template" ? config.template_id : "");
  const [mediaId, setMediaId] = useState(config.mode === "media" ? config.media_id : "");
  const [caption, setCaption] = useState(config.mode === "media" ? (config.caption ?? "") : "");
  const [error, setError] = useState<string | null>(null);

  const commit = (next: {
    mode: ModoDaAcao;
    body: string;
    promptHint: string;
    fallbackTemplateId: string;
    templateId: string;
    mediaId: string;
    caption: string;
  }) => {
    const candidate =
      next.mode === "text"
        ? { mode: "text" as const, body: next.body }
        : next.mode === "ai_message"
          ? {
              mode: "ai_message" as const,
              prompt_hint: next.promptHint,
              ...(next.fallbackTemplateId.trim() ? { fallback_template_id: next.fallbackTemplateId } : {}),
            }
          : next.mode === "media"
            ? {
                mode: "media" as const,
                media_id: next.mediaId,
                ...(next.caption.trim() ? { caption: next.caption } : {}),
              }
            : { mode: "template" as const, template_id: next.templateId };
    const parsed = actionConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  const fields = { body, promptHint, fallbackTemplateId, templateId, mediaId, caption };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="action-mode">{t("Como escrever a mensagem")}</Label>
        <Select
          value={mode}
          onValueChange={(v) => {
            const next = v as ModoDaAcao;
            setMode(next);
            commit({ mode: next, ...fields });
          }}
        >
          <SelectTrigger id="action-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {opcoes(MODOS_DA_ACAO).map(({ valor, rotulo }) => (
              <SelectItem key={valor} value={valor}>
                {t(rotulo)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {mode === "text" ? (
        <div className="space-y-2">
          <Label htmlFor="action-body">{t("Texto enviado ao contato")}</Label>
          <Textarea
            id="action-body"
            maxLength={4000}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              commit({ mode, ...fields, body: e.target.value });
            }}
          />
          <p className="text-xs text-text-muted">
            {t("Sai exatamente assim, sem IA. No laço,")} {t("{{volta}}")} e {t("{{voltas}}")} {t("viram o número da volta.")}
          </p>
          <p className="text-xs text-text-muted">
            {t("{{nome}} e {{primeiro_nome}} viram o nome do contato; sem nome, a variável sai do texto.")}
          </p>
        </div>
      ) : mode === "ai_message" ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="action-prompt-hint">{t("Instrução para a IA")}</Label>
            <Textarea
              id="action-prompt-hint"
              maxLength={1000}
              value={promptHint}
              onChange={(e) => {
                setPromptHint(e.target.value);
                commit({ mode, ...fields, promptHint: e.target.value });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="action-fallback">{t("Se a IA não conseguir escrever, mandar este modelo")}</Label>
            <SeletorDeModelo
              id="action-fallback"
              valor={fallbackTemplateId}
              permiteVazio
              onChange={(v) => {
                setFallbackTemplateId(v);
                commit({ mode, ...fields, fallbackTemplateId: v });
              }}
            />
          </div>
        </>
      ) : mode === "media" ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="action-media-id">{t("Imagem ou vídeo")}</Label>
            <SeletorDeMidia
              id="action-media-id"
              valor={mediaId}
              onChange={(v) => {
                setMediaId(v);
                commit({ mode, ...fields, mediaId: v });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="action-caption">{t("Legenda (opcional)")}</Label>
            <Textarea
              id="action-caption"
              maxLength={1024}
              value={caption}
              onChange={(e) => {
                setCaption(e.target.value);
                commit({ mode, ...fields, caption: e.target.value });
              }}
            />
            <p className="text-xs text-text-muted">
              {t("{{nome}} e {{primeiro_nome}} viram o nome do contato; sem nome, a variável sai do texto.")}
            </p>
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="action-template-id">{t("Modelo de mensagem")}</Label>
          <SeletorDeModelo
            id="action-template-id"
            valor={templateId}
            permiteVazio={false}
            onChange={(v) => {
              setTemplateId(v);
              commit({ mode, ...fields, templateId: v });
            }}
          />
        </div>
      )}
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}
