"use client";

import { useState } from "react";

import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { ConfirmarNaTela } from "@/components/inbox/ConfirmarNaTela";
import { ApiError } from "@/lib/api/types";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import type { PublishValidationError } from "@/lib/followup/validate-publish";
import { useT } from "@/hooks/i18n/useT";
import {
  useDisableFollowupFlow,
  usePublishFollowupFlow,
  useRollbackFollowupFlow,
  useSaveFollowupFlowDraft,
  useUpdateHandoffPolicy,
  type FollowupFlowDetailRow,
} from "@/hooks/followup/useFollowupFlow";
import { Trash, TreeStructure } from "@/lib/ui/icons";
import { FlowStatusBadge } from "../../_components/FlowStatusBadge";
import { DeleteFollowupFlowButton } from "../../_components/DeleteFollowupFlowButton";
import { TriggerConfigControl } from "./TriggerConfigControl";

interface Props {
  flowId: string;
  flow: FollowupFlowDetailRow;
  graph: FlowGraph;
  dirty: boolean;
  selection: "node" | "edge" | null;
  onDeleteSelection: () => void;
  onSaved: (graph: FlowGraph) => void;
  onPublishErrors: (errorsByNode: Record<string, string[]>) => void;
  onPublishSuccess: () => void;
  onAutoFit?: () => void;
  canAutoFit?: boolean;
}

const HANDOFF_LABEL: Record<FollowupFlowDetailRow["handoff_policy"], string> = {
  pause: "Pausar quando a equipe assume",
  cancel: "Cancelar quando a equipe assume",
  allow: "Seguir mesmo com a equipe atendendo",
};

