"use client";
/**
 * Por qual número o lembrete do compromisso sai. "Automático" é a regra de
 * sempre; um número fixo vence enquanto puder enviar (ver
 * `lib/agenda/canal-do-lembrete.ts`). Grava pela rota
 * `/api/v1/settings/agenda/canal-do-lembrete`, que cobra o papel de novo.
 */
import * as React from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

export function CanalDoLembrete({
  canais,
  inicial,
  podeEditar,
}: {
  canais: Array<{ id: string; nome: string }>;
  inicial: string | null;
  podeEditar: boolean;
}) {
  const t = useT();
  const [valor, setValor] = React.useState(inicial ?? "");
  const [salvo, setSalvo] = React.useState(inicial ?? "");
  const [busy, setBusy] = React.useState(false);

  async function salvar(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await apiClient.patch("/api/v1/settings/agenda/canal-do-lembrete", { channel_session_id: valor || null });
      setSalvo(valor);
      toast.success(t("Número dos lembretes salvo."));
    } catch (err) {
      showApiError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-border bg-surface p-4" data-testid="canal-do-lembrete">
      <div>
        <h2 className="text-lg font-semibold">{t("Número que envia os lembretes")}</h2>
        <p className="text-sm text-text-muted">
          {t(
            "No automático, o lembrete sai pelo número da conversa em que o horário foi marcado ou pelo da conversa mais recente do cliente. Um número fixo vale para todos os lembretes; se ele estiver desconectado, o lembrete sai pelo automático.",
          )}
        </p>
      </div>
      <form className="flex flex-wrap gap-2" onSubmit={salvar}>
        <select
          aria-label={t("Número que envia os lembretes")}
          value={valor}
          disabled={!podeEditar || busy}
          onChange={(e) => setValor(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-border bg-surface-elevated p-2 text-sm"
        >
          <option value="">{t("Automático (como hoje)")}</option>
          {salvo && !canais.some((c) => c.id === salvo) ? (
            <option value={salvo}>{t("Número arquivado ou removido")}</option>
          ) : null}
          {canais.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nome}
            </option>
          ))}
        </select>
        {podeEditar ? (
          <Button type="submit" disabled={busy || valor === salvo}>
            {busy ? t("Salvando…") : t("Salvar")}
          </Button>
        ) : null}
      </form>
    </section>
  );
}
