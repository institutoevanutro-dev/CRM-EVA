"use client";
/**
 * O horário em que os fluxos de follow-up podem mandar mensagem.
 *
 * Fora dele a mensagem não se perde: espera e sai na próxima abertura
 * (`proximaAbertura` em `lib/followup/bloqueios-obrigatorios.ts`). Sem ele, um
 * lead que parou de responder às 20h recebe a primeira cobrança às 23h.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { apiClient } from "@/lib/api/client";
import type { JanelaDaTela } from "@/lib/followup/bloqueios-obrigatorios";
import { useT } from "@/hooks/i18n/useT";

const WEEKDAYS = [
  { id: 0, label: "Dom" },
  { id: 1, label: "Seg" },
  { id: 2, label: "Ter" },
  { id: 3, label: "Qua" },
  { id: 4, label: "Qui" },
  { id: 5, label: "Sex" },
  { id: 6, label: "Sáb" },
];

interface Estado {
  ligado: boolean;
  dias: number[];
  inicio: string;
  fim: string;
}

// ponytail: um intervalo por dia; o schema aceita vários (ex.: almoço fora) — a tela ganha isso quando alguém pedir.
function doSalvo(janela: JanelaDaTela): Estado {
  if (!janela) return { ligado: false, dias: [0, 1, 2, 3, 4, 5, 6], inicio: "08:00", fim: "21:00" };
  return { ligado: true, dias: janela.dias, inicio: janela.intervalos[0]!.inicio, fim: janela.intervalos[0]!.fim };
}

function paraSalvar(e: Estado): JanelaDaTela {
  return e.ligado ? { dias: [...e.dias].sort((a, b) => a - b), intervalos: [{ inicio: e.inicio, fim: e.fim }] } : null;
}

export function HorarioDeEnvio({
  initial,
  timezone,
  canWrite,
}: {
  initial: JanelaDaTela;
  timezone: string;
  canWrite: boolean;
}) {
  const t = useT();
  const [form, setForm] = useState<Estado>(() => doSalvo(initial));
  const [salvo, setSalvo] = useState<JanelaDaTela>(() => paraSalvar(doSalvo(initial)));
  const [isPending, startTransition] = useTransition();

  const sujo = JSON.stringify(paraSalvar(form)) !== JSON.stringify(salvo);
  const erro = !form.ligado
    ? null
    : form.dias.length === 0
      ? t("Escolha pelo menos um dia.")
      : form.fim <= form.inicio
        ? t("O fim precisa ser depois do início.")
        : null;
  const travado = !canWrite || isPending;

  function salvar() {
    const janela = paraSalvar(form);
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/followups/horario", { janela });
        setSalvo(janela);
        toast.success(t("Horário de envio salvo."));
      } catch (err) {
        toast.error(err instanceof Error ? t(err.message) : t("Não consegui salvar."));
      }
    });
  }

  return (
    <Card className="space-y-4 p-4" data-testid="horario-de-envio">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">{t("Horário de envio")}</h2>
          <p className="text-xs text-muted-foreground">
            {form.ligado
              ? t("Fora deste horário a mensagem espera e sai na próxima abertura.")
              : t("Sem limite: as mensagens dos fluxos saem a qualquer hora, inclusive de madrugada.")}
          </p>
        </div>
        <Switch
          aria-label={t("Limitar horário de envio")}
          checked={form.ligado}
          onCheckedChange={(ligado) => setForm((f) => ({ ...f, ligado }))}
          disabled={travado}
        />
      </div>

      {form.ligado ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="horario_inicio">{t("Início")}</Label>
              <Input
                id="horario_inicio"
                type="time"
                value={form.inicio}
                onChange={(e) => setForm((f) => ({ ...f, inicio: e.target.value }))}
                disabled={travado}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="horario_fim">{t("Fim")}</Label>
              <Input
                id="horario_fim"
                type="time"
                value={form.fim}
                onChange={(e) => setForm((f) => ({ ...f, fim: e.target.value }))}
                disabled={travado}
              />
            </div>
            <p className="pb-2 text-xs text-muted-foreground">
              {t("Fuso horário")}: {timezone}
            </p>
          </div>
          <div>
            <Label className="mb-1 block">{t("Dias")}</Label>
            <div className="flex flex-wrap gap-1">
              {WEEKDAYS.map((d) => {
                const active = form.dias.includes(d.id);
                return (
                  <button
                    key={d.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      setForm((f) => ({
                        ...f,
                        dias: active ? f.dias.filter((x) => x !== d.id) : [...f.dias, d.id],
                      }))
                    }
                    disabled={travado}
                    className={`rounded-md border px-2 py-1 text-xs ${
                      active
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border/60 text-muted-foreground"
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    {t(d.label)}
                  </button>
                );
              })}
            </div>
          </div>
          {erro ? <p className="text-xs text-destructive">{erro}</p> : null}
        </div>
      ) : null}

      {canWrite && sujo ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={salvar} disabled={isPending || erro !== null}>
            {isPending ? t("Salvando…") : t("Salvar")}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
