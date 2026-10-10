"use client";
/**
 * Quanto tempo a IA fica fora da conversa depois que uma pessoa responde.
 * Um número, em minutos; os limites vêm do mesmo módulo que a rota valida.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { PAUSA_MAXIMA_MIN, PAUSA_MINIMA_MIN } from "@/lib/escalacao/pausa-por-resposta-humana";

export function PausaDaIaForm({ initial }: { initial: number }) {
  const t = useT();
  const [minutos, setMinutos] = useState(String(initial));
  const [salvo, setSalvo] = useState(initial);
  const [isPending, startTransition] = useTransition();

  const valor = Number(minutos);
  const valido = Number.isInteger(valor) && valor >= PAUSA_MINIMA_MIN && valor <= PAUSA_MAXIMA_MIN;

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    if (!valido) return;
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/atendimento/pausa-da-ia", { minutos: valor });
        setSalvo(valor);
        toast.success(t("Pausa da IA salva."));
      } catch (err) {
        toast.error(err instanceof Error ? t(err.message) : t("Não consegui salvar."));
      }
    });
  }

  return (
    <form onSubmit={salvar} className="max-w-3xl" data-testid="form-pausa-da-ia">
      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold">{t("Quando uma pessoa responde o cliente")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "A IA sai da conversa por um tempo para não responder junto. Vale para resposta pelo celular e pela tela, e cada nova resposta recomeça a contagem.",
            )}
          </p>
        </div>
        <div className="max-w-sm space-y-1">
          <Label htmlFor="pausa_ia_min">
            {t("Quanto tempo a IA fica fora da conversa depois que uma pessoa responde (minutos)")}
          </Label>
          <Input
            id="pausa_ia_min"
            type="number"
            inputMode="numeric"
            step={1}
            min={PAUSA_MINIMA_MIN}
            max={PAUSA_MAXIMA_MIN}
            value={minutos}
            disabled={isPending}
            aria-invalid={!valido}
            aria-describedby="pausa_ia_min_ajuda"
            onChange={(e) => setMinutos(e.target.value)}
          />
          <p id="pausa_ia_min_ajuda" className={`text-xs ${valido ? "text-muted-foreground" : "text-destructive"}`}>
            {t(
              "De 5 minutos a 24 horas (1440 minutos). Para tirar a IA de vez de uma conversa, use o botão de assumir na conversa.",
            )}
          </p>
        </div>
        <Button type="submit" disabled={isPending || !valido || valor === salvo}>
          {isPending ? t("Salvando…") : t("Salvar pausa")}
        </Button>
      </Card>
    </form>
  );
}
