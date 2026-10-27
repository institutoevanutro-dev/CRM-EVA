"use client";

import { useT } from "@/hooks/i18n/useT";
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { MessageTemplate } from "@/hooks/inbox/useMessageTemplates";

import { ImagensDaBiblioteca } from "./ImagensDaBiblioteca";

const TEMPLATES_KEY = ["message-templates"];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canShare: boolean;
  template?: MessageTemplate | null;
}

interface CreateInput {
  title: string;
  body: string;
  shortcut?: string;
  shared?: boolean;
  media_item_ids?: string[];
  /** "Mostrar na barra do Inbox" (migration 0398) — ausente é ligado. */
  mostrar_na_barra?: boolean;
}

interface UpdateInput {
  id: string;
  title: string;
  body: string;
  shortcut: string | null;
  media_item_ids?: string[];
  mostrar_na_barra?: boolean;
}

export function TemplateFormDialog({ open, onOpenChange, canShare, template }: Props) {
  const t = useT();
  const isEdit = !!template;
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [shortcut, setShortcut] = React.useState("");
  const [shared, setShared] = React.useState(false);
  /** "Mostrar na barra do Inbox" (migration 0398). Nasce LIGADO, como a coluna. */
  const [mostrarNaBarra, setMostrarNaBarra] = React.useState(true);
  /** Itens da Biblioteca de mídia, na ordem (migration 0383). */
  const [imagens, setImagens] = React.useState<string[]>([]);

  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: async (input: CreateInput) =>
      apiClient.post<{ data: MessageTemplate }>("/api/v1/message-templates", input),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  });
  const update = useMutation({
    mutationFn: async ({ id, ...input }: UpdateInput) =>
      apiClient.patch<{ data: MessageTemplate }>(`/api/v1/message-templates/${id}`, input),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  });
  const pending = create.isPending || update.isPending;

  React.useEffect(() => {
    if (!open) return;
    setTitle(template?.title ?? "");
    setBody(template?.body ?? "");
    setShortcut(template?.shortcut ?? "");
    setShared(template ? template.owner_user_id === null : false);
    setImagens(template?.media_item_ids ?? []);
    setMostrarNaBarra(template ? template.mostrar_na_barra !== false : true);
  }, [open, template]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (isEdit) {
        await update.mutateAsync({
          id: template.id,
          title,
          body,
          shortcut: shortcut.trim() || null,
          mostrar_na_barra: mostrarNaBarra,
          // A biblioteca é de manager+: quem não a vê não reescreve a lista.
          ...(canShare ? { media_item_ids: imagens } : {}),
        });
        toast.success(t("Resposta atualizada."));
      } else {
        await create.mutateAsync({
          title,
          body,
          shortcut: shortcut.trim() || undefined,
          shared: canShare ? shared : false,
          mostrar_na_barra: mostrarNaBarra,
          ...(canShare && imagens.length ? { media_item_ids: imagens } : {}),
        });
        toast.success(t("Resposta criada."));
      }
      onOpenChange(false);
    } catch {
      /* erro já mostrado pelo showApiError */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? t("Editar resposta") : t("Nova resposta")}</DialogTitle>
          <DialogDescription>
            {t("Scripts salvos para responder mais rápido no atendimento.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tpl-title">{t("Título")}</Label>
            <Input
              id="tpl-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("Saudação inicial")}
              minLength={1}
              maxLength={80}
              required
            />
            <p className="text-xs text-muted-foreground">
              {t("Para agrupar na lista, comece pelo assunto: ATENDIMENTO · Saudação.")}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tpl-body">{t("Mensagem")}</Label>
            <Textarea
              id="tpl-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t("Oi {{primeiro_nome}}, tudo bem?")}
              minLength={1}
              maxLength={4096}
              required
              rows={5}
            />
            <p className="text-xs text-muted-foreground">
              {t("Use")} {"{{primeiro_nome}}"} {t("e")} {"{{nome}}"} {t("para personalizar.")}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tpl-shortcut">{t("Atalho (opcional)")}</Label>
            <Input
              id="tpl-shortcut"
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value)}
              placeholder="oi"
              maxLength={40}
            />
            <p className="text-xs text-muted-foreground">
              {t("No Inbox, digite / e o atalho para achar esta resposta (ex.: /oi).")}
            </p>
          </div>
          {canShare && <ImagensDaBiblioteca valor={imagens} onChange={setImagens} disabled={pending} />}
          {canShare && (
            <div className="flex items-center gap-2">
              <Switch
                id="tpl-shared"
                checked={shared}
                onCheckedChange={setShared}
                disabled={isEdit}
              />
              <Label htmlFor="tpl-shared">{t("Compartilhar com a equipe")}</Label>
            </div>
          )}
          {/* Desmarcado, o botão sai da barra do Inbox e a resposta CONTINUA no
              atalho `/` — a dica diz isso, porque a confusão natural é achar
              que tirar da barra apaga a resposta. */}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Switch id="tpl-na-barra" checked={mostrarNaBarra} onCheckedChange={setMostrarNaBarra} />
              <Label htmlFor="tpl-na-barra">{t("Mostrar na barra do Inbox")}</Label>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("Desmarcado, a resposta sai da barra do Inbox e continua no atalho /.")}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={pending}>
              {isEdit ? t("Salvar") : t("Criar resposta")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
