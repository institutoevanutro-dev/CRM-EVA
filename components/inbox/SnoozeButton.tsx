"use client";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Clock } from "@/lib/ui/icons";
import { useSnoozeConversation } from "@/hooks/inbox/useSnoozeConversation";

interface Props {
  conversationId: string;
  snoozeUntil: string | null;
  disabled?: boolean;
  /** `item`: linha do menu ⋯ do cabeçalho, com o nome sempre à vista. */
  variante?: "botao" | "item";
}

const DURATIONS: Array<{ hours: 1 | 3 | 24; label: string }> = [
  { hours: 1, label: "Em 1 hora" },
  { hours: 3, label: "Em 3 horas" },
  { hours: 24, label: "Em 24 horas" },
];

/** "15:40" no idioma da sessão. */
export function horaDoLembrete(iso: string | Date, tag: string): string {
  return new Date(iso).toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" });
}

function isSnoozeActive(snoozeUntil: string | null): boolean {
  return snoozeUntil != null && new Date(snoozeUntil).getTime() > Date.now();
}

export function SnoozeButton({ conversationId, snoozeUntil, disabled, variante = "botao" }: Props) {
  const t = useT();
  const { snooze, cancel } = useSnoozeConversation();
  const isActive = isSnoozeActive(snoozeUntil);
  const isPending = snooze.isPending || cancel.isPending;
  const tag = useTagDeIdioma();
  // Item 213: o lembrete diz ATÉ QUANDO, e cada opção diz a hora em que vai tocar.
  const rotulo = isActive && snoozeUntil ? `${t("Lembrete às")} ${horaDoLembrete(snoozeUntil, tag)}` : t("Lembrar");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variante === "item" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || isPending}
            className="w-full justify-start gap-2 px-2"
            title={rotulo}
          >
            <Clock size={16} weight="regular" aria-hidden />
            {rotulo}
          </Button>
        ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || isPending}
          // 44px de largura no toque: só com o ícone (cabeçalho estreito), ficava com 42.
          className="flex min-w-11 items-center gap-1 lg:min-w-0"
          // No cabeçalho estreito o nome sai (consulta de contêiner, I3) e fica
          // aqui: na dica e no nome que o leitor de tela anuncia.
          aria-label={rotulo}
          title={rotulo}
        >
          <Clock size={16} weight="regular" aria-hidden />
          <span className="hidden @[40rem]:inline">{rotulo}</span>
        </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {isActive ? (
          <DropdownMenuItem
            onClick={() => cancel.mutate({ conversation_id: conversationId })}
          >
            {t("Cancelar lembrete")}
          </DropdownMenuItem>
        ) : (
          DURATIONS.map((d) => (
            <DropdownMenuItem
              key={d.hours}
              onClick={() =>
                snooze.mutate(
                  { conversation_id: conversationId, duration_hours: d.hours },
                  {
                    onSuccess: (r) =>
                      toast.success(`${t("Vou lembrar às")} ${horaDoLembrete(r.data.snooze_until, tag)}`),
                  },
                )
              }
            >
              {t(d.label)} · {horaDoLembrete(new Date(Date.now() + d.hours * 3_600_000), tag)}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
