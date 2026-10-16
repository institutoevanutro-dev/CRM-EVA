"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { waitConfigSchema, type AppointmentAnchor } from "@/lib/followup/graph-schema";
import { ANCORAS_DA_ESPERA, MODOS_DE_ESPERA, opcoes } from "@/lib/followup/vocabulario";
import { useT } from "@/hooks/i18n/useT";

import { msToMin, minToMs, type ConfigOf } from "./shared";

/** "none" = conta da chegada a esta espera (o padrão). */
type Ancora = AppointmentAnchor | "none";
const ANCORAS: ReadonlyArray<{ valor: Ancora; rotulo: string }> = [
  { valor: "none", rotulo: "Do passo anterior" },
  ...opcoes(ANCORAS_DA_ESPERA),
];

export function WaitForm({
  config,
  onChange,
}: {
  config: ConfigOf<"wait">;
  onChange: (c: ConfigOf<"wait">) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<"fixed" | "smart">(config.mode);
  const [durationMin, setDurationMin] = useState(
    config.mode === "fixed" ? msToMin(config.duration_ms) : 10,
  );
  const [minMin, setMinMin] = useState(config.mode === "smart" ? msToMin(config.min_ms) : 5);
  const [maxMin, setMaxMin] = useState(config.mode === "smart" ? msToMin(config.max_ms) : 60);
  const [guidance, setGuidance] = useState(config.mode === "smart" ? (config.guidance ?? "") : "");
  const [anchor, setAnchor] = useState<Ancora>(config.mode === "fixed" ? (config.anchor ?? "none") : "none");
  const [error, setError] = useState<string | null>(null);

  const commit = (next: {
    mode: "fixed" | "smart";
    durationMin: number;
    minMin: number;
    maxMin: number;
    guidance: string;
    anchor: Ancora;
  }) => {
    const candidate =
      next.mode === "fixed"
        ? { mode: "fixed" as const, duration_ms: minToMs(next.durationMin), ...(next.anchor !== "none" ? { anchor: next.anchor } : {}) }
        : {
            mode: "smart" as const,
            min_ms: minToMs(next.minMin),
            max_ms: minToMs(next.maxMin),
            ...(next.guidance.trim() ? { guidance: next.guidance } : {}),
          };
    const parsed = waitConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="wait-mode">{t("Como calcular a espera")}</Label>
        <Select
          value={mode}
          onValueChange={(v) => {
            const next = v as "fixed" | "smart";
            setMode(next);
            commit({ mode: next, durationMin, minMin, maxMin, guidance, anchor });
          }}
        >
          <SelectTrigger id="wait-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {opcoes(MODOS_DE_ESPERA).map(({ valor, rotulo }) => (
              <SelectItem key={valor} value={valor}>
                {t(rotulo)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {mode === "fixed" ? (
        <div className="space-y-2">
          <Label htmlFor="wait-duration">{t("Duração (minutos)")}</Label>
          <Input
            id="wait-duration"
            type="number"
            min={5}
            value={durationMin}
            onChange={(e) => {
              const v = Number(e.target.value);
              setDurationMin(v);
              commit({ mode, durationMin: v, minMin, maxMin, guidance, anchor });
            }}
          />
          <div className="space-y-2 pt-2">
            <Label htmlFor="wait-anchor-appointment">{t("Contar a partir de")}</Label>
            <Select
              value={anchor}
              onValueChange={(v) => {
                const next = v as Ancora;
                setAnchor(next);
                commit({ mode, durationMin, minMin, maxMin, guidance, anchor: next });
              }}
            >
              <SelectTrigger id="wait-anchor-appointment">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ANCORAS.map(({ valor, rotulo }) => (
                  <SelectItem key={valor} value={valor}>
                    {t(rotulo)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {anchor !== "none" && (
              <p className="text-xs text-muted-foreground">
                {t("Toda espera com esta opção conta da mesma data: numa régua de 7, 15, 30 e 45 dias, escreva 7, 15, 30 e 45 — não a diferença para a espera anterior.")}
              </p>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="wait-min">{t("Mínimo (min)")}</Label>
              <Input
                id="wait-min"
                type="number"
                min={5}
                value={minMin}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMinMin(v);
                  commit({ mode, durationMin, minMin: v, maxMin, guidance, anchor });
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wait-max">{t("Máximo (min)")}</Label>
              <Input
                id="wait-max"
                type="number"
                min={5}
                value={maxMin}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMaxMin(v);
                  commit({ mode, durationMin, minMin, maxMin: v, guidance, anchor });
                }}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="wait-guidance">{t("Orientação (opcional)")}</Label>
            <Textarea
              id="wait-guidance"
              maxLength={500}
              value={guidance}
              onChange={(e) => {
                setGuidance(e.target.value);
                commit({ mode, durationMin, minMin, maxMin, guidance: e.target.value, anchor });
              }}
            />
          </div>
        </>
      )}
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}
