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
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import {
  CLIENTE_SEM_RESPOSTA_MAX_HORAS_MAXIMO,
  CLIENTE_SEM_RESPOSTA_MAX_HORAS_MINIMO,
  CLIENTE_SEM_RESPOSTA_MAXIMO_MIN,
  CLIENTE_SEM_RESPOSTA_MINIMO_MIN,
  PAUSA_MAXIMA_MIN,
  PAUSA_MINIMA_MIN,
} from "@/lib/escalacao/pausa-por-resposta-humana";

export function PausaDaIaForm({
  initial,
  initialEspera,
  initialMaxHoras,
  initialFimDoDiaSeguinte,
}: {
  initial: number;
  initialEspera: number | null;
  initialMaxHoras: number;
  initialFimDoDiaSeguinte: boolean;
}) {
  const t = useT();
  const [minutos, setMinutos] = useState(String(initial));
  const [salvo, setSalvo] = useState(initial);
  const [espera, setEspera] = useState(initialEspera === null ? "" : String(initialEspera));
  const [esperaSalva, setEsperaSalva] = useState(initialEspera);
  const [maxHoras, setMaxHoras] = useState(String(initialMaxHoras));
  const [maxHorasSalvo, setMaxHorasSalvo] = useState(initialMaxHoras);
  const [fim, setFim] = useState(initialFimDoDiaSeguinte);
  const [fimSalvo, setFimSalvo] = useState(initialFimDoDiaSeguinte);
  const [isPending, startTransition] = useTransition();

  const valor = Number(minutos);
  const valido = Number.isInteger(valor) && valor >= PAUSA_MINIMA_MIN && valor <= PAUSA_MAXIMA_MIN;
  // Vazio = desligado.
  const valorEspera = espera.trim() === "" ? null : Number(espera);
  const esperaValida =
    valorEspera === null ||
    (Number.isInteger(valorEspera) &&
      valorEspera >= CLIENTE_SEM_RESPOSTA_MINIMO_MIN &&
      valorEspera <= CLIENTE_SEM_RESPOSTA_MAXIMO_MIN);

  const valorMaxHoras = Number(maxHoras);
  const maxHorasValido =
    Number.isInteger(valorMaxHoras) &&
    valorMaxHoras >= CLIENTE_SEM_RESPOSTA_MAX_HORAS_MINIMO &&
    valorMaxHoras <= CLIENTE_SEM_RESPOSTA_MAX_HORAS_MAXIMO;

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    if (!valido || !esperaValida || !maxHorasValido) return;
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/atendimento/pausa-da-ia", {
          minutos: valor,
          cliente_sem_resposta_min: valorEspera,
          cliente_sem_resposta_max_horas: valorMaxHoras,
          fim_do_dia_seguinte: fim,
        });
        setSalvo(valor);
        setEsperaSalva(valorEspera);
        setMaxHorasSalvo(valorMaxHoras);
        setFimSalvo(fim);
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
        <div className="flex max-w-xl items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="ia_volta_fim_do_dia_seguinte">
              {t("Depois que a equipe responde, a IA só volta no fim do dia seguinte")}
            </Label>
            <p id="ia_volta_fim_do_dia_seguinte_ajuda" className="text-xs text-muted-foreground">
              {t(
                "Ligado: a IA fica fora da conversa até a meia-noite do dia seguinte à última resposta da equipe, ou até alguém clicar em Devolver ao automático. Se o cliente escrever e ninguém responder, abre um aviso na Central em vez de a IA voltar. Se o WhatsApp do celular manda saudação automática, ela conta como resposta da equipe.",
              )}
            </p>
          </div>
          <Switch
            id="ia_volta_fim_do_dia_seguinte"
            checked={fim}
            disabled={isPending}
            aria-describedby="ia_volta_fim_do_dia_seguinte_ajuda"
            onCheckedChange={setFim}
          />
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
            disabled={isPending || fim}
            aria-invalid={!valido}
            aria-describedby="pausa_ia_min_ajuda"
            onChange={(e) => setMinutos(e.target.value)}
          />
          <p id="pausa_ia_min_ajuda" className={`text-xs ${valido ? "text-muted-foreground" : "text-destructive"}`}>
            {t(
              "De 5 minutos a 24 horas (1440 minutos). Se a equipe responde o dia todo pelo celular, um tempo alto deixa a IA sempre fora dessas conversas. Para tirar a IA de vez de uma conversa, use o botão de assumir na conversa.",
            )}
          </p>
        </div>
        <div className="max-w-sm space-y-1">
          <Label htmlFor="pausa_cliente_sem_resposta_min">
            {t("Se o cliente escrever durante a pausa e ninguém responder, a IA volta em (minutos)")}
          </Label>
          <Input
            id="pausa_cliente_sem_resposta_min"
            type="number"
            inputMode="numeric"
            step={1}
            min={CLIENTE_SEM_RESPOSTA_MINIMO_MIN}
            max={CLIENTE_SEM_RESPOSTA_MAXIMO_MIN}
            placeholder={t("Desligado")}
            value={espera}
            disabled={isPending}
            aria-invalid={!esperaValida}
            aria-describedby="pausa_cliente_sem_resposta_ajuda"
            onChange={(e) => setEspera(e.target.value)}
          />
          <p
            id="pausa_cliente_sem_resposta_ajuda"
            className={`text-xs ${esperaValida ? "text-muted-foreground" : "text-destructive"}`}
          >
            {t(
              "De 5 a 240 minutos. Deixe em branco para desligar: aí a IA só volta quando a pausa acabar. Não vale para conversa assumida pelo botão de assumir.",
            )}
          </p>
        </div>
        <div className="max-w-sm space-y-1">
          <Label htmlFor="pausa_cliente_sem_resposta_max_horas">
            {t("A IA só responde mensagem do cliente de até (horas)")}
          </Label>
          <Input
            id="pausa_cliente_sem_resposta_max_horas"
            type="number"
            inputMode="numeric"
            step={1}
            min={CLIENTE_SEM_RESPOSTA_MAX_HORAS_MINIMO}
            max={CLIENTE_SEM_RESPOSTA_MAX_HORAS_MAXIMO}
            value={maxHoras}
            disabled={isPending || valorEspera === null}
            aria-invalid={!maxHorasValido}
            aria-describedby="pausa_cliente_sem_resposta_max_horas_ajuda"
            onChange={(e) => setMaxHoras(e.target.value)}
          />
          <p
            id="pausa_cliente_sem_resposta_max_horas_ajuda"
            className={`text-xs ${maxHorasValido ? "text-muted-foreground" : "text-destructive"}`}
          >
            {t(
              "De 1 a 24 horas (padrão 4). Mensagem mais antiga que isso fica para a equipe. Agradecimento, despedida e figurinha nunca fazem a IA voltar.",
            )}
          </p>
        </div>
        <Button
          type="submit"
          disabled={
            isPending ||
            !valido ||
            !esperaValida ||
            !maxHorasValido ||
            (valor === salvo && valorEspera === esperaSalva && valorMaxHoras === maxHorasSalvo && fim === fimSalvo)
          }
        >
          {isPending ? t("Salvando…") : t("Salvar pausa")}
        </Button>
      </Card>
    </form>
  );
}
