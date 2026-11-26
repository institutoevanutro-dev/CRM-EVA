"use client";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useEditLead } from "@/hooks/kanban/useUpdateLead";
import type { Lead } from "@/lib/types/leads";
import { updateLeadSchema, type UpdateLeadInput } from "@/lib/schemas/leads";
import { MOEDA_PADRAO, formatCents, parseReaisToCents } from "@/lib/money";
import { useVendasDoNegocio } from "@/hooks/vendas/useVendasRegistradas";
import { EcoDoValor } from "./EcoDoValor";

interface FormShape {
  title: string;
  description: string;
  valueReais: string;
  tagsRaw: string;
  expected_close_date: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  lead: Lead;
  pipelineId: string;
}

function centsToReais(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2).replace(".", ",");
}

export function EditLeadDialog({ open, onOpenChange, lead, pipelineId }: Props) {
  const t = useT();
  const edit = useEditLead(pipelineId);
  // Com venda registrada, o Valor é derivado da soma das vendas pelo banco
  // (migration 0424); o diálogo mostra a soma em leitura e não reenvia `value_cents`.
  const moedaDoValor = (lead.currency ?? MOEDA_PADRAO).toUpperCase();
  const { data: vendas } = useVendasDoNegocio(lead.id);
  const vendasDoNegocio = Array.isArray(vendas) ? vendas : [];
  const valorPelasVendas = vendasDoNegocio.length > 0 || lead.valor_pelas_vendas === true;
  const somaDasVendas =
    vendasDoNegocio.length > 0
      ? vendasDoNegocio.reduce(
          (soma, v) => soma + (v.currency.toUpperCase() === moedaDoValor ? v.valor_cents : 0),
          0,
        )
      : (lead.value_cents ?? 0);

  const form = useForm<FormShape>({
    defaultValues: {
      title: lead.title,
      description: lead.description ?? "",
      valueReais: centsToReais(lead.value_cents),
      tagsRaw: (lead.tags ?? []).join(", "),
      expected_close_date: lead.expected_close_date ?? "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        title: lead.title,
        description: lead.description ?? "",
        valueReais: centsToReais(lead.value_cents),
        tagsRaw: (lead.tags ?? []).join(", "),
        expected_close_date: lead.expected_close_date ?? "",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lead.id]);

  async function onSubmit(values: FormShape) {
    const tags = values.tagsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    let valueCents: number | null = null;
    if (!valorPelasVendas) {
      const reais = values.valueReais.trim();
      if (reais.length > 0) {
        valueCents = parseReaisToCents(reais);
        if (valueCents === null) {
          form.setError("valueReais", { message: t("Valor inválido") });
          return;
        }
      }
    }

    const patch: Record<string, unknown> = {
      title: values.title.trim(),
      description: values.description.trim() ? values.description.trim() : null,
      // Com venda registrada, o valor é do banco (a soma): o diálogo não o reescreve.
      ...(valorPelasVendas ? {} : { value_cents: valueCents }),
      tags,
      expected_close_date: values.expected_close_date || null,
    };

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
      toast.success(t("Lead atualizado"));
      onOpenChange(false);
    } catch {
      // toast already shown
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Editar lead")}</DialogTitle>
          <DialogDescription>
            {t("Atualize os campos. Mover de etapa ou marcar ganho/perdido tem opções próprias.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
              {valorPelasVendas ? (
                <>
                  <Input
                    id="valueReais"
                    readOnly
                    aria-readonly
                    data-testid="valor-pelas-vendas"
                    value={formatCents(somaDasVendas, moedaDoValor)}
                    className="bg-surface-elevated"
                  />
                  <p className="text-xs text-text-muted" data-testid="valor-pelas-vendas-legenda">
                    {vendasDoNegocio.length > 0
                      ? `${t("Soma de")} ${vendasDoNegocio.length} ${t("venda(s) registrada(s)")}`
                      : t("Soma das vendas registradas")}
                  </p>
                </>
              ) : (
                <>
                  <Input
                    id="valueReais"
                    inputMode="decimal"
                    placeholder="0,00"
                    {...form.register("valueReais")}
                  />
                  <EcoDoValor control={form.control} />
                  {form.formState.errors.valueReais && (
                    <p className="text-xs text-error-fg">
                      {form.formState.errors.valueReais.message}
                    </p>
                  )}
                </>
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
            <Label htmlFor="tagsRaw">{t("Tags (separadas por vírgula)")}</Label>
            <Input id="tagsRaw" placeholder="vip, recompra" {...form.register("tagsRaw")} />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={edit.isPending}
            >
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={edit.isPending}>
              {edit.isPending ? t("Salvando…") : t("Salvar")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
