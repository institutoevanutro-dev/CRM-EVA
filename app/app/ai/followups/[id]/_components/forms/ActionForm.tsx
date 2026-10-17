"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
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
import { VARIAVEIS_DO_TEMPLATE, variaveisDesconhecidas } from "@/lib/inbox/template-vars";

import type { ConfigOf } from "./shared";

/** O teto do schema (`actionConfigSchema`, modo `text`): até 5 variantes além do texto principal. */
const MAX_VARIANTES = 4;

/**
 * As variáveis que o envio preenche (a MESMA lista de `lib/inbox/template-vars.ts`)
 * e o aviso da que não existe: no envio ela sai do texto, e descobrir pela
 * mensagem que chegou torta é descobrir tarde. `volta` e `voltas` são do laço.
 */
function AjudaDasVariaveis({ texto }: { texto: string }) {
  const t = useT();
  const desconhecidas = variaveisDesconhecidas(texto, ["volta", "voltas", "saudacao"]);
  return (
    <>
      <p className="text-xs text-text-muted" data-testid="variaveis-do-followup">
        {t("Variáveis do contato:")} {VARIAVEIS_DO_TEMPLATE.map((v) => `{{${v}}}`).join(" ")}
        {". "}
        {t("Variável sem valor sai do texto.")}{" "}
        {"{{saudacao}}"} {t("vira Bom dia, Boa tarde ou Boa noite na hora do envio, no fuso da organização.")}
      </p>
      {desconhecidas.length > 0 ? (
        <p className="text-xs text-warning" data-testid="aviso-variavel-do-followup">
          {t("Variável que não existe: use só as da lista.")} {desconhecidas.join(" ")}
        </p>
      ) : null}
    </>
  );
}

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
  const [variants, setVariants] = useState<string[]>(config.mode === "text" ? (config.variants ?? []) : []);
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
    variants: string[];
    promptHint: string;
    fallbackTemplateId: string;
    templateId: string;
    mediaId: string;
    caption: string;
  }) => {
    const candidate =
      next.mode === "text"
        ? { mode: "text" as const, body: next.body, ...(next.variants.length ? { variants: next.variants } : {}) }
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

  const fields = { body, variants, promptHint, fallbackTemplateId, templateId, mediaId, caption };

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
          {variants.map((v, i) => (
            <div key={i} className="space-y-1" data-testid="variante-do-texto">
              <div className="flex items-center justify-between">
                <Label htmlFor={`action-variant-${i}`}>
                  {t("Variante")} {i + 2}
                </Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const next = variants.filter((_, j) => j !== i);
                    setVariants(next);
                    commit({ mode, ...fields, variants: next });
                  }}
                >
                  {t("Remover variante")}
                </Button>
              </div>
              <Textarea
                id={`action-variant-${i}`}
                maxLength={4000}
                value={v}
                onChange={(e) => {
                  const next = variants.map((x, j) => (j === i ? e.target.value : x));
                  setVariants(next);
                  commit({ mode, ...fields, variants: next });
                }}
              />
            </div>
          ))}
          {variants.length < MAX_VARIANTES ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const next = [...variants, ""];
                setVariants(next);
                commit({ mode, ...fields, variants: next });
              }}
            >
              {t("Adicionar variante")}
            </Button>
          ) : null}
          <p className="text-xs text-text-muted">
            {t("Com variantes, cada contato recebe sempre a mesma redação deste passo, e contatos diferentes recebem redações diferentes. Além do texto principal, adicione até 4 variantes.")}
          </p>
          <p className="text-xs text-text-muted">
            {t("Sai exatamente assim, sem IA. No laço,")} {t("{{volta}}")} e {t("{{voltas}}")} {t("viram o número da volta.")}
          </p>
          <AjudaDasVariaveis texto={body} />
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
            <AjudaDasVariaveis texto={caption} />
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
