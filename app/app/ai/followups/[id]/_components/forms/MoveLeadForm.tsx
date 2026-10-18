"use client";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEtapasDeGatilho } from "@/hooks/followup/useEtapasDeGatilho";
import { useT } from "@/hooks/i18n/useT";
import { moveLeadConfigSchema } from "@/lib/followup/graph-schema";

import type { ConfigOf } from "./shared";

/**
 * O nó `move_lead` — escolher para qual etapa o card vai. A etapa é ESCOLHIDA,
 * nunca digitada: o motor compara ids. Mesma lista de etapas ativas do gatilho
 * (`useEtapasDeGatilho`), agrupada por funil.
 *
 * Portado e adaptado do projeto original (DeskcommCRM, PR #2181 de @webtecnica).
 */
export function MoveLeadForm({
  config,
  onChange,
}: {
  config: ConfigOf<"move_lead">;
  onChange: (c: ConfigOf<"move_lead">) => void;
}) {
  const t = useT();
  const { etapas, carregando } = useEtapasDeGatilho();
  const funis: Array<{ id: string; nome: string; etapas: typeof etapas }> = [];
  for (const etapa of etapas) {
    let grupo = funis.find((f) => f.id === etapa.pipelineId);
    if (!grupo) {
      grupo = { id: etapa.pipelineId, nome: etapa.pipelineName, etapas: [] };
      funis.push(grupo);
    }
    grupo.etapas.push(etapa);
  }
  const conhecida = etapas.some((e) => e.stageId === config.stage_id);

  return (
    <div className="space-y-2">
      <Label htmlFor="move-lead-etapa">{t("Etapa de destino")}</Label>
      <Select
        value={conhecida ? config.stage_id : ""}
        onValueChange={(stageId) => {
          const parsed = moveLeadConfigSchema.safeParse({ stage_id: stageId });
          if (parsed.success) onChange(parsed.data);
        }}
        disabled={carregando || etapas.length === 0}
      >
        <SelectTrigger id="move-lead-etapa" aria-label={t("Etapa de destino")}>
          <SelectValue placeholder={carregando ? t("Carregando etapas…") : t("Escolha a etapa")} />
        </SelectTrigger>
        <SelectContent>
          {funis.map((funil) => (
            <SelectGroup key={funil.id}>
              <SelectLabel>{funil.nome}</SelectLabel>
              {funil.etapas.map((etapa) => (
                <SelectItem key={etapa.stageId} value={etapa.stageId}>
                  {etapa.stageName} · {etapa.pipelineName}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-text-muted">
        {t("O card vai para esta etapa do mesmo funil — trocar de funil é recusado, como no quadro.")}
      </p>
    </div>
  );
}
