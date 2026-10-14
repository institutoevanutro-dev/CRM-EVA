"use client";

import { useT } from "@/hooks/i18n/useT";
import { computeDueAt, diaDoRecebimento, diasAtePrazo, prazoEmBr, rotuloDoPrazo } from "@/lib/lgpd/sla";
import { FUSO_PADRAO } from "@/lib/tempo/fusos";

interface SlaTimelineProps {
  received_at: string;
  due_at: string;
  request_type: string;
  /** Fuso da organização; o painel da plataforma usa o padrão. */
  fuso?: string;
}

/**
 * Os marcos em DIAS ÚTEIS, na mesma régua do prazo (`computeDueAt`). Eram dias
 * corridos somados em milissegundos, e o "D+7" da tela caía antes do prazo
 * gravado: duas réguas na mesma tela. O último marco é o próprio `due_at`.
 */
function getMilestones(requestType: string): { label: string; day: number }[] {
  if (requestType === "data_request") {
    return [
      { label: "Recebido", day: 0 },
      { label: "Revisão intermediária", day: 5 },
      { label: "Entrega ao titular", day: 7 },
    ];
  }
  // redact / store_redact
  return [
    { label: "Recebido", day: 0 },
    { label: "Processamento", day: 10 },
    { label: "Anonimização concluída", day: 15 },
  ];
}

export function SlaTimeline({ received_at, due_at, request_type, fuso = FUSO_PADRAO }: SlaTimelineProps) {
  const t = useT();
  const now = new Date();
  const recebidoNoDia = diaDoRecebimento(new Date(received_at), fuso);

  const milestoneConfigs = getMilestones(request_type);
  const milestones = milestoneConfigs.map((m, idx) => {
    const isLast = idx === milestoneConfigs.length - 1;
    const dia = isLast ? due_at : m.day === 0 ? recebidoNoDia : computeDueAt(recebidoNoDia, m.day);
    const faltam = diasAtePrazo(dia, now, fuso);
    const status: "completed" | "current" | "future" =
      m.day === 0 ? "completed" : faltam < 0 ? (isLast ? "current" : "completed") : "future";
    return { label: m.label, targetDay: m.day, data: prazoEmBr(dia), status };
  });

  // Progresso: razão entre as duas pontas, até o FIM do dia do prazo.
  const fimDoPrazo = new Date(due_at).getTime() + 86_400_000;
  const total = fimDoPrazo - recebidoNoDia.getTime();
  const progress = Math.min(1, Math.max(0, total > 0 ? (now.getTime() - recebidoNoDia.getTime()) / total : 0));
  const progressPct = Math.round(progress * 100);
  const prazo = rotuloDoPrazo(due_at, now, fuso, t);

  const progressColor =
    prazo.estado === "vencido" ? "bg-error" : progress >= 0.75 ? "bg-warning" : "bg-success";

  return (
    <div className="space-y-4">
      {/* Progress bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>
            {t("Prazo")}: {prazo.data}
          </span>
          <span className={prazo.estado === "vencido" ? "font-medium text-error" : undefined}>{prazo.texto}</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all ${progressColor}`}
            style={{ width: `${progressPct}%` }}
            role="progressbar"
            aria-valuenow={progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      </div>

      {/* Milestones */}
      <ol className="relative space-y-0">
        {milestones.map((m, idx) => {
          const dotColor =
            m.status === "completed"
              ? "bg-success border-success"
              : m.status === "current"
                ? "bg-yellow-500 border-yellow-500 ring-2 ring-yellow-200 dark:ring-yellow-900"
                : "bg-muted border-border";

          const labelColor =
            m.status === "completed"
              ? "text-emerald-700 dark:text-emerald-400"
              : m.status === "current"
                ? "text-yellow-700 dark:text-yellow-400 font-medium"
                : "text-muted-foreground";

          const isLast = idx === milestones.length - 1;

          return (
            <li key={m.targetDay} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div
                  className={`mt-0.5 h-3 w-3 rounded-full border-2 ${dotColor}`}
                  aria-hidden
                />
                {!isLast && (
                  <div className="mt-1 h-8 w-px bg-border" aria-hidden />
                )}
              </div>
              <div className={`pb-1 text-sm ${isLast ? "" : "pb-3"}`}>
                <p className={`leading-tight ${labelColor}`}>
                  D+{m.targetDay} — {t(m.label)}
                </p>
                <p className="text-xs text-muted-foreground">{m.data}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
