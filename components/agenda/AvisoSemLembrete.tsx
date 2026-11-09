"use client";

import { useT } from "@/hooks/i18n/useT";
import { Warning } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * "{paciente} pediu para não receber mensagens. O lembrete não será enviado —
 * combine por telefone."
 *
 * A promessa é verdadeira por construção: o cron `agenda-reminder` pula o
 * contato com `is_blocked` (`contato_bloqueado`). Se aquela guarda sair, esta
 * frase passa a mentir — e a recepção deixa de ligar.
 *
 * Aviso, não bloqueio: o Confirmar continua ativo. E ele diz o que FAZER no
 * lugar, porque uma tela que só informa a restrição deixa a pessoa parada
 * decidindo sozinha. Mora aqui para o painel de remarcação e a marcação simples
 * (A10) dizerem a mesma coisa.
 */
export function AvisoSemLembrete({ nome, className }: { nome: string; className?: string }) {
  const t = useT();
  return (
    <div
      data-testid="aviso-sem-lembrete"
      role="status"
      className={cn("flex gap-2 rounded-sm border border-warning/40 bg-warning-bg p-2.5", className)}
    >
      <Warning size={16} weight="fill" className="mt-0.5 shrink-0 text-warning" aria-hidden />
      <p className="text-xs leading-4 text-text">
        <span className="font-semibold">
          {nome} {t("pediu para não receber mensagens.")}
        </span>{" "}
        {t("O lembrete não será enviado — combine por telefone.")}
      </p>
    </div>
  );
}
