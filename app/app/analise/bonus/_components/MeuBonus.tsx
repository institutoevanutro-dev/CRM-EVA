"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { marcarReleitura } from "@/lib/audit/releitura";
import type { ResultadoDoCriterio } from "@/lib/bonus/calculo";
import type { ItemDaFilaNaTela, RespostaMeuBonus } from "@/lib/bonus/tela";
import type { ResultadoDeLigacao } from "@/lib/bonus/tipos";
import { formatCentsBRL } from "@/lib/money";

export const ROTULO_DO_CRITERIO: Record<ResultadoDoCriterio["chave"], string> = {
  comparecimento: "Comparecimento",
  sinal_pago: "Sinal pago",
  avaliacao_google: "Avaliação no Google",
};

const ROTULO_DO_MOTIVO: Record<NonNullable<ItemDaFilaNaTela["motivo"]>, string> = {
  faltou: "Faltou à consulta",
  sem_retorno: "Não voltou para o retorno",
  pos_consulta: "Pós-consulta",
};

const CHAVE_MEU = ["bonus", "meu"] as const;

export function MeuBonus() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: CHAVE_MEU,
    // A primeira carga é a abertura (audita a leitura da fila); recarga, polling
    // e invalidação vão com `atualizacao=1` e não viram linha nova na trilha.
    queryFn: () => {
      const qs = marcarReleitura(new URLSearchParams(), qc.getQueryData(CHAVE_MEU) !== undefined);
      const sufixo = qs.size > 0 ? `?${qs.toString()}` : "";
      return apiClient.get<{ data: RespostaMeuBonus }>(`/api/v1/bonus/meu${sufixo}`);
    },
    refetchInterval: 60_000,
  });
  const [ligando, setLigando] = useState<ItemDaFilaNaTela | null>(null);

  if (q.isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando o placar…")}</p>;
  if (q.isError || !q.data) return <p className="text-sm text-destructive">{t("Não foi possível carregar o placar.")}</p>;
  const d = q.data.data;
  const p = d.pessoa;
  const percentual = p.tarefas.percentualBps === null ? t("Sem itens") : `${Math.floor(p.tarefas.percentualBps / 100)}%`;
  const leads = d.fila?.filter((i) => i.tipo === "lead_antigo") ?? [];
  const ligacoes = d.fila?.filter((i) => i.tipo === "ligacao") ?? [];

  return (
    <div className="flex flex-col gap-6" data-testid="meu-bonus">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{t("Tarefas no prazo")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl tabular-nums" data-testid="percentual-tarefas">
              {percentual}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("{feitos} de {devidos} · {pendentes} ainda em aberto")
                .replace("{feitos}", String(p.tarefas.feitos))
                .replace("{devidos}", String(p.tarefas.devidos))
                .replace("{pendentes}", String(p.tarefas.pendentes))}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("Faixa atual")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl tabular-nums">{formatCentsBRL(p.tarefas.valorCents)}</p>
            <p className="text-sm text-muted-foreground">{t("pelas tarefas, se o mês fechasse hoje")}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("Total do mês até agora")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl tabular-nums" data-testid="total-do-mes">
              {formatCentsBRL(p.totalCents)}
            </p>
            <p className="text-sm text-muted-foreground">
              {d.mes_de_teste ? t("Mês de teste: os resultados estão garantidos.") : t("Tarefas mais resultados da dupla.")}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("Resultados da dupla")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          {d.resultados.map((r) => (
            <div key={r.chave} className="rounded-md border border-border p-3">
              <p className="text-sm font-medium">{t(ROTULO_DO_CRITERIO[r.chave])}</p>
              <p className="text-2xl tabular-nums">{r.contagem ?? t("A lançar")}</p>
              <p className="text-xs text-muted-foreground">
                {r.basica === null
                  ? t("Meta ainda não definida")
                  : t("Meta básica {basica} · Meta alta {alta}")
                      .replace("{basica}", String(r.basica))
                      .replace("{alta}", String(r.alta))}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      {d.fila ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("Minha fila de hoje")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {d.janela && !d.janela.aberta ? (
              <p className="text-sm text-muted-foreground" data-testid="janela-fechada">
                {t("Fora do horário de envio do número. As mensagens ficam para quando a janela abrir.")}
              </p>
            ) : null}

            <section>
              <h3 className="mb-2 font-medium">
                {t("Leads antigos")} · {leads.filter((l) => l.enviada).length}/{leads.length}
              </h3>
              {leads.length === 0 ? <p className="text-sm text-muted-foreground">{t("Nenhum lead na fila de hoje.")}</p> : null}
              <ul className="flex flex-col gap-2">
                {leads.map((l) => (
                  <li
                    key={l.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border p-2"
                    data-testid="item-lead"
                  >
                    <span className="truncate">{l.contato_nome}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      {l.enviada ? <Badge variant="success">{t("Mensagem enviada")}</Badge> : null}
                      {l.conversation_id ? (
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/app/inbox?id=${l.conversation_id}`}>{t("Abrir a conversa")}</Link>
                        </Button>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                {t("As respostas prontas ficam na conversa, no botão de respostas rápidas.")}
              </p>
            </section>

            <section>
              <h3 className="mb-2 font-medium">
                {t("Pacientes para ligar")} · {ligacoes.filter((l) => l.ligacao_resultado).length}/{ligacoes.length}
              </h3>
              {ligacoes.length === 0 ? <p className="text-sm text-muted-foreground">{t("Nenhuma ligação na fila de hoje.")}</p> : null}
              <ul className="flex flex-col gap-2">
                {ligacoes.map((l) => (
                  <li
                    key={l.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border p-2"
                    data-testid="item-ligacao"
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{l.contato_nome}</span>
                      <span className="block text-xs text-muted-foreground">
                        {l.motivo ? t(ROTULO_DO_MOTIVO[l.motivo]) : null}
                        {l.telefone ? (
                          <>
                            {l.motivo ? " · " : null}
                            <a className="underline" href={`tel:${l.telefone}`}>
                              {l.telefone}
                            </a>
                          </>
                        ) : null}
                      </span>
                    </span>
                    {l.ligacao_resultado ? (
                      <Badge variant={l.ligacao_resultado === "atendeu" ? "success" : "neutral"}>
                        {l.ligacao_resultado === "atendeu" ? t("Atendeu") : t("Não atendeu")}
                      </Badge>
                    ) : (
                      <Button size="sm" onClick={() => setLigando(l)}>
                        {t("Registrar ligação")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="font-medium">{t("Stories de hoje")}</h3>
              <p className="text-2xl tabular-nums" data-testid="stories-hoje">
                {d.stories_hoje.contagem} / {d.stories_hoje.meta}
              </p>
            </section>
          </CardContent>
        </Card>
      ) : null}

      {ligando ? <RegistrarLigacao item={ligando} aoFechar={() => setLigando(null)} /> : null}
    </div>
  );
}

function RegistrarLigacao({ item, aoFechar }: { item: ItemDaFilaNaTela; aoFechar: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [resultado, setResultado] = useState<ResultadoDeLigacao | null>(null);
  const [resumo, setResumo] = useState("");
  const salvar = useMutation({
    mutationFn: () => apiClient.post("/api/v1/bonus/ligacoes", { item_id: item.id, resultado, resumo }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: CHAVE_MEU });
      aoFechar();
    },
  });
  return (
    <Dialog open onOpenChange={(aberto) => (aberto ? null : aoFechar())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("Registrar ligação")} · {item.contato_nome}
          </DialogTitle>
        </DialogHeader>
        <div className="flex gap-2" role="radiogroup" aria-label={t("Resultado da ligação")}>
          <Button
            variant={resultado === "atendeu" ? "default" : "outline"}
            onClick={() => setResultado("atendeu")}
            role="radio"
            aria-checked={resultado === "atendeu"}
          >
            {t("Atendeu")}
          </Button>
          <Button
            variant={resultado === "nao_atendeu" ? "default" : "outline"}
            onClick={() => setResultado("nao_atendeu")}
            role="radio"
            aria-checked={resultado === "nao_atendeu"}
          >
            {t("Não atendeu")}
          </Button>
        </div>
        <Textarea
          aria-label={t("Resumo curto")}
          placeholder={t("Resumo curto da conversa")}
          maxLength={500}
          value={resumo}
          onChange={(e) => setResumo(e.target.value)}
        />
        {salvar.isError ? (
          <p className="text-sm text-destructive">{t("Não foi possível registrar. Confira o resumo e tente de novo.")}</p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={aoFechar}>
            {t("Cancelar")}
          </Button>
          <Button disabled={!resultado || resumo.trim().length < 3 || salvar.isPending} onClick={() => salvar.mutate()}>
            {t("Salvar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
