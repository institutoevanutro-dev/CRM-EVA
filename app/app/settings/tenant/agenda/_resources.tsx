"use client";

import * as React from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

export interface UnidadeRow { id: string; name: string; timezone: string; active: boolean }
export interface SalaRow { id: string; unit_id: string; name: string; kind: "consultation" | "application"; active: boolean }

export function RecursosDaAgenda({ unidades, salas, podeEditar }: { unidades: UnidadeRow[]; salas: SalaRow[]; podeEditar: boolean }) {
  const t = useT();
  const [unitId, setUnitId] = React.useState(unidades.find((u) => u.active)?.id ?? "");
  const [busy, setBusy] = React.useState(false);
  const recarregar = () => window.location.reload();

  async function executar(fn: () => Promise<unknown>, mensagem: string) {
    setBusy(true);
    try { await fn(); toast.success(mensagem); recarregar(); }
    catch (e) { showApiError(e); setBusy(false); }
  }

  return (
    <section className="space-y-4 rounded-lg border border-border bg-surface p-4">
      <div><h2 className="text-lg font-semibold">{t("Unidades e salas")}</h2><p className="text-sm text-text-muted">{t("A agenda escolhe automaticamente uma sala ativa e compatível.")}</p></div>
      <div className="grid gap-3 md:grid-cols-2">
        {unidades.map((u) => (
          <article key={u.id} className="rounded-md border border-border p-3">
            <div className="font-medium">{u.name}{u.active ? "" : ` · ${t("desativada")}`}</div>
            <ul className="mt-2 space-y-1 text-sm text-text-muted">
              {salas.filter((s) => s.unit_id === u.id).map((s) => <li key={s.id}>{s.name} · {s.kind === "application" ? t("Aplicação") : t("Atendimento")}</li>)}
              {!salas.some((s) => s.unit_id === u.id) ? <li>{t("Nenhuma sala cadastrada.")}</li> : null}
            </ul>
          </article>
        ))}
      </div>
      {podeEditar ? <div className="grid gap-4 border-t border-border pt-4 md:grid-cols-2">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void executar(() => apiClient.post("/api/v1/agenda/unidades", { name: String(f.get("name")) }), t("Unidade criada.")); }}>
          <input name="name" required minLength={2} placeholder={t("Nome da unidade")} className="min-w-0 flex-1 rounded-md border border-border bg-surface-elevated p-2 text-sm" />
          <Button disabled={busy} type="submit">{t("Adicionar")}</Button>
        </form>
        <form className="grid grid-cols-2 gap-2" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void executar(() => apiClient.post("/api/v1/agenda/salas", { unit_id: unitId, name: String(f.get("name")), kind: String(f.get("kind")) }), t("Sala criada.")); }}>
          <select value={unitId} onChange={(e) => setUnitId(e.target.value)} required className="rounded-md border border-border bg-surface-elevated p-2 text-sm">
            <option value="">{t("Escolha a unidade")}</option>{unidades.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <select name="kind" className="rounded-md border border-border bg-surface-elevated p-2 text-sm"><option value="consultation">{t("Atendimento")}</option><option value="application">{t("Aplicação")}</option></select>
          <input name="name" required minLength={2} placeholder={t("Nome da sala")} className="rounded-md border border-border bg-surface-elevated p-2 text-sm" />
          <Button disabled={busy || !unitId} type="submit">{t("Adicionar sala")}</Button>
        </form>
      </div> : null}
    </section>
  );
}
