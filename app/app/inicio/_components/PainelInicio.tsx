"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import type { Bloco, ItemDoBloco } from "@/lib/inicio/tipos";
import { PaineisDaClinica } from "./PaineisDaClinica";

type Numeros =
  | {
      ok: true;
      numeros: { conversasComPaciente: number; agendamentosCriados: number; leadsGanhos: number };
    }
  | { ok: false };
type Gasto =
  | { ok: true; consumidoCents: number; limiteCents: number | null }
  | { ok: false };
type Resposta = {
  meuDia: { avisos: Bloco; esperando: Bloco; agenda: Bloco; tarefas: Bloco };
  gestao: null | { configuracao: Bloco; numeros: Numeros; gastoIa: Gasto };
};

/** O `detalhe` dos itens de configuração é um código; aqui vira frase. */
const MOTIVO: Record<string, string> = {
  sem_responsavel: "sem responsável na agenda",
  canal_fora: "WhatsApp desconectado",
  convite_vencido: "convite vencido",
  agente_rascunho: "agente nunca publicado",
};

/** Centavos de DÓLAR (o custo de IA é calculado em USD — ver BudgetCard). */
function dolares(cents: number) {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "USD" });
}

function Cartao({
  titulo,
  children,
  verTodos,
}: {
  titulo: string;
  children: ReactNode;
  verTodos?: string;
}) {
  const t = useT();
  return (
    <section className="rounded-2xl border bg-surface p-5 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="font-titulo text-xl font-semibold text-text">{titulo}</h3>
        {verTodos ? (
          <Link className="text-sm text-accent underline-offset-4 hover:underline" href={verTodos}>
            {t("Ver todos")}
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function FalhaDoBloco() {
  const t = useT();
  return (
    <p role="alert" className="text-sm">
      {t("Não consegui carregar este bloco.")}
    </p>
  );
}

/**
 * NEM TODO NÚMERO É PROBLEMA — e é por isso que a cor é escolhida por quem
 * chama, não deduzida do total.
 *
 * "7" em Avisos da Central são sete coisas erradas; "7" em Minha agenda de hoje
 * são sete consultas, que é o dia dando certo. Pintar o total de âmbar sempre
 * que ele for maior que zero faria a primeira tela gritar com quem tem agenda
 * cheia — o oposto do que ela existe para fazer.
 *
 * `pendencia` marca os blocos em que o total conta o que está ESPERANDO alguém.
 */
function ListaDoBloco({
  bloco,
  comMotivo,
  pendencia,
  agrupar,
}: {
  bloco: Bloco | null;
  comMotivo?: boolean;
  /** O total conta coisas que esperam ação humana — o número ganha cor de atenção. */
  pendencia?: boolean;
  /** Avisos com o mesmo texto viram uma linha só, com a contagem (20 linhas iguais não dizem nada). */
  agrupar?: boolean;
}) {
  const t = useT();
  if (!bloco || !bloco.ok) return <FalhaDoBloco />;
  if (bloco.total === 0) return <p className="text-sm text-success">{t("Tudo em dia ✓")}</p>;
  const texto = (i: ItemDoBloco) =>
    comMotivo
      ? `${i.titulo}${i.detalhe ? ` — ${t(MOTIVO[i.detalhe] ?? i.detalhe)}` : ""}`
      : `${i.detalhe ? `${i.detalhe} · ` : ""}${i.titulo}`;
  const linhas: Array<{ chave: string; texto: string; href: string; vezes: number }> = [];
  for (const i of bloco.itens) {
    const tx = texto(i);
    const igual = agrupar ? linhas.find((l) => l.texto === tx) : undefined;
    if (igual) igual.vezes++;
    else linhas.push({ chave: i.id, texto: tx, href: i.href, vezes: 1 });
  }
  return (
    <>
      <p className={`numero mb-3 text-3xl${pendencia ? " text-warning" : " text-text"}`}>{bloco.total}</p>
      <ul className="divide-y divide-border">
        {linhas.map((l) => (
          <li key={l.chave}>
            {/* Alvo de toque generoso: a recepção usa isto no celular. */}
            <Link
              className="-mx-2 flex min-h-11 items-center justify-between gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted"
              href={l.href}
            >
              <span className="line-clamp-2 text-text">
                {l.texto}
                {l.vezes > 1 ? (
                  <span className="numero ml-2 rounded-full bg-warning-bg px-2 py-0.5 text-xs text-warning-fg">
                    {l.vezes}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs font-medium text-accent">{t("Resolver")} →</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

export function PainelInicio() {
  const t = useT();
  const painel = useQuery({
    queryKey: ["inicio"],
    queryFn: async () => (await apiClient.get<{ data: Resposta }>("/api/v1/inicio")).data,
    refetchOnWindowFocus: true,
  });
  const saude = useQuery({
    queryKey: ["inicio", "saude"],
    queryFn: async () =>
      (await apiClient.get<{ data: { status: string; version?: string } }>("/api/v1/health")).data,
    enabled: Boolean(painel.data?.gestao),
    refetchOnWindowFocus: true,
  });

  if (painel.isLoading) return <p>{t("Carregando…")}</p>;
  if (painel.isError || !painel.data)
    return <p role="alert">{t("Não foi possível carregar o painel. Tente novamente.")}</p>;
  const { meuDia, gestao } = painel.data;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="mb-4 font-titulo text-2xl font-semibold">{t("Meu dia")}</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Cartao titulo={t("Avisos da Central")} verTodos="/app/ai/inbox">
            <ListaDoBloco bloco={meuDia.avisos} pendencia agrupar />
          </Cartao>
          <Cartao titulo={t("Pacientes esperando resposta")} verTodos="/app/inbox">
            <ListaDoBloco bloco={meuDia.esperando} pendencia />
          </Cartao>
          <Cartao titulo={t("Minha agenda de hoje")} verTodos="/app/agenda">
            <ListaDoBloco bloco={meuDia.agenda} />
          </Cartao>
          <Cartao titulo={t("Minhas tarefas")} verTodos="/app/tasks">
            <ListaDoBloco bloco={meuDia.tarefas} />
          </Cartao>
        </div>
      </div>

      {/* Só para gestor: o servidor manda `gestao` e a rota dos painéis exige manager. */}
      {gestao ? <PaineisDaClinica /> : null}

      {gestao ? (
        <div>
          <h2 className="mb-4 font-titulo text-2xl font-semibold">{t("Gestão")}</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <Cartao titulo={t("Configuração pendente")}>
              <ListaDoBloco bloco={gestao.configuracao} comMotivo pendencia />
            </Cartao>
            <Cartao titulo={t("Números de hoje")} verTodos="/app/metrics">
              {gestao.numeros?.ok ? (
                <dl className="grid grid-cols-3 gap-3">
                  {(
                    [
                      [t("Conversas com pacientes"), gestao.numeros.numeros.conversasComPaciente],
                      [t("Agendamentos criados"), gestao.numeros.numeros.agendamentosCriados],
                      [t("Negócios ganhos"), gestao.numeros.numeros.leadsGanhos],
                    ] as const
                  ).map(([rotulo, n]) => (
                    <div key={rotulo} className="flex flex-col-reverse">
                      <dt className="text-xs text-text-muted">{rotulo}</dt>
                      <dd className="numero text-3xl">{n}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <FalhaDoBloco />
              )}
            </Cartao>
            <Cartao titulo={t("Gasto com IA no mês")}>
              {gestao.gastoIa?.ok ? (
                <p className="text-sm text-text-muted">
                  <b className="numero text-3xl text-text">{dolares(gestao.gastoIa.consumidoCents)}</b>
                  {gestao.gastoIa.limiteCents != null
                    ? ` / ${dolares(gestao.gastoIa.limiteCents)}`
                    : ` · ${t("sem limite configurado")}`}
                </p>
              ) : (
                <FalhaDoBloco />
              )}
            </Cartao>
            <Cartao titulo={t("Sistema")}>
              {saude.isLoading ? (
                <p className="text-sm">{t("Carregando…")}</p>
              ) : saude.data?.status === "healthy" ? (
                <p className="flex items-center gap-2 text-sm">
                  <span aria-hidden className="size-2.5 rounded-full bg-success" />
                  {t("Tudo no ar")}
                  {saude.data.version ? ` · ${t("versão")} ${saude.data.version}` : ""}
                </p>
              ) : (
                <p role="alert" className="flex items-center gap-2 text-sm">
                  <span aria-hidden className="size-2.5 rounded-full bg-error" />
                  {t("Algum serviço está fora do ar. Avise o suporte.")}
                </p>
              )}
            </Cartao>
          </div>
        </div>
      ) : null}
    </div>
  );
}
