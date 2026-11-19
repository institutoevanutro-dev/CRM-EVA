"use client";

import { useState } from "react";

import { EmptyState } from "@/components/empty";
import { ErroDeLeitura } from "@/components/empty/ErroDeLeitura";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useT } from "@/hooks/i18n/useT";
import { useTagReport } from "@/hooks/reports/useTagReport";
import { formatarDuracao } from "@/lib/metrics/atrito";
import { Tag } from "@/lib/ui/icons";

/** As mesmas três janelas de Atividades; a rota cobre no máximo 90 dias. */
const PERIODOS = [7, 30, 90] as const;

export function TagReportClient() {
  const t = useT();
  const [dias, setDias] = useState<number>(30);
  const { data, isLoading, isError, refetch } = useTagReport(dias);
  const relatorio = data?.data;

  const seletor = (
    <Select value={String(dias)} onValueChange={(v) => setDias(Number(v))}>
      <SelectTrigger className="w-44" aria-label={t("Período")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PERIODOS.map((p) => (
          <SelectItem key={p} value={String(p)}>
            {t("Últimos")} {p} {t("dias")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  let corpo: React.ReactNode;
  if (isLoading) {
    corpo = <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  } else if (isError || !relatorio) {
    corpo = <ErroDeLeitura texto={t("Erro ao carregar o relatório.")} onRetry={() => refetch()} />;
  } else if (relatorio.sem_dados) {
    corpo = (
      <EmptyState
        icon={Tag}
        headline={t("Nenhuma conversa com etiqueta no período")}
        subcopy={t(
          "Etiquete as conversas na Inbox para ver aqui qual assunto ocupou a operação — ou aumente o período.",
        )}
        primary={{ label: t("Ver conversas"), href: "/app/inbox" }}
      />
    );
  } else {
    corpo = (
      <Card>
        <CardContent className="p-0">
          <Table data-testid="tabela-por-etiqueta">
            <TableHeader>
              <TableRow>
                <TableHead>{t("Etiqueta")}</TableHead>
                <TableHead className="text-right">{t("Iniciadas")}</TableHead>
                <TableHead className="text-right">{t("Abertas")}</TableHead>
                <TableHead className="text-right">{t("Encerradas")}</TableHead>
                <TableHead className="text-right">{t("Espera média")}</TableHead>
                <TableHead className="text-right">{t("Fatia")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* A rota já devolve ordenado por volume; a tela não reordena. */}
              {relatorio.linhas.map((l) => (
                <TableRow key={l.etiqueta} data-etiqueta={l.etiqueta}>
                  <TableCell className="font-medium">{l.etiqueta}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.conversas}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.abertas}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.resolvidas}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatarDuracao(l.espera_media_segundos)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{l.fatia}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {relatorio.truncado && (
            // O corte é DITO: sem a frase, um período movimentado pareceria menor.
            <p className="p-3 text-xs text-muted-foreground" data-testid="aviso-de-corte">
              {t("O período tem conversas demais: os números cobrem só as mais recentes.")}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {seletor}
      {corpo}
    </div>
  );
}
