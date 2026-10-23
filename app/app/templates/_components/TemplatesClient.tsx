"use client";

import { useT } from "@/hooks/i18n/useT";
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";

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
import { ChatCircle, DragHandle, MagnifyingGlass, Plus, PencilSimple, Trash, Warning } from "@/lib/ui/icons";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/empty/EmptyState";
import { EmptyFilterResults } from "@/components/empty/variants";
import { CabecalhoDaPagina } from "@/components/shell/CabecalhoDaPagina";
import { agruparPorAssunto, casaComBusca, pedacosDoTexto } from "@/lib/respostas/organizar";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import {
  CHAVE_DOS_TEMPLATES,
  useMessageTemplates,
  useMoverTemplate,
  type MessageTemplate,
} from "@/hooks/inbox/useMessageTemplates";
import { cn } from "@/lib/utils";
import { TemplateFormDialog } from "./TemplateFormDialog";

const TEMPLATES_KEY = CHAVE_DOS_TEMPLATES;

interface Props {
  canShare: boolean;
  currentUserId: string;
}

/**
 * A tela das respostas rápidas, agrupada por assunto, com a ORDEM que o
 * operador define arrastando (porte do original #3261, migration 0394).
 *
 * O arrasto é DENTRO do assunto (mudar de grupo seria mudar o título) e manda o
 * VIZINHO da esquerda na lista inteira (`depois_de`), nunca o índice. Na
 * primeira posição do assunto, o vizinho é o que vem antes da primeira dele,
 * para o assunto não sair do lugar. A ordem otimista é local e some quando o
 * servidor responde: quem manda na tela continua sendo o backend.
 */
export function TemplatesClient({ canShare, currentUserId }: Props) {
  const t = useT();
  const { data: templates, isLoading, isError, refetch } = useMessageTemplates();
  const qc = useQueryClient();
  const mover = useMoverTemplate();
  // A ordem que o operador acabou de soltar, enquanto o servidor não respondeu.
  const [ordemOtimista, setOrdemOtimista] = React.useState<string[] | null>(null);
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
  // Com busca, a lista está recortada e o lugar onde a resposta cai não está à
  // vista: a alça some até a busca ser limpa.
  const buscando = busca.trim() !== "";
  /** A lista do servidor, com a ordem otimista por cima enquanto ela existe. */
  const lista = React.useMemo(() => {
    const base = templates ?? [];
    if (!ordemOtimista) return base;
    const porId = new Map(base.map((tpl) => [tpl.id, tpl]));
    const ordenada = ordemOtimista.flatMap((id) => porId.get(id) ?? []);
    return [...ordenada, ...base.filter((tpl) => !ordemOtimista.includes(tpl.id))];
  }, [templates, ordemOtimista]);
  const grupos = React.useMemo(
    () => agruparPorAssunto(lista.filter((r) => casaComBusca(r, busca))),
    [lista, busca],
  );

  function aoSoltar({ source, destination, draggableId }: DropResult) {
    if (!destination || destination.droppableId !== source.droppableId) return;
    if (destination.index === source.index) return;
    const grupo = grupos[Number(source.droppableId.replace("assunto-", ""))];
    if (!grupo) return;
    const doAssunto = grupo.itens.map(({ item }) => item.id).filter((id) => id !== draggableId);
    const ids = lista.map((tpl) => tpl.id).filter((id) => id !== draggableId);
    const depoisDe =
      destination.index > 0
        ? doAssunto[destination.index - 1]!
        : (ids[ids.indexOf(doAssunto[0]!) - 1] ?? null);
    ids.splice(depoisDe === null ? 0 : ids.indexOf(depoisDe) + 1, 0, draggableId);
    setOrdemOtimista(ids);
    mover.mutate(
      { id: draggableId, depoisDe },
      {
        onError: (erro) => {
          setOrdemOtimista(null);
          showApiError(erro);
        },
        // O `onSuccess` do hook já releu a lista (a invalidação é esperada).
        onSuccess: () => setOrdemOtimista(null),
      },
    );
  }

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
            <DragDropContext onDragEnd={aoSoltar}>
              {grupos.map((grupo, g) => (
                <section key={grupo.assunto ?? "-"} className="space-y-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                    {grupo.assunto ?? t("Outras")}
                    <span className="ml-1.5 font-normal normal-case tracking-normal">· {grupo.itens.length}</span>
                  </h2>
                  <Droppable droppableId={`assunto-${g}`}>
                    {(provided) => (
                      <ul
                        ref={provided.innerRef}
                        {...provided.droppableProps}
                        className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface"
                      >
                        {grupo.itens.map(({ item: template, nome }, indice) => {
                          // Só quem pode editar/apagar pela RLS vê as ações: o dono do
                          // pessoal, ou manager+ no compartilhado (owner null). Sem isto, um
                          // agent veria botões que o backend rejeita (404/nada apagado).
                          const canModify =
                            template.owner_user_id === currentUserId ||
                            (template.owner_user_id === null && canShare);
                          // A mesma régua move: o `agent` que arrastasse uma compartilhada
                          // veria o soltar ser recusado pela policy.
                          const podeMover = canModify && !buscando;
                          return (
                            <Draggable
                              key={template.id}
                              draggableId={template.id}
                              index={indice}
                              isDragDisabled={!podeMover || mover.isPending}
                            >
                              {(provido, instantaneo) => (
                                <li
                                  ref={provido.innerRef}
                                  {...provido.draggableProps}
                                  className={cn(
                                    "flex items-start justify-between gap-4 bg-surface p-4",
                                    instantaneo.isDragging && "rounded-xl shadow-md ring-1 ring-accent/40",
                                  )}
                                >
                                  <div className="flex min-w-0 items-start gap-2">
                                    {podeMover && (
                                      <span
                                        {...provido.dragHandleProps}
                                        aria-label={t("Arrastar para reordenar")}
                                        title={t("Arrastar para reordenar")}
                                        className="mt-0.5 shrink-0 cursor-grab text-text-muted"
                                      >
                                        <DragHandle size={16} aria-hidden />
                                      </span>
                                    )}
                                    <div className="min-w-0 space-y-1">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-medium">{nome}</span>
                                        {template.owner_user_id ? (
                                          <Badge variant="neutral">{t("Pessoal")}</Badge>
                                        ) : null}
                                        {/* A resposta rápida com imagem se anuncia na lista. */}
                                        {template.media_item_ids && template.media_item_ids.length > 0 ? (
                                          <Badge variant="neutral">
                                            {t("Imagens")} {template.media_item_ids.length}
                                          </Badge>
                                        ) : null}
                                      </div>
                                      <p className="line-clamp-2 text-sm text-text-muted">
                                        {pedacosDoTexto(template.body).map((p, i) =>
                                          p.tipo === "variavel" ? (
                                            <span
                                              key={i}
                                              className="mx-0.5 rounded-sm bg-accent-soft px-1 py-px text-xs font-medium text-accent-hover"
                                            >
                                              {t(p.valor)}
                                            </span>
                                          ) : (
                                            <React.Fragment key={i}>{p.valor}</React.Fragment>
                                          ),
                                        )}
                                      </p>
                                    </div>
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
                              )}
                            </Draggable>
                          );
                        })}
                        {provided.placeholder}
                      </ul>
                    )}
                  </Droppable>
                </section>
              ))}
            </DragDropContext>
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
