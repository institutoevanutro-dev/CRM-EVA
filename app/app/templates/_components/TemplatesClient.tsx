"use client";

import { useT } from "@/hooks/i18n/useT";
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ChatCircle, MagnifyingGlass, Plus, PencilSimple, Trash, Warning } from "@/lib/ui/icons";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/empty/EmptyState";
import { EmptyFilterResults } from "@/components/empty/variants";
import { CabecalhoDaPagina } from "@/components/shell/CabecalhoDaPagina";
import { agruparPorAssunto, casaComBusca, pedacosDoTexto } from "@/lib/respostas/organizar";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useMessageTemplates, type MessageTemplate } from "@/hooks/inbox/useMessageTemplates";
import { TemplateFormDialog } from "./TemplateFormDialog";

const TEMPLATES_KEY = ["message-templates"];

interface Props {
  canShare: boolean;
  currentUserId: string;
}

export function TemplatesClient({ canShare, currentUserId }: Props) {
  const t = useT();
  const { data: templates, isLoading, isError, refetch } = useMessageTemplates();
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/api/v1/message-templates/${id}`),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  });
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MessageTemplate | null>(null);

  const openNew = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (template: MessageTemplate) => {
    setEditing(template);
    setFormOpen(true);
  };

  const [busca, setBusca] = React.useState("");
  const grupos = React.useMemo(
    () => agruparPorAssunto((templates ?? []).filter((r) => casaComBusca(r, busca))),
    [templates, busca],
  );

  const cabecalho = (
    <CabecalhoDaPagina
      titulo={t("Respostas rápidas")}
      descricao={t("Textos prontos para responder mais rápido; pessoais ou compartilhados com a equipe.")}
      acoes={
        <Button type="button" onClick={openNew}>
          <Plus /> {t("Nova resposta")}
        </Button>
      }
    />
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        {cabecalho}
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {cabecalho}
      {isError ? (
        // Falha de carga não pode parecer lista vazia: a equipe concluiria que
        // as respostas sumiram.
        <EmptyState
          icon={Warning}
          headline="Não foi possível carregar as respostas."
          primary={{ label: "Tentar de novo", onClick: () => void refetch() }}
        />
      ) : !templates?.length ? (
        <EmptyState
          icon={ChatCircle}
          headline="Nenhuma resposta rápida ainda"
          subcopy="Salve aqui os textos que a equipe manda todo dia. No Inbox, digite / para usar."
          primary={{ label: "Nova resposta", onClick: openNew }}
        />
      ) : (
        <>
          <div className="relative max-w-md">
            <MagnifyingGlass
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle"
              aria-hidden
            />
            <Input
              type="search"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder={t("Buscar por título ou texto…")}
              aria-label={t("Buscar respostas")}
              className="pl-9"
            />
          </div>
          {grupos.length === 0 ? (
            <EmptyFilterResults />
          ) : (
            grupos.map((grupo) => (
              <section key={grupo.assunto ?? "-"} className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                  {grupo.assunto ?? t("Outras")}
                  <span className="ml-1.5 font-normal normal-case tracking-normal">· {grupo.itens.length}</span>
                </h2>
                <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
                  {grupo.itens.map(({ item: template, nome }) => {
                    // Só quem pode editar/apagar pela RLS vê as ações: o dono do
                    // pessoal, ou manager+ no compartilhado (owner null). Sem isto, um
                    // agent veria botões que o backend rejeita (404/nada apagado).
                    const canModify =
                      template.owner_user_id === currentUserId ||
                      (template.owner_user_id === null && canShare);
                    return (
                      <li key={template.id} className="flex items-start justify-between gap-4 p-4">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{nome}</span>
                            {template.owner_user_id ? (
                              <Badge variant="neutral">{t("Pessoal")}</Badge>
                            ) : null}
                          </div>
                          <p className="line-clamp-2 text-sm text-text-muted">
                            {pedacosDoTexto(template.body).map((p, i) =>
                              p.tipo === "variavel" ? (
                                <span
                                  key={i}
                                  className="mx-0.5 rounded bg-accent-soft px-1 py-px text-xs font-medium text-accent-hover"
                                >
                                  {t(p.valor)}
                                </span>
                              ) : (
                                <React.Fragment key={i}>{p.valor}</React.Fragment>
                              ),
                            )}
                          </p>
                        </div>
                        {canModify && (
                          <div className="flex shrink-0 gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={t("Editar resposta")}
                              title={t("Editar resposta")}
                              onClick={() => openEdit(template)}
                            >
                              <PencilSimple />
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  aria-label={t("Excluir resposta")}
                                  title={t("Excluir resposta")}
                                >
                                  <Trash />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>{t("Excluir esta resposta?")}</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    {t("Essa ação não pode ser desfeita.")}
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() =>
                                      del.mutate(template.id, {
                                        onSuccess: () => toast.success(t("Resposta excluída.")),
                                      })
                                    }
                                  >
                                    {t("Excluir")}
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </>
      )}
      <TemplateFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        canShare={canShare}
        template={editing}
      />
    </div>
  );
}
