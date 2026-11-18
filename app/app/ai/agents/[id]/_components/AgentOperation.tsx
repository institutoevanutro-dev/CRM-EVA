"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
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
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { AgentRow } from "@/hooks/ai/useAgent";

/**
 * Pausar e trocar Automático ↔ Assistido mudam o que os pacientes recebem — e
 * valiam com um clique. Agora perguntam antes, dizendo a consequência. Retomar
 * o automático segue direto: é voltar ao estado normal do agente.
 */
type Pedido = { titulo: string; consequencia: string; acao: string; corpo: Record<string, unknown> };

export function AgentOperation({ agent, readOnly }: { agent: AgentRow; readOnly?: boolean }) {
  const t = useT(),
    router = useRouter(),
    [busy, setBusy] = useState(false),
    [pedido, setPedido] = useState<Pedido | null>(null);
  async function change(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await apiClient.patch(`/api/v1/ai/agents/${agent.id}`, body);
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setBusy(false);
    }
  }
  function pedirModo(modo: string) {
    setPedido(
      modo === "assisted"
        ? {
            titulo: t("Passar para Assistido?"),
            consequencia: t(
              "A IA deixa de enviar sozinha: cada resposta espera alguém da equipe aprovar.",
            ),
            acao: t("Passar para Assistido"),
            corpo: { operation_mode: "assisted" },
          }
        : {
            titulo: t("Passar para Automático?"),
            consequencia: t(
              "A IA passa a responder os pacientes sozinha, com as regras do agente, sem revisão antes do envio.",
            ),
            acao: t("Passar para Automático"),
            corpo: { operation_mode: "automatic" },
          },
    );
  }
  return (
    <section
      className="flex flex-wrap items-center gap-3 rounded-md border p-3"
      aria-label={t("Operação do agente")}
    >
      <label className="text-sm">
        {t("Operação do agente")}{" "}
        <select
          className="ml-2 rounded-md border bg-background p-2"
          aria-label={t("Modo de operação")}
          value={agent.operation_mode ?? "automatic"}
          disabled={readOnly || busy}
          onChange={(e) => pedirModo(e.target.value)}
        >
          <option value="assisted">{t("Assistido: revisar antes de enviar")}</option>
          <option value="automatic">{t("Automático: responder com as regras do agente")}</option>
        </select>
      </label>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={readOnly || busy || !agent.published_version_id}
        onClick={() =>
          agent.paused_at
            ? void change({ paused_at: null })
            : setPedido({
                titulo: t("Pausar o automático?"),
                consequencia: t(
                  "A IA para de responder sozinha aos pacientes até alguém retomar. As mensagens novas ficam esperando a equipe.",
                ),
                acao: t("Pausar"),
                corpo: { paused_at: new Date().toISOString() },
              })
        }
      >
        {t(agent.paused_at ? "Retomar automático" : "Pausar automático")}
      </Button>
      <p className="w-full text-xs text-muted-foreground">
        {t(
          agent.paused_at
            ? "Automático pausado. A versão publicada foi preservada e a assistência continua disponível."
            : "O modo assistido prepara sugestões na conversa. Só a aprovação humana autoriza o envio.",
        )}
      </p>

      <AlertDialog open={pedido !== null} onOpenChange={(o) => !o && setPedido(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pedido?.titulo}</AlertDialogTitle>
            <AlertDialogDescription>{pedido?.consequencia}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pedido) void change(pedido.corpo);
              }}
            >
              {pedido?.acao}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
