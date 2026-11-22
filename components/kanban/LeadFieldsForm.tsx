"use client";

import { useT } from "@/hooks/i18n/useT";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useContactTagVocabulary } from "@/hooks/contacts/useContactTagVocabulary";
import { useEditLead } from "@/hooks/kanban/useUpdateLead";
import type { Lead } from "@/lib/types/leads";
import { updateLeadSchema, type UpdateLeadInput } from "@/lib/schemas/leads";
import { MOEDA_PADRAO, formatCents, parseReaisToCents } from "@/lib/money";
import { roleAtLeast } from "@/lib/auth/types";
import { BotaoRegistrarVenda } from "@/components/vendas/BotaoRegistrarVenda";
import { useVendasDoNegocio } from "@/hooks/vendas/useVendasRegistradas";
import { soChavesAlteradas } from "@/lib/leads/custom-fields-so-diff";
import {
  camposMexidos,
  mesclarEtiquetas,
  mesmasEtiquetas,
  rebaseCampos,
} from "@/lib/leads/rebase-do-dossie";
import { CustomFieldsEditor, type CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import { EtiquetasDoContato } from "@/components/contacts/EtiquetasDoContato";
import { EcoDoValor } from "./EcoDoValor";

type FormShape = {
  title: string;
  description: string;
  valueReais: string;
  expected_close_date: string;
};

interface Props {
  lead: Lead;
  pipelineId: string;
  fieldDefs?: CustomFieldDef[];
  /** Quando o salvamento dá certo. O dossiê NÃO fecha aqui — ver abaixo. */
  onSaved?: () => void;
  /** O dossiê não tem "cancelar"; o diálogo tem. */
  onCancel?: () => void;
}

function centsToReais(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2).replace(".", ",");
}

function valoresDoLead(lead: Lead): FormShape {
  return {
    title: lead.title,
    description: lead.description ?? "",
    valueReais: centsToReais(lead.value_cents),
    expected_close_date: lead.expected_close_date ?? "",
  };
}

/** O que o formulário viu do servidor da última vez — a ponta "base" do merge. */
interface Base {
  valores: FormShape;
  tags: string[];
  campos: Record<string, unknown>;
}

function baseDoLead(lead: Lead): Base {
  return { valores: valoresDoLead(lead), tags: lead.tags ?? [], campos: lead.custom_fields ?? {} };
}

/**
 * Os campos do lead — extraídos do `EditLeadDialog` para o dossiê usar os
 * MESMOS, em vez de uma cópia que diverge no mês.
 *
 * `onSaved` existe para o dossiê NÃO FECHAR ao salvar: quem edita precisa ver a
 * atividade que acabou de gerar entrar na timeline. Fechar esconderia o
 * registro justamente de quem o produziu — a funcionalidade que prova "sua ação
 * fica registrada" provaria isso para todo mundo menos para o autor.
 *
 * O LEAD É VIVO (auditoria L4, achado 6): o que chega por realtime com o
 * dossiê aberto entra nos campos que a pessoa não mexeu, e o Salvar manda só
 * os campos que ela mexeu. A régua está em `lib/leads/rebase-do-dossie.ts`.
 */
