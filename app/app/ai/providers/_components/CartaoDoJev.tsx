"use client";

/**
 * O cartão do Jev em IA › Provedores.
 *
 * Porte enxuto de melgarafael/DeskcommCRM #1575/#1696/#1747 (`CartaoDoJev.tsx`)
 * e do aviso da área da saúde (#2085). Mostra se há chave na instalação, o
 * interruptor com o aceite, o estado de cada tarefa e o que o Jev observou nos
 * últimos 30 dias ao lado do mecanismo de hoje.
 *
 * Cada tarefa mostra os estados que aceita (vêm da rota): o clima só observa;
 * os dois pedidos do cliente aceitam também "Avisar a equipe", que pede uma
 * confirmação antes de valer. Voltar para "Observando" é um clique, sem pergunta.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

type IdDaTarefa = "clima" | "humano" | "opt_out";
type Estado = "observando" | "decidindo" | "desligada";
type IdDoPedido = Exclude<IdDaTarefa, "clima">;

interface Resumo {
  observadas: number;
  comPar: number;
  concordou: number;
  percebidas: number;
  avisos: number;
  latenciaMediaMs: number | null;
}

interface Dados {
  chaveConfigurada: boolean;
  modelo: string;
  ligado: boolean;
  aceite: { em: string; por: string } | null;
  tarefas: Array<{ id: IdDaTarefa; estado: Estado; estados: Estado[] }>;
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

const NOME_DO_ESTADO: Record<Estado, string> = {
  observando: "Observando",
  decidindo: "Avisar a equipe",
  desligada: "Desligada",
};

/** O que o diálogo diz ANTES de "Avisar a equipe" valer (textos do upstream, #1747, adaptados). */
const AO_CONFIRMAR: Record<IdDoPedido, string> = {
  humano:
    "Quando o Jev perceber um pedido para falar com uma pessoa que a regra não pegou, ele abre um aviso na Central para alguém da equipe decidir. Ele nunca passa a conversa sozinho, não cala o assistente e não responde o cliente.",
  opt_out:
    "Quando o Jev perceber um pedido para parar de receber mensagens que a regra não pegou, ele abre um aviso na Central para alguém da equipe conferir. Quem bloqueia o contato é só a regra de hoje, quando o próprio cliente manda PARAR: o Jev nunca bloqueia ninguém.",
};

export function CartaoDoJev() {
  const t = useT();
  const [dados, setDados] = useState<Dados | null>(null);
  const [aceito, setAceito] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [confirmando, setConfirmando] = useState<IdDoPedido | null>(null);

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
            {t("Um modelo à parte (System One, da TypeSafe AI) que observa: ele dá a opinião dele ao lado do que o sistema já decide, e você compara. Nos dois pedidos do cliente, você pode pedir que ele avise a equipe na Central. Em nenhum caso ele bloqueia alguém, passa a conversa, cala o assistente ou responde o cliente.")}
          </p>
        </div>
        <Badge variant={dados.ligado ? "default" : "secondary"}>
          {dados.ligado ? t("Ligado") : t("Desligado")}
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
              {t("Ligar o Jev")}
            </label>
          </div>
        </>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-medium">
          {t("Tarefas")} · {t("últimos")} {dados.janelaDias} {t("dias")}
        </h3>
        {dados.tarefas.map(({ id, estado, estados }) => {
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
                  {id !== "clima" && (
                    <>
                      {" "}
                      · {r.avisos} {t("avisos à equipe")}
                    </>
                  )}
                  {r.latenciaMediaMs !== null && <> · {r.latenciaMediaMs} ms</>}
                </div>
              </div>
              {dados.podeEditar && dados.ligado ? (
                <div role="group" aria-label={t(NOME_DA_TAREFA[id])} className="flex flex-wrap gap-1">
                  {estados.map((opcao) => (
                    <Button
                      key={opcao}
                      size="sm"
                      variant={opcao === estado ? "default" : "outline"}
                      aria-pressed={opcao === estado}
                      disabled={salvando || opcao === estado}
                      onClick={() =>
                        opcao === "decidindo" && id !== "clima"
                          ? setConfirmando(id)
                          : void gravar({ tarefas: { [id]: opcao } })
                      }
                    >
                      {t(NOME_DO_ESTADO[opcao])}
                    </Button>
                  ))}
                </div>
              ) : (
                <Badge variant="secondary">{t(NOME_DO_ESTADO[estado])}</Badge>
              )}
            </div>
          );
        })}
      </div>

      <AlertDialog open={confirmando !== null} onOpenChange={(aberto) => !aberto && setConfirmando(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Avisar a equipe?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmando !== null && t(AO_CONFIRMAR[confirmando])}{" "}
              {t("Para voltar, clique em Observando nesta mesma linha.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmando !== null && void gravar({ tarefas: { [confirmando]: "decidindo" } })}
            >
              {t("Avisar a equipe")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
