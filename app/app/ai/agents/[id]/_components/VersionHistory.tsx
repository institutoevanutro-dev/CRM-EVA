"use client";
/**
 * VersionHistory — timeline de versions com diff e revert (S-13.12).
 *
 * Cada linha: badge status + número + timestamps + ações:
 *   - "Diff": abre dialog comparando essa version contra a "outra ponta"
 *     (se essa for published → compara com latest draft; senão compara com
 *      published vigente. Fallback: a anterior na lista).
 *   - "Reverter": admin only, exclui draft da própria linha. Cria nova
 *     version-published clonada.
 *   - "Abrir no editor": para o rascunho que ficou para trás (o "Reverter" e o
 *     "Aplicar proposta" publicam por cima dele, e ele deixava de abrir — sem
 *     caminho de volta pela tela).
 *
 * A lista chega SEM o texto das instruções (ver `AgentVersionSummary`): o texto
 * de uma versão só é buscado quando alguém a compara ou a abre.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

import type { AgentVersionRow, AgentVersionSummary } from "@/hooks/ai/useAgentVersions";
import { revertToVersionAction } from "../_actions";
import { VersionDiff } from "./VersionDiff";
import { NomeDoModelo } from "./ModelPicker";

interface Props {
  agentId: string;
  versions: AgentVersionSummary[];
  readOnly?: boolean;
  /** O rascunho que está no editor — o "Reverter" o tira de lá. */
  rascunhoVigente?: Pick<AgentVersionRow, "id" | "version_number"> | null;
  /** Texto não salvo na Configuração: reverter ou abrir outra versão o perderia. */
  alteracoesNaoSalvas?: boolean;
  onIrParaConfiguracao?: () => void;
  onAbrirNoEditor?: (versao: AgentVersionRow) => void;
  /** Para o comparar nomear materiais e funis. */
  materiais?: ReadonlyArray<{ id: string; name: string }>;
  funis?: ReadonlyArray<{ id: string; name: string }>;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "secondary",
  published: "default",
  superseded: "outline",
  archived: "destructive",
};

/** Rótulo em pt-BR para passar por `t()` no render — a chave do dicionário é sempre pt-BR. */
const STATUS_LABEL_PT: Record<string, string> = {
  draft: "Rascunho",
  published: "Publicado",
  superseded: "Substituída",
  archived: "Arquivado",
};

function pickCounterpart(
  versions: AgentVersionSummary[],
  target: AgentVersionSummary,
): AgentVersionSummary | null {
  if (target.status === "published") {
    const latestDraft = versions
      .filter((v) => v.status === "draft")
      .sort((a, b) => b.version_number - a.version_number)[0];
    if (latestDraft) return latestDraft;
  }
  const published = versions.find((v) => v.status === "published");
  if (published && published.id !== target.id) return published;
  // Fallback: a versão imediatamente anterior na lista cronológica.
  const sorted = [...versions].sort((a, b) => b.version_number - a.version_number);
  const idx = sorted.findIndex((v) => v.id === target.id);
  if (idx >= 0 && idx + 1 < sorted.length) return sorted[idx + 1] ?? null;
  return null;
}

