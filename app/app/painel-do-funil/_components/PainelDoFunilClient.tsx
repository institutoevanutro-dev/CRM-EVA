"use client";

import { useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import {
  usePainelDoFunil,
  type FiltrosDoPainel,
  type PainelDoFunil,
} from "@/hooks/metrics/usePainelDoFunil";
import { formatCents } from "@/lib/money";

const NENHUM = "__nenhum";
const FORA_DA_LISTA = "__fora_da_lista";

/** A frase de cada motivo de investimento indisponível (os códigos da rota). */
const MOTIVOS: Record<string, string> = {
  token_invalido: "A plataforma recusou o token de acesso.",
  permissao_insuficiente: "O token não tem permissão de leitura de anúncios (ads_read).",
  limite_de_chamadas: "A plataforma limitou as chamadas. Espere alguns minutos e atualize.",
  campo_invalido: "A plataforma recusou um campo da consulta. Avise quem mantém a instalação.",
  transitorio: "Não consegui falar com a plataforma agora.",
  cifra_indisponivel: "A chave de criptografia da instalação não está disponível.",
  conta_fora_do_alcance: "A conta padrão escolhida não está entre as contas que o token alcança.",
};

/** Um número, e embaixo dele o que ele conta. */
function Numero({
  id,
  titulo,
  valor,
  regua,
  extra,
}: {
  id: string;
  titulo: string;
  valor: ReactNode;
  regua: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <Card data-numero={id}>
      <CardContent className="flex flex-col gap-1 p-4">
        <span className="text-sm text-muted-foreground">{titulo}</span>
        <span className="text-2xl font-semibold tabular-nums" data-valor>
          {valor}
        </span>
        {extra ? <span className="text-sm">{extra}</span> : null}
        <span className="text-xs text-muted-foreground">{regua}</span>
      </CardContent>
    </Card>
  );
}

export function PainelDoFunilClient({ podeConectar }: { podeConectar: boolean }) {
  const t = useT();
  const tag = useTagDeIdioma();
  const [rascunho, setRascunho] = useState<FiltrosDoPainel>({});
  const [filtros, setFiltros] = useState<FiltrosDoPainel>({});
  const consulta = usePainelDoFunil(filtros);
  const painel = consulta.data?.data;

  const pct = (x: number | null) =>
    x === null
      ? "—"
      : new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 0 }).format(x);
  const dinheiro = (cents: number | string, moeda: string) => formatCents(Number(cents), moeda);
  const receita = (r: { moeda: string; cents: string }[]) =>
    r.length ? r.map((x) => dinheiro(x.cents, x.moeda)).join(" + ") : "—";

  const aplicar = (e: FormEvent) => {
    e.preventDefault();
    setFiltros(rascunho);
  };
  const mudar = (parcial: FiltrosDoPainel) => setRascunho((r) => ({ ...r, ...parcial }));

  const caminhoDoAnuncio = podeConectar
    ? t("Confira em Configurações › Meta Ads.")
    : t("Peça a quem administra a organização.");

  function estadoDoInvestimento(inv: PainelDoFunil["investimento"]): string {
    if (inv.estado === "nao_conectado") {
      return podeConectar
        ? t("Nenhuma conta de anúncios conectada. Conecte em Configurações › Meta Ads.")
        : t(
            "Nenhuma conta de anúncios conectada. Peça a quem administra a organização para conectar.",
          );
    }
    if (inv.estado === "sem_conta")
      return `${t("O token não alcança nenhuma conta de anúncios.")} ${caminhoDoAnuncio}`;
    if (inv.estado === "indisponivel") {
      return `${t(MOTIVOS[inv.motivo] ?? "Não consegui ler o investimento agora.")} ${caminhoDoAnuncio}`;
    }
    return "";
  }

  const opcoes = painel?.opcoes;
  const camposDoRecorte =
    rascunho.dimensao === "campo_contato" ? opcoes?.campos_contato : opcoes?.campos_card;

  const filtrosForm = (
    <form
      onSubmit={aplicar}
      className="flex flex-wrap items-end gap-3"
      aria-label={t("Filtros do painel")}
    >
      <label className="flex flex-col gap-1 text-sm">
        {t("De")}
        <Input
          type="date"
          className="w-40"
          value={rascunho.de ?? painel?.periodo.de ?? ""}
          onChange={(e) => mudar({ de: e.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t("Até")}
        <Input
          type="date"
          className="w-40"
          value={rascunho.ate ?? painel?.periodo.ate ?? ""}
          onChange={(e) => mudar({ ate: e.target.value })}
        />
      </label>
      <div className="flex flex-col gap-1 text-sm">
        <span>{t("Funil")}</span>
        <Select
          value={rascunho.pipeline_id ?? painel?.funil.id ?? ""}
          onValueChange={(v) => mudar({ pipeline_id: v, campo: undefined })}
        >
          <SelectTrigger className="w-52" aria-label={t("Funil")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(opcoes?.funis ?? []).map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.nome}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <span>{t("Recorte")}</span>
        <Select
          value={rascunho.dimensao ?? NENHUM}
          onValueChange={(v) => mudar({ dimensao: v === NENHUM ? undefined : v, campo: undefined })}
        >
          <SelectTrigger className="w-60" aria-label={t("Recorte")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NENHUM}>{t("Sem recorte")}</SelectItem>
            <SelectItem value="campo_contato">{t("Campo da ficha do contato")}</SelectItem>
            <SelectItem value="campo_card">{t("Campo do card")}</SelectItem>
            <SelectItem value="etiqueta">{t("Etiqueta com prefixo")}</SelectItem>
            <SelectItem value="campanha">{t("Campanha de anúncio")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {rascunho.dimensao === "campo_contato" || rascunho.dimensao === "campo_card" ? (
        <div className="flex flex-col gap-1 text-sm">
          <span>{t("Campo")}</span>
          {camposDoRecorte?.length ? (
            <Select value={rascunho.campo ?? ""} onValueChange={(v) => mudar({ campo: v })}>
              <SelectTrigger className="w-48" aria-label={t("Campo")}>
                <SelectValue placeholder={t("Escolha o campo")} />
              </SelectTrigger>
              <SelectContent>
                {camposDoRecorte.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="py-2 text-muted-foreground">
              {t("Nenhum campo de lista neste funil.")}
            </span>
          )}
        </div>
      ) : null}
      {rascunho.dimensao === "etiqueta" ? (
        <label className="flex flex-col gap-1 text-sm">
          {t("Prefixo")}
          <Input
            className="w-40"
            placeholder="criativo-"
            value={rascunho.prefixo ?? ""}
            onChange={(e) => mudar({ prefixo: e.target.value })}
          />
        </label>
      ) : null}
      <Button type="submit">{t("Aplicar")}</Button>
    </form>
  );

  if (consulta.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        {filtrosForm}
        <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
      </div>
    );
  }
  if (consulta.isError || !painel) {
    return (
      <div className="flex flex-col gap-6">
        {filtrosForm}
        <p className="text-sm text-destructive" role="alert">
          {consulta.error instanceof Error && consulta.error.message
            ? t(consulta.error.message)
            : t("Erro ao carregar o painel.")}
        </p>
      </div>
    );
  }

  const n = painel.numeros;
  const inv = painel.investimento;
  const maxEtapa = Math.max(1, ...painel.por_etapa.map((e) => e.alcancaram));
  const rotuloEspecial = (chave: string) => {
    if (chave === FORA_DA_LISTA) return t("(fora da lista)");
    if (painel.dimensao?.tipo === "etiqueta") return t("(sem etiqueta com o prefixo)");
    if (painel.dimensao?.tipo === "campanha") return t("(sem campanha)");
    return t("(sem valor)");
  };
  const reguaDoRecorte: Record<string, string> = {
    campo_contato:
      "Pelo campo da ficha do contato do card. Agendamento herda o valor do card a que está ligado.",
    campo_card: "Pelo campo do card. Agendamento herda o valor do card a que está ligado.",
    etiqueta:
      "Pelas etiquetas do contato que começam com o prefixo. Um contato com duas dessas etiquetas conta nas duas.",
    campanha:
      "Pela campanha de anúncio atribuída ao contato, como na tela Meta Ads. Campanha sem gasto no período aparece pelo número.",
  };

  return (
    <div className="flex flex-col gap-6" data-testid="painel-do-funil">
      {filtrosForm}

      {painel.truncado ? (
        <p className="text-sm text-muted-foreground" data-testid="aviso-de-corte">
          {t(
            "O período tem dados demais para ler de uma vez: alguns números cobrem só parte dele. Diminua o período.",
          )}
        </p>
      ) : null}

      <section
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
        aria-label={t("Números do período")}
      >
        <Numero
          id="investimento"
          titulo={t("Investimento")}
          valor={inv.estado === "ok" ? dinheiro(inv.cents, inv.moeda) : t("Não disponível")}
          extra={inv.estado === "ok" ? `${t("Conta")}: ${inv.conta}` : estadoDoInvestimento(inv)}
          regua={t(
            "Gasto da conta de anúncios inteira no período, não só deste funil. Lido da plataforma agora, com as datas no fuso da conta.",
          )}
        />
        <Numero
          id="leads"
          titulo={t("Leads")}
          valor={n.leads}
          regua={t("Cards criados neste funil no período.")}
        />
        <Numero
          id="interagiram"
          titulo={t("Interagiram")}
          valor={n.interagiram ?? "—"}
          extra={`${t("Taxa de interação")}: ${pct(n.taxa_interacao)}`}
          regua={
            n.aviso_interacao
              ? t(
                  "Nenhuma etapa deste funil está ligada ao passo Primeiro contato do agente. Ligue uma em CRM › Etapas do funil.",
                )
              : `${t("Cards criados no período que chegaram à etapa ligada ao passo Primeiro contato do agente, ou além.")} (${n.etapa_interacao})`
          }
        />
        <Numero
          id="ganhos"
          titulo={t("Ganhos")}
          valor={n.ganhos}
          extra={n.sem_valor ? `${n.sem_valor} ${t("sem valor")}` : undefined}
          regua={t(
            "Cards deste funil ganhos com fechamento no período, inclusive os criados antes. Um card que foi de perdido direto para ganho fica com a data da perda.",
          )}
        />
        <Numero
          id="receita"
          titulo={t("Receita")}
          valor={receita(n.receita)}
          extra={n.sem_moeda ? `${n.sem_moeda} ${t("sem moeda")}` : undefined}
          regua={t("Soma do valor dos ganhos, por moeda.")}
        />
        <Numero
          id="ganhos_de_anuncio"
          titulo={t("Ganhos de anúncio")}
          valor={n.ganhos_de_anuncio ?? "—"}
          regua={t(
            "Ganhos cujo contato veio de uma campanha da conta conectada, com a mesma atribuição da tela Meta Ads.",
          )}
        />
        <Numero
          id="custo_por_venda"
          titulo={t("Custo por venda")}
          valor={
            n.custo_por_venda_cents !== null && inv.estado === "ok"
              ? dinheiro(n.custo_por_venda_cents, inv.moeda)
              : "—"
          }
          regua={t(
            "Investimento ÷ ganhos de anúncio. O gasto é da conta inteira: com mais de um funil, o custo de cada um sai maior do que é.",
          )}
        />
        <Numero
          id="roas"
          titulo={t("ROAS")}
          valor={
            n.roas === null
              ? "—"
              : `${new Intl.NumberFormat(tag, { maximumFractionDigits: 2 }).format(n.roas)}×`
          }
          regua={t(
            "Receita dos ganhos de anúncio na moeda da conta ÷ investimento. O gasto é da conta inteira.",
          )}
        />
        <Numero
          id="agendamentos"
          titulo={t("Agendamentos")}
          valor={n.agendados}
          extra={n.cancelados ? `${n.cancelados} ${t("cancelados")}` : undefined}
          regua={t(
            "Compromissos com início no período ligados a um card deste funil. Não conta cancelados.",
          )}
        />
        <Numero
          id="realizados"
          titulo={t("Realizados")}
          valor={n.realizados}
          regua={t("Desses, os marcados como realizado.")}
        />
        <Numero
          id="faltas"
          titulo={t("Faltas")}
          valor={n.faltas}
          regua={t("Desses, os marcados como falta.")}
        />
        <Numero
          id="comparecimento"
          titulo={t("Comparecimento")}
          valor={pct(n.taxa_comparecimento)}
          extra={n.sem_baixa ? `${n.sem_baixa} ${t("sem baixa")}` : undefined}
          regua={t(
            "Realizados ÷ (realizados + faltas). Sem baixa: já terminaram e ninguém marcou se a pessoa veio.",
          )}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("Até onde chegaram")}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {t(
              "Cards criados no período que chegaram a cada etapa ou além, até agora. Um card que avançou e voltou continua contando onde chegou. Etapa arquivada não conta.",
            )}
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {painel.por_etapa.map((e) => (
            <div key={e.stage_id} className="flex items-center gap-3" data-etapa={e.nome}>
              <span className="w-40 shrink-0 truncate text-sm">{e.nome}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${(e.alcancaram / maxEtapa) * 100}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right text-sm tabular-nums">{e.alcancaram}</span>
            </div>
          ))}
          <p className="text-sm text-muted-foreground">
            {t("Perdidos")}: <span className="tabular-nums">{n.perdidos}</span>
          </p>
        </CardContent>
      </Card>

      {painel.dimensao ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("Recorte")}</CardTitle>
            <p className="text-xs text-muted-foreground">
              {t(reguaDoRecorte[painel.dimensao.tipo] ?? "")}
            </p>
          </CardHeader>
          <CardContent className="p-0">
            {painel.dimensao.estado ? (
              <p className="p-4 text-sm">{estadoDoInvestimento(inv)}</p>
            ) : (
              <Table data-testid="tabela-do-recorte">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Valor")}</TableHead>
                    <TableHead className="text-right">{t("Leads")}</TableHead>
                    <TableHead className="text-right">{t("Interagiram")}</TableHead>
                    <TableHead className="text-right">{t("Ganhos")}</TableHead>
                    <TableHead className="text-right">{t("Receita")}</TableHead>
                    <TableHead className="text-right">{t("Agendamentos")}</TableHead>
                    <TableHead className="text-right">{t("Realizados")}</TableHead>
                    {painel.dimensao.tipo === "campanha" ? (
                      <TableHead className="text-right">{t("Investimento")}</TableHead>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {painel.dimensao.linhas.map((l) => (
                    <TableRow key={l.chave} data-valor={l.chave}>
                      <TableCell className="font-medium">
                        {l.rotulo ?? rotuloEspecial(l.chave)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{l.leads}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {l.interagiram ?? "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{l.ganhos}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {receita(l.receita)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{l.agendados}</TableCell>
                      <TableCell className="text-right tabular-nums">{l.realizados}</TableCell>
                      {painel.dimensao?.tipo === "campanha" ? (
                        <TableCell className="text-right tabular-nums">
                          {l.investimento_cents === null ||
                          l.investimento_cents === undefined ||
                          inv.estado !== "ok"
                            ? "—"
                            : dinheiro(l.investimento_cents, inv.moeda)}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
