"use client";

import * as React from "react";
import { toast } from "sonner";
import { X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useApagarMidia, useCriarMidia, useMidias, useSubirArquivo } from "@/hooks/ai/useMidias";
import { useT } from "@/hooks/i18n/useT";
import { SITUACAO_LEGIVEL } from "@/lib/midias/termo";
import { MAXIMO_DE_MIDIAS } from "@/lib/templates/midias";

/**
 * As imagens da resposta rápida, escolhidas na BIBLIOTECA DE MÍDIA — a mesma que
 * agentes e acompanhamentos usam. Imagem nova entra na biblioteca pelo mesmo
 * caminho da própria biblioteca (criar o item, subir o arquivo na variante A,
 * com a validação de lá) e só depois é escolhida aqui. O termo de uso de imagem
 * é da biblioteca: item que mostra pessoa sem termo aparece marcado e não sai.
 *
 * Portado e adaptado do projeto original (DeskcommCRM, PR #2704 de @webtecnica).
 */
export function ImagensDaBiblioteca({
  valor,
  onChange,
  disabled,
}: {
  valor: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const { data: itens, isLoading, isError } = useMidias();
  const criar = useCriarMidia();
  const subir = useSubirArquivo();
  const apagar = useApagarMidia();
  const [mostraPessoa, setMostraPessoa] = React.useState(true);
  const enviando = criar.isPending || subir.isPending;
  const imagens = (itens ?? []).filter((m) => m.variantes.some((v) => v.mime.startsWith("image/")));
  const porId = new Map((itens ?? []).map((m) => [m.id, m]));
  const cheio = valor.length >= MAXIMO_DE_MIDIAS;

  async function subirNova(arquivo: File | undefined) {
    if (!arquivo) return;
    let criado: string | null = null;
    try {
      const titulo = arquivo.name.replace(/\.[^.]+$/, "").slice(0, 120) || t("Imagem da resposta rápida");
      const { data } = await criar.mutateAsync({ title: titulo, contains_person: mostraPessoa });
      criado = data.id;
      await subir.mutateAsync({ id: data.id, variante: "A", arquivo });
      onChange([...valor, data.id]);
      if (mostraPessoa) {
        toast.message(t("Imagem guardada na Biblioteca de mídia. Ela só sai depois de registrar o termo de uso de imagem lá."));
      }
    } catch (err) {
      showApiError(err);
      // O arquivo foi recusado (tipo, tamanho): o item vazio não fica na biblioteca.
      if (criado) apagar.mutate(criado);
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="tpl-midia">{t("Imagens da Biblioteca de mídia (opcional)")}</Label>
      <p className="text-xs text-muted-foreground">
        {t("Até 5 imagens, na ordem em que saem. O texto vai como legenda da primeira.")}
      </p>
      {valor.length > 0 && (
        <ol className="space-y-1" data-testid="imagens-escolhidas">
          {valor.map((id) => {
            const item = porId.get(id);
            const url = item?.variantes.find((v) => v.mime.startsWith("image/"))?.url ?? null;
            return (
              <li key={id} className="flex items-center gap-2 text-sm">
                {url ? <img src={url} alt="" className="size-10 rounded border border-border object-cover" /> : null}
                <span className="min-w-0 flex-1 truncate">
                  {item ? item.title : t("Mídia da biblioteca")}
                  {item && item.situacao !== "pronta" ? (
                    <span className="text-xs text-warning"> · {t(SITUACAO_LEGIVEL[item.situacao])}</span>
                  ) : null}
                </span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(valor.filter((x) => x !== id))}
                  aria-label={t("Remover imagem")}
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {isLoading ? (
        <p className="text-xs text-muted-foreground">{t("Carregando sua biblioteca de mídias…")}</p>
      ) : isError ? (
        <p className="text-xs text-error-fg">{t("Não consegui carregar sua biblioteca de mídias. Recarregue a página.")}</p>
      ) : (
        <Select
          value=""
          disabled={disabled || cheio}
          onValueChange={(id) => {
            if (id && !valor.includes(id)) onChange([...valor, id]);
          }}
        >
          <SelectTrigger id="tpl-midia">
            <SelectValue placeholder={cheio ? t("Cada resposta rápida tem no máximo 5 imagens.") : t("Escolha uma mídia")} />
          </SelectTrigger>
          <SelectContent>
            {imagens
              .filter((m) => !valor.includes(m.id))
              .map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.situacao === "pronta"
                    ? m.title
                    : `${m.title} (${t("não pode ser enviada agora")}: ${t(SITUACAO_LEGIVEL[m.situacao])})`}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          id="tpl-midia-nova"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          disabled={disabled || cheio || enviando}
          onChange={(e) => {
            void subirNova(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <Label
          htmlFor="tpl-midia-nova"
          className="inline-flex cursor-pointer items-center rounded-md border border-input px-3 py-1.5 text-sm hover:bg-muted"
        >
          {enviando ? t("Enviando…") : t("Enviar imagem nova para a biblioteca")}
        </Label>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={mostraPessoa} onChange={(e) => setMostraPessoa(e.target.checked)} />
          {t("A imagem mostra uma pessoa")}
        </label>
      </div>
    </div>
  );
}
