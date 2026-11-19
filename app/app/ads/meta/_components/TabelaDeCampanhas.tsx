"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useT } from "@/hooks/i18n/useT";
import { rotuloDoIndicador } from "@/lib/plataformas-de-anuncio/meta/tabela-de-campanhas";
import type { LinhaDeCampanha } from "@/lib/plataformas-de-anuncio/types";

/**
 * As 14 colunas.
 *
 * ─── A regra que atravessa o arquivo inteiro: ausência vira "—" ─────────────
 *
 * Nenhum `?? 0` aqui. Campanha que não veiculou volta da plataforma sem `cpm`,
 * sem `ctr` e sem `cpc`, e campanha sem vídeo volta sem as métricas de vídeo —
 * quatro das sete campanhas da conta sondada estavam no primeiro caso. Escrever
 * "0,00%" onde não houve medição é uma afirmação falsa com aparência de dado, e
 * quem lê não tem como distinguir de um zero real. "—" é a verdade e não custa
 * nada.
 */

/**
 * `effective_status` → português.
 *
 * O vocabulário é da plataforma e vale a pena traduzir por inteiro: os valores
 * compostos (`CAMPAIGN_PAUSED`, `ADSET_PAUSED`) são justamente os que explicam
 * por que uma campanha "ativa" não está entregando, que é a pergunta que traz
 * alguém a esta tela.
 */
const ESTADO_LEGIVEL: Record<string, string> = {
  ACTIVE: "Ativa",
  PAUSED: "Pausada",
  DELETED: "Excluída",
  ARCHIVED: "Arquivada",
  IN_PROCESS: "Em processamento",
  WITH_ISSUES: "Com problemas",
  CAMPAIGN_PAUSED: "Campanha pausada",
  ADSET_PAUSED: "Conjunto pausado",
  DISAPPROVED: "Reprovada",
  PENDING_REVIEW: "Em análise",
  PREAPPROVED: "Pré-aprovada",
  PENDING_BILLING_INFO: "Aguardando dados de cobrança",
};

/** Verde só para quem está realmente entregando; âmbar para o que pede atenção. Só tokens. */
const TOM_DO_ESTADO: Record<string, string> = {
  ACTIVE: "text-success-fg",
  WITH_ISSUES: "text-warning-fg",
  DISAPPROVED: "text-error-fg",
  PENDING_BILLING_INFO: "text-warning-fg",
  PENDING_REVIEW: "text-warning-fg",
};

/**
 * Coluna com nome do dia a dia e a sigla do Gerenciador ao lado, com ⓘ. O nome
 * vem primeiro porque o `title` da sigla não abre no toque (iPhone): a
 * explicação é bônus, o nome já tem de bastar.
 */
function ColunaComSigla({ nome, sigla, explicacao }: { nome: string; sigla: string; explicacao: string }) {
  const t = useT();
  return (
    <TableHead className="text-right">
      {t(nome)}
      <abbr title={t(explicacao)} className="ml-1 font-normal text-muted-foreground no-underline">
        ({t(sigla)} <span aria-hidden>ⓘ</span>)
      </abbr>
    </TableHead>
  );
}

const TRACO = "—";

function Numero({ valor, casas = 0 }: { valor: number | null; casas?: number }) {
  if (valor === null) return <span className="text-muted-foreground">{TRACO}</span>;
  return (
    <>
      {valor.toLocaleString("pt-BR", {
        minimumFractionDigits: casas,
        maximumFractionDigits: casas,
      })}
    </>
  );
}

function Percentual({ valor, casas = 2 }: { valor: number | null; casas?: number }) {
  if (valor === null) return <span className="text-muted-foreground">{TRACO}</span>;
  return (
    <>
      {valor.toLocaleString("pt-BR", {
        minimumFractionDigits: casas,
        maximumFractionDigits: casas,
      })}
      %
    </>
  );
}

interface Props {
  linhas: LinhaDeCampanha[];
  /**
   * A moeda da CONTA, não a da instalação.
   *
   * Um token pode alcançar conta em USD e conta em BRL ao mesmo tempo. Formatar
   * tudo em real mostraria "R$ 364,63" para um gasto que foi em dólar — número
   * errado com aparência de certo, que é o pior erro possível numa tela de
   * custo. Vem de `/me/adaccounts`, por conta.
   */
  moeda: string;
}

