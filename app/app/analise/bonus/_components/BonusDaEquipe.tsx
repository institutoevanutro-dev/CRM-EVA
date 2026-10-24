"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { diaNoPeriodo, periodoAberto, type RespostaDaEquipe } from "@/lib/bonus/tela";
import { formatCentsBRL } from "@/lib/money";

export function BonusDaEquipe() {
  const t = useT();
  const q = useQuery({
    queryKey: ["bonus", "equipe"],
    queryFn: () => apiClient.get<{ data: RespostaDaEquipe }>("/api/v1/bonus/equipe"),
  });

  if (q.isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando os placares…")}</p>;
  if (q.isError || !q.data) return <p className="text-sm text-destructive">{t("Não foi possível carregar os placares.")}</p>;
  const d = q.data.data;

  return (
    <div className="flex flex-col gap-6" data-testid="bonus-da-equipe">
      {d.fila_reduzida_hoje ? (
        <p className="rounded-md border border-border p-3 text-sm">
          {t("A fila de leads antigos está reduzida: os pedidos para parar passaram do limite.")}
        </p>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{t("Placares do mês")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Pessoa")}</TableHead>
                <TableHead>{t("Tarefas no prazo")}</TableHead>
                <TableHead className="text-right">{t("Pelas tarefas")}</TableHead>
                <TableHead className="text-right">{t("Resultados")}</TableHead>
                <TableHead className="text-right">{t("Total")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.placar.pessoas.map((p) => (
                <TableRow key={p.userId}>
                  <TableCell>{d.nomes[p.userId] ?? t("Sem nome")}</TableCell>
                  <TableCell className="tabular-nums">
                    {p.tarefas.percentualBps === null ? t("Sem itens") : `${Math.floor(p.tarefas.percentualBps / 100)}%`} (
                    {p.tarefas.feitos}/{p.tarefas.devidos})
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCentsBRL(p.tarefas.valorCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCentsBRL(p.resultadosCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCentsBRL(p.totalCents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <LancarStories hoje={d.hoje} contagemDeHoje={d.stories_hoje.contagem} leituraErro={d.stories_hoje.leitura_erro} />
    </div>
  );
}

function LancarStories({ hoje, contagemDeHoje, leituraErro }: { hoje: string; contagemDeHoje: number; leituraErro: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [dia, setDia] = useState(hoje);
  const [contagem, setContagem] = useState("");
  const { min, max } = periodoAberto(hoje);
  const numero = Number(contagem);
  const valido = contagem !== "" && Number.isInteger(numero) && numero >= 0 && numero <= 50 && diaNoPeriodo(dia, hoje);
  const lancar = useMutation({
    mutationFn: () => apiClient.put("/api/v1/bonus/stories", { dia, contagem: numero }),
    onSuccess: () => {
      setContagem("");
      return qc.invalidateQueries({ queryKey: ["bonus"] });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Stories de hoje")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-2xl tabular-nums">{contagemDeHoje}</p>
        {leituraErro ? (
          <p className="text-sm text-muted-foreground" data-testid="stories-sem-leitura">
            {t("Leitura automática indisponível: lance à mão.")}
          </p>
        ) : null}
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="stories-dia">{t("Dia")}</Label>
            <Input id="stories-dia" type="date" min={min} max={max} value={dia} onChange={(e) => setDia(e.target.value)} className="w-44" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="stories-contagem">{t("Stories publicados")}</Label>
            <Input
              id="stories-contagem"
              type="number"
              min={0}
              max={50}
              step={1}
              value={contagem}
              onChange={(e) => setContagem(e.target.value)}
              className="w-28"
            />
          </div>
          <Button disabled={!valido || lancar.isPending} onClick={() => lancar.mutate()}>
            {t("Lançar")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("Só dá para lançar os dias deste mês, até hoje.")}</p>
        {lancar.isError ? <p className="text-sm text-destructive">{t("Não foi possível lançar. Tente de novo.")}</p> : null}
        {lancar.isSuccess ? <p className="text-sm text-muted-foreground">{t("Stories lançados.")}</p> : null}
      </CardContent>
    </Card>
  );
}
