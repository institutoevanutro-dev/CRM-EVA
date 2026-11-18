"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
/**
 * Aba "Propostas" do agente (Operação Visível F3): melhorias que o flywheel
 * destilou das conversas reais. NADA se aplica sozinho — o botão é o gate
 * humano; aplicar cria uma versão NOVA do agente (publish-por-ponteiro).
 *
 * "Aplicar como versão nova" PUBLICA: a mudança vai aos pacientes no mesmo
 * clique. Por isso ele pergunta antes, mostrando o trecho que entra, e recarrega
 * a página depois — a Configuração ficava na versão velha, e o próximo "Salvar
 * rascunho" desfazia a melhoria.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNowStrict } from "date-fns";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentProposals, useApplyProposal, type ProposalRow } from "@/hooks/ai/useAgentProposals";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";
import { useT } from "@/hooks/i18n/useT";
import { ApiError } from "@/lib/api/types";
import { Brain } from "@/lib/ui/icons";

const TYPE_LABEL: Record<ProposalRow["type"], string> = {
  playbook_bullet: "Regra de playbook",
  golden_case: "Caso exemplar",
  reentry_trigger: "Gatilho de reengajamento",
  org_memory_entry: "Memória da organização",
};

export function ProposalsPanel({
  agentId,
  active,
  readOnly,
  rascunhoVigente = null,
  alteracoesNaoSalvas = false,
  onIrParaConfiguracao,
}: {
  agentId: string;
  active: boolean;
  readOnly?: boolean;
  /** O rascunho em andamento: aplicar publica por cima dele e o tira do editor. */
  rascunhoVigente?: AgentVersionRow | null;
  /** Texto não salvo na Configuração — aplicar agora o deixaria órfão. */
  alteracoesNaoSalvas?: boolean;
  onIrParaConfiguracao?: () => void;
}) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const router = useRouter();
  const { data, isLoading } = useAgentProposals(agentId, active);
  const apply = useApplyProposal(agentId);
  const [confirmando, setConfirmando] = React.useState<ProposalRow | null>(null);

  const handleApply = async (p: ProposalRow) => {
    try {
      await apply.mutateAsync(p.id);
      toast.success(
        p.type === "org_memory_entry"
          ? t("Proposta aplicada como memória da organização.")
          : t("Proposta aplicada como versão nova do agente."),
      );
      // A versão no ar mudou: a Configuração, o Histórico e o selo do topo
      // precisam ler a versão nova.
      if (p.type !== "org_memory_entry") router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Não foi possível aplicar a proposta."));
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  const items = data?.items ?? [];
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-border py-16 text-center">
        <Brain size={28} className="text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">{t("Nenhuma proposta ainda")}</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          {t(
            "O assistente aprende com as conversas reais e propõe melhorias aqui. Você decide o que entra — nada é aplicado sozinho.",
          )}
        </p>
      </div>
    );
  }

  const ehMemoria = confirmando?.type === "org_memory_entry";

  return (
    <div className="flex flex-col gap-3">
      {alteracoesNaoSalvas && !readOnly ? (
        <div
          role="status"
          className="space-y-2 rounded-md border border-warning/40 bg-warning-bg p-3 text-xs"
        >
          <p className="font-medium text-warning-fg">
            {t("Há mudanças não salvas na Configuração.")}
          </p>
          <p className="text-muted-foreground">
            {t("Salve ou descarte antes de aplicar uma proposta como versão nova.")}
          </p>
          {onIrParaConfiguracao ? (
            <Button variant="outline" size="sm" onClick={onIrParaConfiguracao}>
              {t("Ir para a Configuração")}
            </Button>
          ) : null}
        </div>
      ) : null}

      <ul className="divide-y divide-border rounded-lg border border-border">
        {items.map((p) => {
          const when = formatDistanceToNowStrict(new Date(p.proposed_at), {
            addSuffix: true,
            locale: localeDaData,
          });
          const memoria = p.type === "org_memory_entry";
          return (
            <li key={p.id} className="flex items-start gap-3 px-4 py-3" data-testid="proposal-item">
              <Badge variant={p.applied_at ? "success" : "info"} className="mt-0.5 shrink-0">
                {p.applied_at ? t("aplicada") : t("pendente")}
              </Badge>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">
                  {t(TYPE_LABEL[p.type])} · {t("proposta")} {when}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{p.content}</p>
              </div>
              {!p.applied_at && !readOnly ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={apply.isPending || (!memoria && alteracoesNaoSalvas)}
                  onClick={() => setConfirmando(p)}
                >
                  {memoria ? t("Aplicar como memória da org") : t("Aplicar como versão nova")}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      <AlertDialog open={confirmando !== null} onOpenChange={(o) => !o && setConfirmando(null)}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {ehMemoria ? t("Guardar como memória da organização?") : t("Pôr esta melhoria no ar?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {ehMemoria
                ? t("Passa a valer agora para todos os agentes da organização.")
                : t("Ela entra no fim das instruções e vai ao ar agora, nas conversas com os pacientes.")}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {confirmando ? (
            <div className="space-y-2 text-xs">
              <p className="font-medium">
                {ehMemoria ? t("O que fica guardado:") : t("O trecho que entra:")}
              </p>
              <p
                data-testid="proposta-trecho"
                className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-3 whitespace-pre-wrap"
              >
                {confirmando.content}
              </p>
              {!ehMemoria && rascunhoVigente ? (
                <p className="text-muted-foreground">
                  {t("O rascunho v")}
                  {rascunhoVigente.version_number}
                  {t(", ainda não publicado, sai do editor. Ele fica no Histórico e pode ser aberto de novo.")}
                </p>
              ) : null}
            </div>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmando) void handleApply(confirmando);
              }}
            >
              {ehMemoria ? t("Guardar agora") : t("Pôr no ar agora")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
