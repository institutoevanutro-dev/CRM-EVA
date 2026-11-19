"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import { format } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { ClockCountdown } from "@/lib/ui/icons";
import type { AuditTrailEntry } from "@/hooks/useLgpdRequest";

/** O que aconteceu, em português. Ação sem rótulo aparece com o código. */
const ACOES: Record<string, string> = {
  "lgpd.data_request_received": "Pedido de cópia dos dados recebido",
  "lgpd.redact_received": "Pedido para apagar dados recebido",
  "lgpd.store_redact_received": "Pedido para apagar dados da loja recebido",
  "lgpd.manually_approved": "Pedido aprovado",
  "lgpd.request_previewed": "Prévia dos dados aberta",
  "lgpd.export_generated": "Relatório gerado",
  "lgpd.export_delivered": "Relatório entregue",
  "lgpd.export_failed": "Falha ao gerar o relatório",
  "lgpd.redact_executed": "Dados apagados",
  "lgpd.redact_completed": "Apagamento concluído",
  "lgpd.redact_failed": "Falha ao apagar os dados",
  "lgpd.redact_skipped_already_anonymized": "Contato já estava anonimizado",
  "lgpd.redact_no_local_footprint": "Nenhum dado desta pessoa no CRM",
  "lgpd.tenant_redacted": "Dados da loja apagados",
  "lgpd.sla_alarm_triggered": "Aviso de prazo enviado",
};

interface AuditTrailProps {
  entries: AuditTrailEntry[];
}

export function AuditTrail({ entries }: AuditTrailProps) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("Nenhuma entrada de auditoria registrada para esta solicitação.")}
      </p>
    );
  }

  return (
    <ol className="relative space-y-0">
      {entries.map((entry, idx) => {
        const isLast = idx === entries.length - 1;
        return (
          <li key={entry.id} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div className="mt-1 h-2 w-2 rounded-full bg-border ring-2 ring-background" aria-hidden />
              {!isLast && <div className="mt-1 h-full min-h-[24px] w-px bg-border" aria-hidden />}
            </div>
            <div className={`pb-3 min-w-0 flex-1 ${isLast ? "pb-0" : ""}`}>
              <p className="text-sm font-medium truncate" title={entry.action}>
                {t(ACOES[entry.action] ?? entry.action)}
              </p>
              <p className="text-xs text-muted-foreground">
                {format(new Date(entry.created_at), "dd/MM/yyyy HH:mm:ss", { locale: localeDaData })}
                <span className="ml-2 opacity-60">
                  {t("por")} {entry.actor_name ?? t(entry.actor_user_id ? "pessoa da equipe" : "sistema")}
                </span>
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function AuditTrailSkeleton() {
  const t = useT();
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <ClockCountdown size={16} aria-hidden />
      {t("Carregando auditoria…")}
    </div>
  );
}
