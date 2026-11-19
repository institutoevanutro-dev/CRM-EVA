"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

export interface UnidadeRow { id: string; name: string; timezone: string; active: boolean }
export interface SalaRow { id: string; unit_id: string; name: string; kind: "consultation" | "application"; active: boolean }

const CAMPO = "rounded-md border border-border bg-surface-elevated p-2 text-sm text-text placeholder:text-text-muted";

export function RecursosDaAgenda({ unidades, salas, podeEditar }: { unidades: UnidadeRow[]; salas: SalaRow[]; podeEditar: boolean }) {
  const t = useT();
  const router = useRouter();
  const [unitId, setUnitId] = React.useState(unidades.find((u) => u.active)?.id ?? "");
  const [busy, setBusy] = React.useState(false);

  // `router.refresh()` e não recarregar a página inteira (item 129): o servidor
  // devolve a lista nova sem perder o resto da tela.
  async function executar(fn: () => Promise<unknown>, mensagem: string): Promise<boolean> {
    setBusy(true);
    try { await fn(); toast.success(mensagem); router.refresh(); return true; }
    catch (e) { showApiError(e); return false; }
    finally { setBusy(false); }
  }

  // Renomear e desativar pelas rotas PATCH que já existiam e não tinham tela.
  function renomear(rota: string, id: string, atual: string) {
    const nome = window.prompt(t("Novo nome"), atual)?.trim();
    if (!nome || nome === atual) return;
    void executar(() => apiClient.patch(rota, { id, name: nome }), t("Nome alterado."));
  }
  function alternar(rota: string, id: string, ativo: boolean) {
    void executar(() => apiClient.patch(rota, { id, active: !ativo }), ativo ? t("Desativada.") : t("Reativada."));
  }

  const acoes = (rota: string, id: string, nome: string, ativo: boolean) =>
    podeEditar ? (
      <span className="ml-auto flex gap-1">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => renomear(rota, id, nome)}>{t("Renomear")}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => alternar(rota, id, ativo)}>{ativo ? t("Desativar") : t("Reativar")}</Button>
      </span>
    ) : null;

  return (
    <section className="space-y-4 rounded-lg border border-border bg-surface p-4">
      <div><h2 className="text-lg font-semibold">{t("Unidades e salas")}</h2><p className="text-sm text-text-muted">{t("A agenda escolhe automaticamente uma sala ativa e compatível.")}</p></div>
      <div className="grid gap-3 md:grid-cols-2">
        {unidades.map((u) => (
          <article key={u.id} className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-2 font-medium">{u.name}{u.active ? "" : ` · ${t("desativada")}`}{acoes("/api/v1/agenda/unidades", u.id, u.name, u.active)}</div>
            <ul className="mt-2 space-y-1 text-sm text-text-muted">
              {salas.filter((s) => s.unit_id === u.id).map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-2">
                  {s.name} · {s.kind === "application" ? t("Aplicação") : t("Atendimento")}{s.active ? "" : ` · ${t("desativada")}`}
                  {acoes("/api/v1/agenda/salas", s.id, s.name, s.active)}
                </li>
              ))}
              {!salas.some((s) => s.unit_id === u.id) ? <li>{t("Nenhuma sala cadastrada.")}</li> : null}
            </ul>
          </article>
        ))}
      </div>
      {podeEditar ? <div className="grid gap-4 border-t border-border pt-4 md:grid-cols-2">
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const f = new FormData(form); void executar(() => apiClient.post("/api/v1/agenda/unidades", { name: String(f.get("name")) }), t("Unidade criada.")).then((ok) => { if (ok) form.reset(); }); }}>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-text-muted">
            {t("Nova unidade")}
            <input name="name" required minLength={2} placeholder={t("Nome da unidade")} className={CAMPO} />
          </label>
          <Button disabled={busy} type="submit">{t("Adicionar")}</Button>
        </form>
        <form className="grid grid-cols-2 items-end gap-2" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const f = new FormData(form); void executar(() => apiClient.post("/api/v1/agenda/salas", { unit_id: unitId, name: String(f.get("name")), kind: String(f.get("kind")) }), t("Sala criada.")).then((ok) => { const campo = form.elements.namedItem("name"); if (ok && campo instanceof HTMLInputElement) campo.value = ""; }); }}>
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            {t("Unidade")}
            <select value={unitId} onChange={(e) => setUnitId(e.target.value)} required className={CAMPO}>
              <option value="">{t("Escolha a unidade")}</option>{unidades.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            {t("Tipo de sala")}
            <select name="kind" className={CAMPO}><option value="consultation">{t("Atendimento")}</option><option value="application">{t("Aplicação")}</option></select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            {t("Nova sala")}
            <input name="name" required minLength={2} placeholder={t("Nome da sala")} className={CAMPO} />
          </label>
          <Button disabled={busy || !unitId} type="submit">{t("Adicionar sala")}</Button>
        </form>
      </div> : null}
    </section>
  );
}
