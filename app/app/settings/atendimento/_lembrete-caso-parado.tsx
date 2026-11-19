"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  atualizarLembreteDeCasoParado,
  type LembreteDeCasoParado as Lembrete,
} from "@/app/actions/settings/atualizarLembreteDeCasoParado";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

const INTERVALOS_EM_HORAS = [1, 2, 4, 8, 12, 24, 48, 72];
const TETOS = [1, 2, 3, 4, 5, 10];

/** O valor gravado entra na lista mesmo fora das opções: o select nunca mente sobre o que está salvo. */
function comOGravado(opcoes: number[], gravado: number): number[] {
  return opcoes.includes(gravado) ? opcoes : [...opcoes, gravado].sort((a, b) => a - b);
}

/**
 * O lembrete de caso parado da organização (migration 0397). Mora em
 * Configurações › Distribuição de atendimento, junto da pausa da IA: a Central
 * mostra só os avisos (decisão do André, 18/11). Só quem administra vê o
 * cartão; a página decide isso com o mesmo `podeAdministrarEmpresa` da action.
 *
 * O padrão (ligado, a cada 24 horas, três avisos por espera) é o comportamento
 * de antes desta tela existir.
 */
export function LembreteDeCasoParado({ inicial }: { inicial: Lembrete }) {
  const t = useT();
  const [valor, setValor] = useState<Lembrete>(inicial);
  const [isPending, startTransition] = useTransition();

  function intervaloEmPalavras(horas: number): string {
    if (horas % 24 === 0) {
      const dias = horas / 24;
      return dias === 1 ? t("1 dia") : t("{n} dias").replace("{n}", String(dias));
    }
    return horas === 1 ? t("1 hora") : t("{n} horas").replace("{n}", String(horas));
  }

  function salvar() {
    startTransition(async () => {
      const resultado = await atualizarLembreteDeCasoParado(valor);
      if (resultado.ok) {
        toast.success(t("Lembrete de caso parado salvo."));
        return;
      }
      if (resultado.error === "mfa_required") {
        toast.error(t("Confirme o segundo fator nesta sessão e tente de novo."));
        return;
      }
      toast.error(t("Não foi possível salvar o lembrete de caso parado."));
    });
  }

  return (
    <Card className="space-y-3 p-4" data-testid="lembrete-de-caso-parado">
      <h2 className="text-sm font-medium">{t("Lembrete de caso parado")}</h2>
      <p className="text-xs text-muted-foreground">
        {t(
          "Quando um caso espera uma decisão da equipe, a Central de avisos volta a avisar. O relógio começa quando o caso chega à equipe e recomeça quando o cliente responde.",
        )}
      </p>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={valor.ligado} onCheckedChange={(ligado) => setValor({ ...valor, ligado })} />
        <span>{t("Lembrar a equipe dos casos parados")}</span>
      </label>
      {/* Select do sistema, e não `<select>` nativo: o Safari desenha o nativo
          de outro jeito (item 240). */}
      <div className="flex flex-wrap gap-3">
        <div className="space-y-1 text-sm max-md:w-full">
          <span id="lembrete-intervalo">{t("Lembrar a cada")}</span>
          <Select
            value={String(valor.intervaloHoras)}
            disabled={!valor.ligado}
            onValueChange={(v) => setValor({ ...valor, intervaloHoras: Number(v) })}
          >
            <SelectTrigger aria-labelledby="lembrete-intervalo" className="w-40 max-md:w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {comOGravado(INTERVALOS_EM_HORAS, valor.intervaloHoras).map((h) => (
                <SelectItem key={h} value={String(h)}>
                  {intervaloEmPalavras(h)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 text-sm max-md:w-full">
          <span id="lembrete-teto">{t("Avisos por espera")}</span>
          <Select
            value={String(valor.teto)}
            disabled={!valor.ligado}
            onValueChange={(v) => setValor({ ...valor, teto: Number(v) })}
          >
            <SelectTrigger aria-labelledby="lembrete-teto" className="w-40 max-md:w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {comOGravado(TETOS, valor.teto).map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <Button type="button" size="sm" disabled={isPending} onClick={salvar}>
        {t("Salvar lembrete")}
      </Button>
    </Card>
  );
}