export function TabelaDeCampanhas({ linhas, moeda }: Props) {
  const t = useT();

  const dinheiro = (valor: number | null, casas = 2) => {
    if (valor === null) return <span className="text-muted-foreground">{TRACO}</span>;
    return (
      <>
        {valor.toLocaleString("pt-BR", {
          style: "currency",
          currency: moeda,
          minimumFractionDigits: casas,
          maximumFractionDigits: casas,
        })}
      </>
    );
  };

  const estado = (valor: string | null) => {
    if (!valor) return <span className="text-muted-foreground">{TRACO}</span>;
    return (
      <span className={TOM_DO_ESTADO[valor] ?? ""}>{t(ESTADO_LEGIVEL[valor] ?? valor)}</span>
    );
  };

  if (linhas.length === 0) {
    return (
      <p className="rounded-md border p-4 text-sm text-muted-foreground">
        {/*
          Vazio tem duas causas opostas e dizer só "nenhuma campanha" esconderia
          a segunda: ou a conta não tem campanha nenhuma, ou tem e nenhuma delas
          existia no período escolhido. A segunda se resolve mudando o período,
          e quem não souber disso vai concluir que a integração está quebrada.
        */}
        {t(
          "Nenhuma campanha neste período. Ou a conta ainda não tem campanhas, ou elas foram criadas depois da data escolhida.",
        )}
      </p>
    );
  }

  return (
    /*
      O scroll horizontal mora AQUI, num contêiner próprio — nunca no `<body>`.
      São 14 colunas; em telas estreitas a tabela rola dentro do próprio quadro e
      a página segue parada, que é o combinado do produto para conteúdo largo.
    */
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-10 bg-bg">{t("Campanha")}</TableHead>
            <TableHead>{t("Situação")}</TableHead>
            <TableHead>{t("Veiculação")}</TableHead>
            <TableHead className="text-right">{t("Resultado")}</TableHead>
            <TableHead className="text-right">{t("Custo por Resultado")}</TableHead>
            <TableHead className="text-right">{t("Valor Gasto")}</TableHead>
            <TableHead className="text-right">{t("Impressões")}</TableHead>
            <TableHead className="text-right">{t("Alcance")}</TableHead>
            <ColunaComSigla
              nome="Custo por mil exibições"
              sigla="CPM"
              explicacao="Quanto custou cada mil vezes que o anúncio apareceu."
            />
            <ColunaComSigla
              nome="Taxa de cliques"
              sigla="CTR"
              explicacao="De cada 100 pessoas que viram o anúncio, quantas clicaram."
            />
            <TableHead className="text-right">{t("Frequência")}</TableHead>
            <ColunaComSigla
              nome="Custo por clique"
              sigla="CPC"
              explicacao="Quanto custou, em média, cada clique."
            />
            {/*
              A explicação diz o numerador de propósito. O Hook Rate de mercado usa
              reproduções de 3 segundos, e esse campo FOI REMOVIDO da v22.0 —
              sobrou o total de reproduções, que dá um número maior. Com o
              numerador escrito, bate a conta com o Gerenciador na hora.
            */}
            <ColunaComSigla
              nome="Começaram o vídeo"
              sigla="Hook Rate"
              explicacao="Reproduções de vídeo ÷ impressões"
            />
            <ColunaComSigla
              nome="Viram o vídeo até o fim"
              sigla="ThruPlays"
              explicacao="Reproduções até o fim, ou de pelo menos 15 segundos."
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {linhas.map((linha) => {
            const rotulo = rotuloDoIndicador(linha.resultado.indicador);
            return (
              <TableRow key={linha.campanhaId}>
                <TableCell className="sticky left-0 z-10 max-w-[22rem] bg-bg font-medium">
                  <span className="block truncate" title={linha.nome}>
                    {linha.nome}
                  </span>
                </TableCell>
                <TableCell>{estado(linha.status)}</TableCell>
                <TableCell>{estado(linha.veiculacao)}</TableCell>
                <TableCell className="text-right">
                  <Numero valor={linha.resultado.valor} />
                  {/*
                    O rótulo do indicador viaja com o número. "15" sozinho não
                    diz se são conversas, cadastros ou compras — e a tabela
                    mistura objetivos, então a mesma coluna significa coisas
                    diferentes em linhas vizinhas.
                  */}
                  {rotulo && (
                    <span className="block text-xs font-normal text-muted-foreground">
                      {t(rotulo)}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {dinheiro(linha.resultado.custoPorResultado)}
                </TableCell>
                <TableCell className="text-right">{dinheiro(linha.gasto)}</TableCell>
                <TableCell className="text-right">
                  <Numero valor={linha.impressoes} />
                </TableCell>
                <TableCell className="text-right">
                  <Numero valor={linha.alcance} />
                </TableCell>
                <TableCell className="text-right">{dinheiro(linha.cpm)}</TableCell>
                <TableCell className="text-right">
                  <Percentual valor={linha.ctr} />
                </TableCell>
                <TableCell className="text-right">
                  <Numero valor={linha.frequencia} casas={2} />
                </TableCell>
                <TableCell className="text-right">{dinheiro(linha.cpc)}</TableCell>
                <TableCell className="text-right">
                  <Percentual valor={linha.hookRate} />
                </TableCell>
                <TableCell className="text-right">
                  <Numero valor={linha.thruPlays} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
