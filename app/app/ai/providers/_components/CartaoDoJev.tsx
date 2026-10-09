"use client";

/**
 * O cartão do Jev em IA › Provedores — fase 1, só observando.
 *
 * Porte enxuto de melgarafael/DeskcommCRM #1575/#1696/#1747 (`CartaoDoJev.tsx`)
 * e do aviso da área da saúde (#2085). Mostra se há chave na instalação, o
 * interruptor com o aceite, o estado de cada tarefa e o que o Jev observou nos
 * últimos 30 dias ao lado do mecanismo de hoje. Nada aqui faz o Jev decidir.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

type IdDaTarefa = "clima" | "humano" | "opt_out";
type Estado = "observando" | "desligada";

interface Resumo {
  observadas: number;
  comPar: number;
  concordou: number;
  percebidas: number;
  latenciaMediaMs: number | null;
}

interface Dados {
  chaveConfigurada: boolean;
  modelo: string;
  ligado: boolean;
  aceite: { em: string; por: string } | null;
  tarefas: Array<{ id: IdDaTarefa; estado: Estado }>;
  resumo: Record<IdDaTarefa, Resumo>;
  janelaDias: number;
  podeEditar: boolean;
}

const NOME_DA_TAREFA: Record<IdDaTarefa, string> = {
  clima: "Clima da conversa",
  humano: "Pedido para falar com uma pessoa",
  opt_out: "Pedido para parar de receber mensagens",
};

const PERCEBIDAS: Record<IdDaTarefa, string> = {
  clima: "vistas como reclamação",
  humano: "pedidos que a regra não reconheceu",
  opt_out: "pedidos que a regra não reconheceu",
};

export function CartaoDoJev() {
  const t = useT();
  const [dados, setDados] = useState<Dados | null>(null);
  const [aceito, setAceito] = useState(false);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    const res = await fetch("/api/v1/ai/jev");
    if (res.ok) setDados(((await res.json()) as { data: Dados }).data);
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const gravar = async (corpo: Record<string, unknown>) => {
    setSalvando(true);
    try {
      const res = await fetch("/api/v1/ai/jev", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(corpo),
      });
      if (!res.ok) {
        const erro = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        toast.error(erro?.error?.message ?? t("Não consegui salvar."));
        return;
      }
      toast.success(t("Salvo."));
      await carregar();
    } finally {
      setSalvando(false);
    }
  };

  if (dados === null) return null;
  const precisaAceite = dados.aceite === null;

  return (
    <Card className="mx-auto mt-6 max-w-5xl space-y-4 p-6" data-testid="cartao-do-jev">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-medium">{t("Jev — decisões rápidas")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("Um modelo à parte (System One, da TypeSafe AI) que só OBSERVA: ele dá a opinião dele ao lado do que o sistema já decide, e você compara. Ele não bloqueia ninguém, não passa a conversa, não cala o assistente e não responde o cliente.")}
          </p>
        </div>
        <Badge variant={dados.ligado ? "default" : "secondary"}>
          {dados.ligado ? t("Observando") : t("Desligado")}
        </Badge>
      </div>

      <div role="note" className="rounded-md border border-amber-500/40 bg-amber-50/40 p-3 text-sm dark:border-amber-400/40 dark:bg-amber-900/10">
        {t("Área da saúde: as mensagens podem conter dado de saúde. Com o Jev ligado, cada mensagem do cliente, sem CPF, telefone e e-mail, vai para a TypeSafe AI, nos EUA. Confira se o contrato com a TypeSafe cobre esse tipo de dado antes de ligar.")}
      </div>

      {!dados.chaveConfigurada ? (
        <p className="text-sm text-muted-foreground">
          {t("Sem a chave JEV_API_KEY no servidor, o Jev está desligado e nenhuma mensagem sai para a TypeSafe.")}
        </p>
      ) : (
        <>
          {dados.podeEditar && precisaAceite && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={aceito}
                onChange={(e) => setAceito(e.target.checked)}
              />
              <span>
                {t("Aceito que a última mensagem de cada cliente, limpa de CPF, telefone e e-mail, seja enviada à TypeSafe AI (EUA) para o Jev observar.")}
              </span>
            </label>
          )}
          <div className="flex items-center gap-3">
            <Switch
              id="jev-ligado"
              checked={dados.ligado}
              disabled={!dados.podeEditar || salvando || (precisaAceite && !aceito && !dados.ligado)}
              onCheckedChange={(ligado) => void gravar(ligado && precisaAceite ? { ligado, aceitar: true } : { ligado })}
            />
            <label htmlFor="jev-ligado" className="text-sm">
              {t("Ligar o Jev (só observando)")}
            </label>
          </div>
        </>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-medium">
          {t("Tarefas")} · {t("últimos")} {dados.janelaDias} {t("dias")}
        </h3>
        {dados.tarefas.map(({ id, estado }) => {
          const r = dados.resumo[id];
          const concordancia = r.comPar > 0 ? Math.round((100 * r.concordou) / r.comPar) : null;
          return (
            <div key={id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
              <div>
                <div className="font-medium">{t(NOME_DA_TAREFA[id])}</div>
                <div className="text-muted-foreground">
                  {r.observadas} {t("observadas")} · {r.percebidas} {t(PERCEBIDAS[id])}
                  {concordancia !== null && (
                    <>
                      {" "}
                      · {concordancia}% {t("de concordância")}
                    </>
                  )}
                  {r.latenciaMediaMs !== null && <> · {r.latenciaMediaMs} ms</>}
                </div>
              </div>
              {dados.podeEditar && dados.ligado ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={salvando}
                  onClick={() => void gravar({ tarefas: { [id]: estado === "observando" ? "desligada" : "observando" } })}
                >
                  {estado === "observando" ? t("Desligar tarefa") : t("Voltar a observar")}
                </Button>
              ) : (
                <Badge variant="secondary">{estado === "observando" ? t("Observando") : t("Desligada")}</Badge>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
