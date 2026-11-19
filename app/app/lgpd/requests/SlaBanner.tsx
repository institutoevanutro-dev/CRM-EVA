"use client";
import { Warning } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

interface SlaBannerProps {
  /** Contagem dos pedidos abertos da organização inteira (`meta.alertas`). */
  alertas: { criticos: number; em_alerta: number };
}

export function SlaBanner({ alertas }: SlaBannerProps) {
  const t = useT();
  const { criticos, em_alerta } = alertas;

  if (criticos > 0) {
    return (
      <div
        role="alert"
        className="flex items-center gap-3 rounded-lg border border-error-fg/30 bg-error-bg px-4 py-3 text-sm text-error-fg"
      >
        <Warning size={18} weight="fill" className="shrink-0" aria-hidden />
        <span>
          <strong>{criticos}</strong>{" "}
          {t(criticos === 1 ? "pedido urgente" : "pedidos urgentes")} —{" "}
          {t("prazo vencido ou vencendo em até 2 dias.")}
        </span>
      </div>
    );
  }

  if (em_alerta > 0) {
    return (
      <div
        role="alert"
        className="flex items-center gap-3 rounded-lg border border-warning-fg/30 bg-warning-bg px-4 py-3 text-sm text-warning-fg"
      >
        <Warning size={18} weight="fill" className="shrink-0" aria-hidden />
        <span>
          <strong>{em_alerta}</strong>{" "}
          {t(em_alerta === 1 ? "pedido pede atenção" : "pedidos pedem atenção")} —{" "}
          {t("já passou da metade do prazo.")}
        </span>
      </div>
    );
  }

  return null;
}
