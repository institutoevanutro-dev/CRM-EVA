"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { editLeadTagConfigSchema } from "@/lib/followup/graph-schema";
import { OPERACOES_DA_ETIQUETA } from "@/lib/followup/vocabulario";

import type { ConfigOf } from "./shared";

/**
 * O nó `edit_lead_tag` — pôr ou tirar etiquetas do negócio. O texto digitado
 * fica NO CAMPO (vírgula no fim não some enquanto a pessoa escreve) e o config
 * só recebe o que passou no schema (até 10 etiquetas de até 60 caracteres).
 *
 * Portado e adaptado do projeto original (DeskcommCRM, PR #2181 de @webtecnica);
 * "tirar etiqueta" é acréscimo deste fork.
 */
export function EditLeadTagForm({
  config,
  onChange,
}: {
  config: ConfigOf<"edit_lead_tag">;
  onChange: (c: ConfigOf<"edit_lead_tag">) => void;
}) {
  const t = useT();
  const [texto, setTexto] = useState(() => config.tags.join(", "));
  const [erro, setErro] = useState<string | null>(null);
  const operacao = config.operacao ?? "adicionar";

  const gravar = (bruto: string) => {
    setTexto(bruto);
    const tags = bruto
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const parsed = editLeadTagConfigSchema.safeParse({ tags, operacao });
    if (!parsed.success) {
      setErro(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setErro(null);
    if (parsed.data.tags.join("\u0000") !== config.tags.join("\u0000")) onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="edit-lead-tag-operacao">{t("O que fazer")}</Label>
        <Select
          value={operacao}
          onValueChange={(v) => onChange({ tags: config.tags, operacao: v === "remover" ? "remover" : "adicionar" })}
        >
          <SelectTrigger id="edit-lead-tag-operacao">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="adicionar">{t(OPERACOES_DA_ETIQUETA.adicionar)}</SelectItem>
            <SelectItem value="remover">{t(OPERACOES_DA_ETIQUETA.remover)}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="edit-lead-tag">{t("Etiquetas")}</Label>
        <Input
          id="edit-lead-tag"
          value={texto}
          placeholder={t("ex.: vip, orcamento-aberto")}
          onChange={(e) => gravar(e.target.value)}
          aria-invalid={erro !== null}
        />
        {erro && <p className="text-xs text-error-fg">{erro}</p>}
        <p className="text-xs text-text-muted">
          {operacao === "remover"
            ? t("Separe por vírgula. Só estas etiquetas saem; as outras do negócio ficam.")
            : t("Separe por vírgula. Etiquetas que o negócio já tem são mantidas e nada é apagado.")}
        </p>
      </div>
    </div>
  );
}
