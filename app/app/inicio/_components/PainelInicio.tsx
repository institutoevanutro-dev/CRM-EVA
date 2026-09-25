"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import type { Bloco } from "@/lib/inicio/tipos";

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
    <section className="rounded-lg border p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-medium">{titulo}</h3>
        {verTodos ? (
          <Link className="text-sm text-accent underline" href={verTodos}>
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
}: {
  bloco: Bloco | null;
  comMotivo?: boolean;
  /** O total conta coisas que esperam ação humana — o número ganha cor de atenção. */
  pendencia?: boolean;
}) {
  const t = useT();
  if (!bloco || !bloco.ok) return <FalhaDoBloco />;
  if (bloco.total === 0) return <p className="text-sm text-success">{t("Tudo em dia ✓")}</p>;
  return (
    <>
      <p className={`mb-2 text-3xl font-semibold${pendencia ? " text-warning" : ""}`}>
        {bloco.total}
      </p>
      <ul className="space-y-1">
        {bloco.itens.map((i) => (
          <li key={i.id}>
            {/* Alvo de toque generoso: a recepção usa isto no celular. */}
            <Link
              className="flex min-h-11 items-center justify-between gap-2 rounded-md px-2 hover:bg-muted"
              href={i.href}
            >
              <span className="truncate">
                {comMotivo
                  ? `${i.titulo}${i.detalhe ? ` — ${t(MOTIVO[i.detalhe] ?? i.detalhe)}` : ""}`
                  : `${i.detalhe ? `${i.detalhe} · ` : ""}${i.titulo}`}
              </span>
              <span className="shrink-0 text-sm text-accent underline">{t("Resolver")}</span>
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
        <h2 className="mb-3 text-lg font-semibold">{t("Meu dia")}</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Cartao titulo={t("Avisos da Central")} verTodos="/app/ai/inbox">
            <ListaDoBloco bloco={meuDia.avisos} pendencia />
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

      {gestao ? (
        <div>
          <h2 className="mb-3 text-lg font-semibold">{t("Gestão")}</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <Cartao titulo={t("Configuração pendente")}>
              <ListaDoBloco bloco={gestao.configuracao} comMotivo pendencia />
            </Cartao>
            <Cartao titulo={t("Números de hoje")} verTodos="/app/metrics">
              {gestao.numeros?.ok ? (
                <ul className="space-y-1 text-sm">
                  <li>
                    {t("Conversas com pacientes")}: <b>{gestao.numeros.numeros.conversasComPaciente}</b>
                  </li>
                  <li>
                    {t("Agendamentos criados")}: <b>{gestao.numeros.numeros.agendamentosCriados}</b>
                  </li>
                  <li>
                    {t("Negócios ganhos")}: <b>{gestao.numeros.numeros.leadsGanhos}</b>
                  </li>
                </ul>
              ) : (
                <FalhaDoBloco />
              )}
            </Cartao>
            <Cartao titulo={t("Gasto com IA no mês")}>
              {gestao.gastoIa?.ok ? (
                <p className="text-sm">
                  <b className="text-2xl">{dolares(gestao.gastoIa.consumidoCents)}</b>
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
                <p className="text-sm">
                  🟢 {t("Tudo no ar")}
                  {saude.data.version ? ` · ${t("versão")} ${saude.data.version}` : ""}
                </p>
              ) : (
                <p role="alert" className="text-sm">
                  🔴 {t("Algum serviço está fora do ar. Avise o suporte.")}
                </p>
              )}
            </Cartao>
          </div>
        </div>
      ) : null}
    </div>
  );
}