export function LeadFieldsForm({ lead, pipelineId, fieldDefs = [], onSaved, onCancel }: Props) {
  const t = useT();
  const edit = useEditLead(pipelineId);
  const org = useActiveOrg();
  const vocabulario = useContactTagVocabulary(org?.orgId ?? null);
  // Com venda registrada, o Valor É a soma das vendas na moeda do negócio — o
  // banco grava isso em `value_cents` (migration 0424). Aqui a soma sai da
  // mesma lista, para o campo acompanhar a venda recém-registrada sem esperar
  // o negócio ser relido. Quando a última venda sai, o valor digitado volta
  // pelo banco e entra no campo pelo rebase do lead vivo (abaixo).
  const moedaDoValor = (lead.currency ?? MOEDA_PADRAO).toUpperCase();
  const { data: vendas } = useVendasDoNegocio(lead.id);
  const vendasDoNegocio = Array.isArray(vendas) ? vendas : [];
  const valorPelasVendas = vendasDoNegocio.length > 0;
  const somaDasVendas = vendasDoNegocio.reduce(
    (soma, v) => soma + (v.currency.toUpperCase() === moedaDoValor ? v.valor_cents : 0),
    0,
  );
  const base = useRef<Base>(baseDoLead(lead));
  const idCarregado = useRef(lead.id);
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(lead.custom_fields ?? {});
  const [tags, setTags] = useState<string[]>(lead.tags ?? []);
  // O texto digitado no campo de etiqueta e ainda sem Enter — o Salvar o inclui,
  // como na ficha do contato. A `chave` remonta o campo depois de salvar, para
  // o texto que já virou etiqueta não ficar no input.
  const [etiquetaPendente, setEtiquetaPendente] = useState<string | null>(null);
  const [chaveDasEtiquetas, setChaveDasEtiquetas] = useState(0);

  const form = useForm<FormShape>({ defaultValues: valoresDoLead(lead) });

  // A identidade do conteúdo do lead: muda quando o servidor muda algo que o
  // formulário mostra, e só então o efeito roda.
  const versaoDoLead = JSON.stringify([valoresDoLead(lead), lead.tags ?? [], lead.custom_fields ?? {}]);

  useEffect(() => {
    const novo = baseDoLead(lead);
    if (idCarregado.current !== lead.id) {
      // Outro lead: recomeça do zero.
      idCarregado.current = lead.id;
      base.current = novo;
      form.reset(novo.valores);
      setTags(novo.tags);
      setCustomFields(novo.campos);
      setEtiquetaPendente(null);
      setChaveDasEtiquetas((k) => k + 1);
      return;
    }
    // O mesmo lead mudou no servidor: o que a pessoa não mexeu acompanha.
    const anterior = base.current;
    const atuais = form.getValues();
    const rebase = rebaseCampos(anterior.valores, atuais, novo.valores);
    for (const campo of Object.keys(rebase) as (keyof FormShape)[]) {
      if (rebase[campo] !== atuais[campo]) form.setValue(campo, rebase[campo]);
    }
    setTags((atual) => mesclarEtiquetas(anterior.tags, atual, novo.tags));
    setCustomFields((atual) => rebaseCampos(anterior.campos, atual, novo.campos));
    base.current = novo;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead.id, versaoDoLead]);

  async function onSubmit(values: FormShape) {
    const b = base.current;
    const mexidos = camposMexidos(b.valores, values);
    const patch: Record<string, unknown> = {};

    if (mexidos.title !== undefined) patch.title = values.title.trim();
    if (mexidos.description !== undefined) {
      patch.description = values.description.trim() ? values.description.trim() : null;
    }
    // Com venda registrada, o valor é do banco (a soma): o formulário não o
    // reescreve — um Salvar com a ficha aberta antes da venda apagaria a soma.
    if (mexidos.valueReais !== undefined && !valorPelasVendas) {
      const reais = values.valueReais.trim();
      let valueCents: number | null = null;
      if (reais.length > 0) {
        valueCents = parseReaisToCents(reais);
        if (valueCents === null) {
          form.setError("valueReais", { message: t("Valor inválido") });
          return;
        }
      }
      patch.value_cents = valueCents;
    }
    if (mexidos.expected_close_date !== undefined) {
      patch.expected_close_date = values.expected_close_date || null;
    }

    const tagsDaTela =
      etiquetaPendente && !tags.includes(etiquetaPendente) ? [...tags, etiquetaPendente] : tags;
    if (!mesmasEtiquetas(b.tags, tagsDaTela)) {
      // Aplicadas sobre o conjunto do servidor: a etiqueta que a IA pôs no meio fica.
      patch.tags = mesclarEtiquetas(b.tags, tagsDaTela, lead.tags ?? []);
    }

    const camposAlterados = soChavesAlteradas(b.campos, customFields);
    if (fieldDefs.length > 0 && Object.keys(camposAlterados).length > 0) {
      patch.custom_fields = camposAlterados;
    }

    if (Object.keys(patch).length === 0) {
      toast(t("Nada mudou para salvar."));
      return;
    }

    const parsed = updateLeadSchema.safeParse(patch);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      toast.error(first?.message ?? t("Dados inválidos"));
      return;
    }

    try {
      await edit.mutateAsync({
        leadId: lead.id,
        patch: parsed.data as UpdateLeadInput,
      });
      // O que acabou de gravar vira a nova base: o lead que volta do servidor
      // entra inteiro, sem nada parecer "mexido".
      base.current = {
        valores: { ...values },
        tags: (patch.tags as string[] | undefined) ?? b.tags,
        campos: { ...b.campos, ...camposAlterados },
      };
      if (patch.tags) setTags(patch.tags as string[]);
      setEtiquetaPendente(null);
      setChaveDasEtiquetas((k) => k + 1);
      toast.success(t("Dados salvos"));
      onSaved?.();
    } catch {
      // toast already shown
    }
  }

  return (
    <form onSubmit={(e) => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="title">{t("Título")}</Label>
          <Input
            id="title"
            {...form.register("title", { required: true, minLength: 2 })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">{t("Descrição")}</Label>
          <Textarea id="description" rows={3} {...form.register("description")} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="valueReais">{t("Valor (R$)")}</Label>
            <div className="flex items-center gap-1">
              {valorPelasVendas ? (
                <Input
                  id="valueReais"
                  readOnly
                  aria-readonly
                  data-testid="valor-pelas-vendas"
                  value={formatCents(somaDasVendas, moedaDoValor)}
                  className="bg-surface-elevated"
                />
              ) : (
                <Input
                  id="valueReais"
                  inputMode="decimal"
                  placeholder="0,00"
                  {...form.register("valueReais")}
                />
              )}
              {/* A porta de "registrar venda" no negócio: o "+" mora no próprio
                  Valor, e cada venda soma nele. Piso do `POST /api/v1/vendas`:
                  abaixo de `agent` o "+" só terminaria em 403. */}
              {roleAtLeast(org?.role, "agent") && (
                <BotaoRegistrarVenda
                  leadId={lead.id}
                  titulo={lead.title}
                  moeda={moedaDoValor}
                  className="size-9 border border-border"
                  testId="valor-registrar-venda"
                />
              )}
            </div>
            {valorPelasVendas ? (
              <p className="text-xs text-text-muted" data-testid="valor-pelas-vendas-legenda">
                {t("Soma de")} {vendasDoNegocio.length} {t("venda(s) registrada(s)")}
              </p>
            ) : (
              <EcoDoValor control={form.control} />
            )}
            {form.formState.errors.valueReais && (
              <p className="text-xs text-error-fg">
                {t(form.formState.errors.valueReais.message ?? "")}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="expected_close_date">{t("Fechamento previsto")}</Label>
            <Input
              id="expected_close_date"
              type="date"
              {...form.register("expected_close_date")}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="etiquetas-do-lead">{t("Etiquetas")}</Label>
          <EtiquetasDoContato
            key={chaveDasEtiquetas}
            inputId="etiquetas-do-lead"
            value={tags}
            onChange={setTags}
            onPendente={setEtiquetaPendente}
            vocabulario={vocabulario.data}
            disabled={edit.isPending}
            textoVazio={t("Nenhuma etiqueta neste negócio.")}
          />
        </div>

        {fieldDefs.length > 0 && (
          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-sm font-medium">{t("Campos do funil")}</p>
            <CustomFieldsEditor
              fields={fieldDefs}
              value={customFields}
              onChange={setCustomFields}
              mode="lead"
            />
          </div>
        )}

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={edit.isPending}>
            {t("Cancelar")}
          </Button>
        )}
        <Button type="submit" disabled={edit.isPending}>
          {edit.isPending ? t("Salvando…") : t("Salvar")}
        </Button>
      </div>
    </form>
  );
}