export function PublishBar({
  flowId,
  flow,
  graph,
  dirty,
  selection,
  onDeleteSelection,
  onSaved,
  onPublishErrors,
  onPublishSuccess,
  onAutoFit,
  canAutoFit = false,
}: Props) {
  const t = useT();
  const [openDeleteSelection, setOpenDeleteSelection] = useState(false);
  // Publicar manda mensagens a pacientes; desativar e voltar de versão mudam o
  // que está no ar. Nenhum dos três vale com um clique só.
  const [confirmar, setConfirmar] = useState<"publicar" | "desativar" | "voltar" | null>(null);
  const save = useSaveFollowupFlowDraft(flowId);
  const publish = usePublishFollowupFlow(flowId);
  const disable = useDisableFollowupFlow(flowId);
  const rollback = useRollbackFollowupFlow(flowId);
  const handoffPolicy = useUpdateHandoffPolicy(flowId);

  const onSave = () => {
    save.mutate(graph, { onSuccess: () => onSaved(graph) });
  };

  const onPublish = async () => {
    try {
      await save.mutateAsync(graph);
      onSaved(graph);
    } catch {
      return; // save's own onError already toasted — don't attempt publish on a failed save
    }

    publish.mutate(undefined, {
      onSuccess: (publicado) => {
        const avisos = publicado.warnings ?? [];
        if (avisos.length > 0) {
          toast.warning(t("Publicado, mas há mídia que não pode ser enviada agora."), {
            description: avisos.map((w) => w.message).join(" "),
          });
        }
        onPublishSuccess();
      },
      onError: (err) => {
        if (err instanceof ApiError && err.code === "validation_failed") {
          const errors = (err.details?.errors as PublishValidationError[] | undefined) ?? [];
          const byNode: Record<string, string[]> = {};
          const flowLevel: string[] = [];
          for (const e of errors) {
            if (e.node_id) (byNode[e.node_id] ??= []).push(e.message);
            else flowLevel.push(e.message);
          }
          onPublishErrors(byNode);
          toast.error(t("O fluxo tem pendências — corrija os blocos destacados."), {
            description: flowLevel.length > 0 ? flowLevel.join(" ") : undefined,
          });
          return;
        }
        showApiError(err);
      },
    });
  };

  const onDisable = () => disable.mutate();

  const canRollback = flow.versions_count > 1 && flow.previous_version_id !== null;
  const onRollback = () => {
    if (!flow.previous_version_id) return;
    rollback.mutate(flow.previous_version_id);
  };

  const busy = save.isPending || publish.isPending || disable.isPending || rollback.isPending;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3">
      <div className="flex items-center gap-2">
        <h1 className="text-sm font-semibold text-text">{flow.name}</h1>
        <FlowStatusBadge status={flow.status} />
        {dirty && (
          <Badge variant="warning" data-testid="dirty-indicator">
            {t("Alterações não salvas")}
          </Badge>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* O gatilho e a regra da equipe gravam na hora, no fluxo que está no
            ar; os blocos só passam a valer com "Publicar". */}
        <span className="text-xs text-muted-foreground">{t("Valem na hora:")}</span>
        <TriggerConfigControl flowId={flowId} triggerConfig={flow.trigger_config} />

        <Select value={flow.handoff_policy} onValueChange={(v) => handoffPolicy.mutate(v as FollowupFlowDetailRow["handoff_policy"])}>
          <SelectTrigger className="w-56" aria-label={t("Quando a equipe assume a conversa")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(HANDOFF_LABEL) as Array<keyof typeof HANDOFF_LABEL>).map((k) => (
              <SelectItem key={k} value={k}>
                {t(HANDOFF_LABEL[k])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button type="button" variant="secondary" size="sm" disabled={!dirty || busy} onClick={onSave}>
          {save.isPending ? t("Salvando…") : t("Salvar")}
        </Button>
        <Button type="button" size="sm" disabled={busy} onClick={() => setConfirmar("publicar")} data-testid="publish-button">
          {publish.isPending ? t("Publicando…") : t("Publicar")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || flow.status === "disabled"}
          onClick={() => setConfirmar("desativar")}
        >
          {t("Desativar")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || !canRollback}
          onClick={() => setConfirmar("voltar")}
          data-testid="rollback-button"
        >
          {t("Voltar à versão anterior")}
        </Button>
        <ConfirmarNaTela
          aberto={confirmar !== null}
          onAbertoChange={(v) => !v && setConfirmar(null)}
          titulo={
            confirmar === "publicar"
              ? t("Publicar este fluxo?")
              : confirmar === "desativar"
                ? t("Desativar este fluxo?")
                : t("Voltar à versão anterior?")
          }
          descricao={
            confirmar === "publicar"
              ? t("Os blocos passam a valer agora e as mensagens começam a sair para os pacientes que entrarem no fluxo.")
              : confirmar === "desativar"
                ? t("Nenhuma mensagem deste fluxo sai mais até você publicar de novo.")
                : t("O fluxo no ar volta a ser a versão publicada antes desta.")
          }
          acao={
            confirmar === "publicar"
              ? t("Publicar")
              : confirmar === "desativar"
                ? t("Desativar")
                : t("Voltar à versão anterior")
          }
          destrutiva={confirmar === "desativar"}
          onConfirmar={() => {
            if (confirmar === "publicar") void onPublish();
            else if (confirmar === "desativar") onDisable();
            else onRollback();
          }}
        />
        {onAutoFit && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canAutoFit}
            onClick={onAutoFit}
            data-testid="auto-fit-flow"
          >
            <TreeStructure size={14} aria-hidden className="mr-1" />
            {t("Organizar")}
          </Button>
        )}
        {selection ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-destructive"
              data-testid="delete-selection"
              onClick={() => setOpenDeleteSelection(true)}
            >
              <Trash size={14} aria-hidden className="mr-1" />
              {selection === "node" ? t("Excluir bloco") : t("Excluir ligação")}
            </Button>
            <AlertDialog open={openDeleteSelection} onOpenChange={setOpenDeleteSelection}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {selection === "node" ? t("Excluir este bloco?") : t("Excluir esta ligação?")}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {selection === "node"
                      ? t("Este bloco e as ligações dele são apagados. Não é possível desfazer.")
                      : t("A ligação entre os dois blocos é apagada. Não é possível desfazer.")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={(e) => {
                      e.preventDefault();
                      setOpenDeleteSelection(false);
                      onDeleteSelection();
                    }}
                  >
                    {t("Excluir")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : (
          <DeleteFollowupFlowButton flowId={flowId} flowName={flow.name} redirectToList />
        )}
      </div>
    </div>
  );
}