export function VersionHistory({
  agentId,
  versions,
  readOnly,
  rascunhoVigente = null,
  alteracoesNaoSalvas = false,
  onIrParaConfiguracao,
  onAbrirNoEditor,
  materiais,
  funis,
}: Props) {
  const t = useT();
  const router = useRouter();
  const [diffOpen, setDiffOpen] = React.useState(false);
  const [diffPair, setDiffPair] = React.useState<{
    a: AgentVersionRow;
    b: AgentVersionRow;
  } | null>(null);
  const [carregando, setCarregando] = React.useState<string | null>(null);

  const [revertTarget, setRevertTarget] = React.useState<AgentVersionSummary | null>(null);
  const [reverting, setReverting] = React.useState(false);

  const sorted = React.useMemo(
    () => [...versions].sort((a, b) => b.version_number - a.version_number),
    [versions],
  );

  if (sorted.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("Nenhuma versão criada ainda.")}</p>;
  }

  async function versaoCompleta(id: string): Promise<AgentVersionRow> {
    const res = await apiClient.get<{ data: AgentVersionRow }>(
      `/api/v1/ai/agents/${agentId}/versions/${id}`,
    );
    return res.data;
  }

  async function openDiff(target: AgentVersionSummary) {
    const counterpart = pickCounterpart(sorted, target);
    if (!counterpart) {
      toast.info(t("Não há outra versão para comparar."));
      return;
    }
    // a = mais antiga, b = mais nova
    const [antiga, nova] =
      target.version_number < counterpart.version_number
        ? [target, counterpart]
        : [counterpart, target];
    setCarregando(target.id);
    try {
      const [a, b] = await Promise.all([versaoCompleta(antiga.id), versaoCompleta(nova.id)]);
      setDiffPair({ a, b });
      setDiffOpen(true);
    } catch {
      toast.error(t("Não foi possível carregar as versões. Tente de novo."));
    } finally {
      setCarregando(null);
    }
  }

  async function abrirNoEditor(v: AgentVersionSummary) {
    if (!onAbrirNoEditor) return;
    setCarregando(v.id);
    try {
      onAbrirNoEditor(await versaoCompleta(v.id));
      toast.success(t("Rascunho aberto no editor. Salve para guardar."));
    } catch {
      toast.error(t("Não foi possível carregar as versões. Tente de novo."));
    } finally {
      setCarregando(null);
    }
  }

  async function handleRevert() {
    if (!revertTarget) return;
    setReverting(true);
    const targetNum = revertTarget.version_number;
    try {
      const res = await revertToVersionAction(agentId, revertTarget.id);
      if (!res.ok) {
        toast.error(res.message ?? `${t("Erro")}: ${res.error}`);
        return;
      }
      toast.success(
        `${t("Revertido para versão equivalente a v")}${targetNum}${t(" (publicada como v")}${res.data!.new_version_number}).`,
      );
      setRevertTarget(null);
      router.refresh();
    } finally {
      setReverting(false);
    }
  }

  return (
    <>
      {alteracoesNaoSalvas && !readOnly ? (
        <div
          role="status"
          className="mb-3 space-y-2 rounded-md border border-warning/40 bg-warning-bg p-3 text-xs"
        >
          <p className="font-medium text-warning-fg">
            {t("Há mudanças não salvas na Configuração.")}
          </p>
          <p className="text-muted-foreground">
            {t("Salve ou descarte antes de reverter ou de abrir outra versão.")}
          </p>
          {onIrParaConfiguracao ? (
            <Button variant="outline" size="sm" onClick={onIrParaConfiguracao}>
              {t("Ir para a Configuração")}
            </Button>
          ) : null}
        </div>
      ) : null}

      <ol className="flex flex-col gap-2">
        {sorted.map((v) => {
          const canRevert =
            !readOnly && v.status !== "draft" && v.status !== "archived";
          // Rascunho que não é o do editor: o "Reverter" ou uma proposta
          // publicaram por cima dele. Ele não abre sozinho — daqui, abre.
          const rascunhoAntigo = v.status === "draft" && v.id !== rascunhoVigente?.id;
          return (
            <li
              key={v.id}
              className="flex flex-wrap items-center gap-3 rounded-md border border-border/60 p-3 text-sm"
            >
              <Badge variant={STATUS_VARIANT[v.status] ?? "outline"} className="text-xs">
                {rascunhoAntigo ? t("Rascunho antigo") : t(STATUS_LABEL_PT[v.status] ?? v.status)}
              </Badge>
              <span className="font-mono">v{v.version_number}</span>
              <span className="text-xs text-muted-foreground">
                {new Date(v.created_at).toLocaleString()}
              </span>
              <span className="text-xs text-muted-foreground">
                <NomeDoModelo provider={v.provider} model={v.model} />
              </span>
              {v.published_at ? (
                <span className="text-xs text-muted-foreground">
                  {t("publicada em")} {new Date(v.published_at).toLocaleString()}
                </span>
              ) : null}
              <div className="ml-auto flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={carregando === v.id}
                  onClick={() => void openDiff(v)}
                >
                  {t("Comparar")}
                </Button>
                {rascunhoAntigo && !readOnly && onAbrirNoEditor ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={alteracoesNaoSalvas || carregando === v.id}
                    onClick={() => void abrirNoEditor(v)}
                  >
                    {t("Abrir no editor")}
                  </Button>
                ) : null}
                {canRevert ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={alteracoesNaoSalvas}
                    onClick={() => setRevertTarget(v)}
                  >
                    {t("Voltar a esta versão")}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      <Dialog open={diffOpen} onOpenChange={setDiffOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {diffPair
                ? `${t("Comparar v")}${diffPair.a.version_number}${t(" ↔ v")}${diffPair.b.version_number}`
                : t("Comparar")}
            </DialogTitle>
          </DialogHeader>
          {diffPair ? <VersionDiff
              versionA={diffPair.a}
              versionB={diffPair.b}
              materiais={materiais}
              funis={funis}
            /> : null}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={revertTarget != null}
        onOpenChange={(o) => !o && setRevertTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Voltar para a v")}{revertTarget?.version_number}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("Uma cópia da v")}
              {revertTarget?.version_number}
              {t(" vai ao ar agora, no lugar da versão publicada. A versão de agora continua no Histórico.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {rascunhoVigente ? (
            <p data-testid="reverter-tira-o-rascunho" className="text-sm text-warning-fg">
              {t("O rascunho v")}
              {rascunhoVigente.version_number}
              {t(", ainda não publicado, sai do editor. Ele fica no Histórico e pode ser aberto de novo.")}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reverting}>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRevert} disabled={reverting}>
              {reverting ? t("Voltando…") : t("Voltar a esta versão")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
