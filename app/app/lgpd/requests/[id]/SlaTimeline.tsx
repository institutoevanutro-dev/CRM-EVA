"use client";

import { useT } from "@/hooks/i18n/useT";
import { computeDueAt, diaDoRecebimento, diasAtePrazo, prazoEmBr, rotuloDoPrazo } from "@/lib/lgpd/sla";
import { FUSO_PADRAO } from "@/lib/tempo/fusos";
import { LGPD_ESTADOS_ABERTOS } from "@/lib/lgpd/types";

interface SlaTimelineProps {
  received_at: string;
  due_at: string;
  request_type: string;
  /** Situação do pedido: fora dos abertos, o relógio para. */
  status: string;
  completed_at: string | null;
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

export function SlaTimeline({
  received_at,
  due_at,
  request_type,
  status,
  completed_at,
  fuso = FUSO_PADRAO,
}: SlaTimelineProps) {
  const t = useT();
  const now = new Date();
  const recebidoNoDia = diaDoRecebimento(new Date(received_at), fuso);
  const aberto = (LGPD_ESTADOS_ABERTOS as readonly string[]).includes(status);
  const concluido = status === "completed";

  // Os marcos são DATAS, não tarefas: uma etapa só aparece feita quando o pedido
  // terminou. Antes, a data passar bastava para marcar "Anonimização concluída".
  // Pedido aberto: o primeiro marco ainda por vir é o atual; o último que passou
  // sem o pedido terminar é atraso.
  const milestoneConfigs = getMilestones(request_type).map((m, idx, todos) => {
    const isLast = idx === todos.length - 1;
    const dia = isLast ? due_at : m.day === 0 ? recebidoNoDia : computeDueAt(recebidoNoDia, m.day);
    return { ...m, isLast, dia, faltam: diasAtePrazo(dia, now, fuso) };
  });
  const indiceAtual = milestoneConfigs.findIndex((m) => m.day > 0 && m.faltam >= 0);
  const milestones = milestoneConfigs.map((m, idx) => {
    const estado: "completed" | "past" | "current" | "late" | "future" =
      m.day === 0 || concluido
        ? "completed"
        : !aberto
          ? "past"
          : m.faltam < 0
            ? m.isLast
              ? "late"
              : "past"
            : idx === indiceAtual
              ? "current"
              : "future";
    return { label: m.label, targetDay: m.day, data: prazoEmBr(m.dia), status: estado };
  });

  // Progresso: razão entre as duas pontas, até o FIM do dia do prazo. Encerrado,
  // o relógio para: concluído enche a barra, o resto para onde estava.
  const fimDoPrazo = new Date(due_at).getTime() + 86_400_000;
  const total = fimDoPrazo - recebidoNoDia.getTime();
  const ate = !aberto && completed_at ? new Date(completed_at).getTime() : now.getTime();
  const progress = concluido
    ? 1
    : Math.min(1, Math.max(0, total > 0 ? (ate - recebidoNoDia.getTime()) / total : 0));
  const progressPct = Math.round(progress * 100);
  const prazo = rotuloDoPrazo(due_at, now, fuso, t);
  const vencido = aberto && prazo.estado === "vencido";

  const progressColor = concluido
    ? "bg-success"
    : vencido
      ? "bg-error"
      : progress >= 0.75
        ? "bg-warning"
        : "bg-success";

  return (
    <div className="space-y-4">
      {/* Progress bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>
            {t("Prazo")}: {prazo.data}
          </span>
          {concluido && completed_at ? (
            <span className="font-medium text-success-fg">
              {t("Concluído em")} {prazoEmBr(diaDoRecebimento(new Date(completed_at), fuso))}
            </span>
          ) : aberto ? (
            <span className={vencido ? "font-medium text-error-fg" : undefined}>{prazo.texto}</span>
          ) : null}
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
                ? "bg-warning border-warning ring-2 ring-warning-bg"
                : m.status === "late"
                  ? "bg-error border-error ring-2 ring-error-bg"
                  : m.status === "past"
                    ? "bg-border border-border"
                    : "bg-muted border-border";

          const labelColor =
            m.status === "completed"
              ? "text-success-fg"
              : m.status === "current"
                ? "text-warning-fg font-medium"
                : m.status === "late"
                  ? "text-error-fg font-medium"
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
                  {t(m.label)}
                  {m.targetDay > 0 && (
                    <span className="text-muted-foreground">
                      {" "}
                      · {m.targetDay} {t("dias úteis")}
                    </span>
                  )}
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
