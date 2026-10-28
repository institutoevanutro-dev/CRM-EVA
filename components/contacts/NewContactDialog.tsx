"use client";
import { useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { normalizarTags } from "@/lib/contacts/tag-normalizada";
import { contactCreateSchema, type ContactCreate } from "@/lib/schemas/contacts";
import type { Contact } from "@/lib/types/contacts";
import { useCreateContact } from "@/hooks/contacts/useCreateContact";
import {
  AbrirConversaAposSalvar,
  type AlvoDeConversaAposSalvar,
} from "@/components/inbox/AbrirConversaAposSalvar";

interface FormShape {
  name?: string;
  email?: string;
  phone_number?: string;
  cpf?: string;
  birthdate?: string;
  endereco?: string;
  tagsRaw?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /**
   * Nome já digitado por quem chamou, para não redigitar. Quem abre com um termo
   * de busca em mãos passa aqui; o resto continua abrindo vazio.
   *
   * É `defaultValue` do formulário, então só vale na montagem — quem precisa
   * trocar o termo com o diálogo já montado remonta com `key`.
   */
  nomeInicial?: string;
  /**
   * Recebe o contato recém-criado. Existe para quem abriu o diálogo NO MEIO de
   * outro fluxo (marcar um horário, por exemplo) poder seguir com ele já
   * selecionado, em vez de mandar a pessoa procurar de novo o que acabou de criar.
   */
  onCriado?: (contato: Contact) => void;
  /**
   * Só o cadastro que conclui a jornada pode navegar para a conversa. Quem
   * fornece um contato a outro formulário (negócio, agendamento) desliga, para
   * preservar o rascunho que está em edição.
   */
  permitirIniciarConversa?: boolean;
}

export function NewContactDialog({
  open,
  onOpenChange,
  nomeInicial,
  onCriado,
  permitirIniciarConversa = true,
}: Props) {
  const t = useT();
  const create = useCreateContact();
  /** A conversa a abrir depois de salvar — `null` = nada pendente. */
  const [conversaAoSalvar, setConversaAoSalvar] = useState<AlvoDeConversaAposSalvar | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<FormShape>({
    defaultValues: { name: nomeInicial ?? "", email: "", phone_number: "", cpf: "", birthdate: "", endereco: "", tagsRaw: "" },
  });

  async function onSubmit(values: FormShape) {
    await salvar(values, false);
  }

  /**
   * Grava o contato e, se pedido, já abre a conversa dele (porte do original
   * #3547). O contato é gravado ANTES: se abrir falhar (sem canal, sem
   * telefone, papel insuficiente), o cadastro não é desfeito nem escondido. O
   * telefone que vale é o que a rota GRAVOU, não o digitado.
   */
  async function salvar(values: FormShape, abrir: boolean) {
    setServerError(null);
    // A MESMA normalização da API (lib/contacts/tag-normalizada): o que a ficha
    // grava é o que o filtro `?tag=` casa (issue #1224).
    const tags = normalizarTags((values.tagsRaw ?? "").split(","));

    const payload: Record<string, unknown> = { source: "manual" };
    if (values.name?.trim()) payload.name = values.name.trim();
    if (values.email?.trim()) payload.email = values.email.trim();
    if (values.phone_number?.trim()) payload.phone_number = values.phone_number.trim();
    if (values.cpf?.trim()) payload.cpf = values.cpf.trim();
    if (values.birthdate) payload.birthdate = values.birthdate;
    if (values.endereco?.trim()) payload.custom_fields = { endereco: values.endereco.trim() };
    if (tags.length) payload.tags = tags;

    const parsed = contactCreateSchema.safeParse(payload);
    if (!parsed.success) {
      // A frase vem do schema em português; `t()` a traduz quando há entrada
      // (a do telefone tem) e a devolve como veio quando não há.
      const first = parsed.error.issues[0];
      setServerError(first?.message ? t(first.message) : t("Dados inválidos"));
      return;
    }

    let contato: Contact | undefined;
    try {
      const resposta = await create.mutateAsync(parsed.data as ContactCreate);
      // `.data` é o envelope do `ok()`, e dentro dele mora `{ contact, action }`.
      // Entregar `resposta.data` aqui devolveria esse envelope como se fosse o
      // contato: o `id` sairia `undefined` e a marcação ficaria sem ninguém, em
      // silêncio. Quem garante que este caminho não volta a errar é o tipo do
      // hook, ligado ao retorno da rota.
      contato = resposta?.data?.contact;
    } catch {
      // error toast already handled by hook — e nada foi criado.
      return;
    }

    toast.success(t("Contato criado"));
    form.reset();
    onOpenChange(false);
    if (!contato) return;
    onCriado?.(contato);
    if (!abrir || !permitirIniciarConversa) return;
    if (!contato.phone_number) {
      toast.info(t("Contato salvo. Cadastre um telefone para abrir a conversa."));
      return;
    }
    setConversaAoSalvar({ contact_id: contato.id });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Novo contato")}</DialogTitle>
          <DialogDescription>
            {t("Preencha pelo menos um identificador (email ou telefone).")}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            // O portal mantém a árvore React: o submit deste subcadastro não
            // pode submeter também o negócio ou a marcação ainda em edição.
            event.stopPropagation();
            void form.handleSubmit(onSubmit)(event);
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="name">{t("Nome")}</Label>
            <Input id="name" {...form.register("name")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" {...form.register("email")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone_number">{t("Telefone (DDD + número)")}</Label>
            <Input
              id="phone_number"
              placeholder="+5511999998888"
              {...form.register("phone_number")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cpf">{t("CPF (opcional)")}</Label>
            <Input id="cpf" placeholder="00000000000" {...form.register("cpf")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="birthdate">{t("Data de nascimento")}</Label>
            <Input id="birthdate" type="date" {...form.register("birthdate")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="endereco">{t("Endereço")}</Label>
            <Textarea id="endereco" rows={2} {...form.register("endereco")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tagsRaw">{t("Tags (separadas por vírgula)")}</Label>
            <Input id="tagsRaw" placeholder="vip, recompra" {...form.register("tagsRaw")} />
          </div>
          {serverError && (
            <p className="text-sm text-error-fg">{serverError}</p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              {t("Cancelar")}
            </Button>
            {permitirIniciarConversa && (
              <Button
                type="button"
                variant="secondary"
                disabled={create.isPending}
                onClick={form.handleSubmit((values) => void salvar(values, true))}
              >
                {t("Salvar e iniciar conversa")}
              </Button>
            )}
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? t("Criando…") : t("Criar contato")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      {/* FORA do `DialogContent`: o cadastro FECHA ao salvar e a abertura da
          conversa vem depois; dentro, morreria junto com o formulário. */}
      {conversaAoSalvar && <AbrirConversaAposSalvar alvo={conversaAoSalvar} />}
    </Dialog>
  );
}
