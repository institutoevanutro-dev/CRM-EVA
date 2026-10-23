"use client";
import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { normalizarTags } from "@/lib/contacts/tag-normalizada";
import { contactPatchSchema, type ContactPatch } from "@/lib/schemas/contacts";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { CustomFieldsEditor, type CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import { EtiquetasDoContato } from "@/components/contacts/EtiquetasDoContato";
import type { Contact } from "@/lib/types/contacts";
import { phoneForDisplay } from "@/lib/channels/phone-variants";

interface FormShape {
  name?: string;
  email?: string;
  phone_number?: string;
  birthdate?: string;
  cpf?: string;
  endereco?: string;
  /** As etiquetas do contato: o seletor com autocompletar grava esta lista. */
  tags?: string[];
  custom_fields?: Record<string, unknown>;
}

interface Props {
  contact: Contact;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Definições vindas de `crm_pipelines.settings.fields[]`. Vazio = a seção some. */
  customFieldDefs?: CustomFieldDef[];
  /** Etiquetas já usadas na organização (`useContactTagVocabulary`). */
  vocabulario?: readonly string[] | null;
  /** `pipelines.settings.canonical_tags` do funil padrão. */
  canonicalTags?: readonly string[] | null;
}

export function EditContactDialog({
  contact,
  open,
  onOpenChange,
  customFieldDefs = [],
  vocabulario,
  canonicalTags,
}: Props) {
  const t = useT();
  const update = useUpdateContact(contact.id);
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<FormShape>({
    defaultValues: {
      name: contact.name ?? "",
      email: contact.email ?? "",
      phone_number: contact.phone_number ? phoneForDisplay(contact.phone_number) : "",
      birthdate: contact.birthdate ?? "",
      cpf: "",
      endereco: typeof contact.custom_fields?.endereco === "string" ? contact.custom_fields.endereco : "",
      tags: contact.tags,
      custom_fields: contact.custom_fields ?? {},
    },
  });

  const customFields = useWatch({ control: form.control, name: "custom_fields" });
  const tags = useWatch({ control: form.control, name: "tags" }) ?? [];
  // A etiqueta que o texto AINDA digitado no campo de etiquetas viraria — o
  // campo avisa pelo `onPendente`, e o `Salvar` inclui isto no payload. Sem
  // isso, quem digita e salva sem Enter perde o texto em silêncio (defeito
  // medido na tela do PR #2831).
  const [etiquetaPendente, setEtiquetaPendente] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      form.reset({
        name: contact.name ?? "",
        email: contact.email ?? "",
        phone_number: contact.phone_number ? phoneForDisplay(contact.phone_number) : "",
        birthdate: contact.birthdate ?? "",
        cpf: "",
        endereco: typeof contact.custom_fields?.endereco === "string" ? contact.custom_fields.endereco : "",
        tags: contact.tags,
        custom_fields: contact.custom_fields ?? {},
      });
    }
  }, [open, contact, form]);

  // Na ficha o diálogo fica MONTADO entre aberturas, e o pendente também:
  // fechar por qualquer caminho o descarta, senão o texto de uma edição
  // cancelada entra no próximo Salvar, e um chip removido volta sozinho.
  function mudarAbertura(v: boolean) {
    if (!v) setEtiquetaPendente(null);
    onOpenChange(v);
  }

  async function onSubmit(values: FormShape) {
    setServerError(null);
    // O texto que ficou NO CAMPO sem Enter não pode sumir ao salvar (defeito
    // medido na tela do PR #2831): quem digita "cliente diamante", ou uma
    // etiqueta que já existe, e clica em Salvar espera a etiqueta gravada. O
    // campo já resolveu o pendente pela MESMA régua do Enter — reusa a grafia
    // existente, ou cria a nova — e ela entra no payload aqui.
    // A MESMA normalização da API (lib/contacts/tag-normalizada): o que a ficha
    // grava é o que o filtro `?tag=` casa (issue #1224).
    const tags = normalizarTags([
      ...(values.tags ?? []),
      ...(etiquetaPendente ? [etiquetaPendente] : []),
    ]);

    const payload: Record<string, unknown> = {};
    if (values.name?.trim()) payload.name = values.name.trim();
    if (values.email?.trim()) payload.email = values.email.trim();
    if (values.phone_number?.trim()) payload.phone_number = values.phone_number.trim();
    if (values.birthdate) payload.birthdate = values.birthdate;
    if (values.cpf?.trim()) payload.cpf = values.cpf.trim();
    payload.tags = tags;
    // Sempre no payload, mesmo vazio: o PATCH SUBSTITUI, e é assim que apagar um
    // campo pela tela chega ao banco.
    const customFields = { ...values.custom_fields };
    if (values.endereco?.trim()) customFields.endereco = values.endereco.trim();
    else delete customFields.endereco;
    payload.custom_fields = customFields;

    const parsed = contactPatchSchema.safeParse(payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      setServerError(first?.message ? t(first.message) : t("Dados inválidos"));
      return;
    }
    try {
      await update.mutateAsync(parsed.data as ContactPatch);
      toast.success(t("Contato atualizado"));
      mudarAbertura(false);
    } catch {
      // hook handles toast
    }
  }

  return (
    <Dialog open={open} onOpenChange={mudarAbertura}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Editar contato")}</DialogTitle>
          <DialogDescription>{t("Atualize os dados deste contato.")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ec-name">{t("Nome")}</Label>
            <Input id="ec-name" {...form.register("name")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-email">Email</Label>
            <Input id="ec-email" type="email" {...form.register("email")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-phone">{t("Telefone (DDD + número)")}</Label>
            <Input id="ec-phone" {...form.register("phone_number")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-birthdate">{t("Data de nascimento")}</Label>
            <Input id="ec-birthdate" type="date" {...form.register("birthdate")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-cpf">CPF</Label>
            <Input id="ec-cpf" inputMode="numeric" autoComplete="off" placeholder={contact.cpf_available ? t("CPF cadastrado — digite para substituir") : t("Somente números")} {...form.register("cpf")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-endereco">{t("Endereço")}</Label>
            <Textarea id="ec-endereco" rows={2} {...form.register("endereco")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-tags">{t("Tags")}</Label>
            <EtiquetasDoContato
              inputId="ec-tags"
              value={tags}
              onPendente={setEtiquetaPendente}
              onChange={(next) => form.setValue("tags", next, { shouldDirty: true })}
              vocabulario={vocabulario}
              canonicalTags={canonicalTags}
              disabled={update.isPending}
            />
          </div>
          {customFieldDefs.length > 0 && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div>
                <h3 className="text-sm font-medium">{t("Campos personalizados")}</h3>
                <p className="text-xs text-muted-foreground">
                  {t("Campos definidos no funil padrão da organização.")}
                </p>
              </div>
              <CustomFieldsEditor
                fields={customFieldDefs}
                mode="contact"
                value={customFields ?? {}}
                onChange={(next) => form.setValue("custom_fields", next, { shouldDirty: true })}
              />
            </div>
          )}
          {serverError && <p className="text-sm text-error-fg">{serverError}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => mudarAbertura(false)}
              disabled={update.isPending}
            >
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? t("Salvando…") : t("Salvar")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
