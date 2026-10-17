"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Bell, CalendarDays, CircleCheck, ListChecks, MessageCircle } from "lucide-react";

import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import type { Bloco, ItemDoBloco } from "@/lib/inicio/tipos";
import { PaineisDaClinica, type NumerosDeHoje } from "./PaineisDaClinica";
import { CabecalhoDaSecao, Cartao, Esqueleto, FOCO } from "./partes";

type Gasto =
  | { ok: true; consumidoCents: number; limiteCents: number | null }
  | { ok: false };
type Resposta = {
  meuDia: { avisos: Bloco; esperando: Bloco; agenda: Bloco; tarefas: Bloco };
  gestao: null | { configuracao: Bloco; numeros: NumerosDeHoje; gastoIa: Gasto };
};

/** O `detalhe` dos itens de configuração é um código; aqui vira frase. */
const MOTIVO: Record<string, string> = {
  sem_responsavel: "sem responsável na agenda",
  canal_fora: "WhatsApp desconectado",
  convite_vencido: "convite vencido",
  agente_rascunho: "agente nunca publicado",
};

/**
 * Por que o aviso chegou a esta pessoa (`escopoDoAviso`, lib/inicio/meu-dia.ts).
 * Só gerente e admin recebem estes dois; para os demais todo aviso é "meu".
 */
const ESCOPO_DO_AVISO: Record<string, string> = {
  sem_dono: "ninguém assumiu",
  organizacao: "da clínica",
};

/** Centavos de DÓLAR (o custo de IA é calculado em USD — ver BudgetCard). */
function dolares(cents: number) {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "USD" });
}

function FalhaDoBloco() {
  const t = useT();
  return (
    <p role="alert" className="text-sm text-error">
      {t("Não consegui carregar este bloco.")}
    </p>
  );
}

/** Vazio com frase própria de cada bloco: "nada aqui" diz menos que "ninguém esperando por você". */
function Vazio({ texto }: { texto: string }) {
  return (
    <p className="flex items-center gap-2 py-2 text-sm text-success">
      <CircleCheck aria-hidden className="size-4 shrink-0" />
      {texto}
    </p>
  );
}

/**
 * NEM TODO NÚMERO É PROBLEMA — e é por isso que a cor é escolhida por quem
 * chama, não deduzida do total.
 *
 * "7" em avisos são sete coisas erradas; "7" em agenda de hoje são sete
 * consultas, que é o dia dando certo. `pendencia` marca os blocos em que o
 * total conta o que está ESPERANDO alguém.
 */
function ListaDoBloco({
  bloco,
  vazio,
  rotulo,
  comMotivo,
  comEscopo,
  pendencia,
  agrupar,
}: {
  bloco: Bloco | null;
  vazio: string;
  /** O que o número conta: ele nunca fica solto na tela. */
  rotulo: string;
  comMotivo?: boolean;
  /** Avisos: o detalhe é o escopo (meu / da clínica / ninguém assumiu). */
  comEscopo?: boolean;
  pendencia?: boolean;
  /** Avisos com o mesmo texto viram uma linha só, com a contagem. */
  agrupar?: boolean;
}) {
  const t = useT();
  if (!bloco || !bloco.ok) return <FalhaDoBloco />;
  if (bloco.total === 0) return <Vazio texto={t(vazio)} />;
  const texto = (i: ItemDoBloco) =>
    comMotivo
      ? `${i.titulo}${i.detalhe ? ` — ${t(MOTIVO[i.detalhe] ?? i.detalhe)}` : ""}`
      : comEscopo
        ? i.titulo
        : `${i.detalhe ? `${i.detalhe} · ` : ""}${i.titulo}`;
  const linhas: Array<{ chave: string; texto: string; href: string; vezes: number; selo?: string }> = [];
  for (const i of bloco.itens) {
    const tx = texto(i);
    const selo = comEscopo && i.detalhe ? ESCOPO_DO_AVISO[i.detalhe] : undefined;
    const igual = agrupar ? linhas.find((l) => l.texto === tx && l.selo === selo) : undefined;
    if (igual) igual.vezes++;
    else linhas.push({ chave: i.id, texto: tx, href: i.href, vezes: 1, ...(selo ? { selo } : {}) });
  }
  return (
    <>
      <p className="mb-2 flex items-baseline gap-2">
        <span className={`numero text-3xl ${pendencia ? "text-warning" : "text-text"}`}>{bloco.total}</span>
        <span className="text-sm text-text-muted">{t(rotulo)}</span>
      </p>
      <ul className="divide-y divide-border">
        {linhas.map((l) => (
          <li key={l.chave}>
            {/* Alvo de toque generoso: a recepção usa isto no celular. */}
            <Link
              className={`-mx-2 flex min-h-11 items-center justify-between gap-3 rounded-md px-2 py-2 text-sm hover:bg-row-hover ${FOCO}`}
              href={l.href}
            >
              <span className="min-w-0 text-text">
                <span className="line-clamp-2 break-words">{l.texto}</span>
                {l.selo || l.vezes > 1 ? (
                  <span className="mt-1 flex flex-wrap gap-1.5">
                    {l.selo ? (
                      <span className="rounded-full bg-info-bg px-2 py-0.5 text-xs text-info-fg">{t(l.selo)}</span>
                    ) : null}
                    {l.vezes > 1 ? (
                      <span className="numero rounded-full bg-warning-bg px-2 py-0.5 text-xs text-warning-fg">
                        {l.vezes}×
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs font-medium text-accent">{t("Abrir")} →</span>
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

  if (painel.isLoading)
    return (
      <div className="space-y-4">
        <div className="h-8 w-40 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <Esqueleto quantos={4} />
      </div>
    );
  if (painel.isError || !painel.data)
    return (
      <div role="alert" className="rounded-2xl border bg-surface p-5 text-sm">
        <p>{t("Não foi possível carregar o painel. Tente novamente.")}</p>
        <button
          type="button"
          onClick={() => void painel.refetch()}
          className={`mt-3 min-h-10 rounded-lg border px-3 text-sm font-medium hover:bg-row-hover ${FOCO}`}
        >
          {t("Tentar de novo")}
        </button>
      </div>
    );
  const { meuDia, gestao } = painel.data;

  return (
    <div className="space-y-10">
      <section aria-labelledby="inicio-meu-dia">
        <CabecalhoDaSecao
          id="inicio-meu-dia"
          titulo={t("Meu dia")}
          descricao={
            gestao
              ? t("O que é seu, mais os avisos da clínica que ninguém assumiu.")
              : t("Só o que é seu: suas conversas, sua agenda, suas tarefas e os seus avisos.")
          }
        />
        <div className="grid gap-4 md:grid-cols-2">
          <Cartao titulo={t("Pacientes esperando resposta")} icone={MessageCircle} verTodos="/app/inbox">
            <ListaDoBloco bloco={meuDia.esperando} rotulo="esperando por você" vazio="Ninguém esperando resposta sua." pendencia />
          </Cartao>
          <Cartao titulo={t("Minha agenda de hoje")} icone={CalendarDays} verTodos="/app/agenda">
            <ListaDoBloco bloco={meuDia.agenda} rotulo="compromissos hoje" vazio="Nenhum compromisso seu hoje." />
          </Cartao>
          <Cartao titulo={t("Minhas tarefas")} icone={ListChecks} verTodos="/app/tasks">
            <ListaDoBloco bloco={meuDia.tarefas} rotulo="para hoje ou atrasadas" vazio="Nenhuma tarefa sua para hoje." />
          </Cartao>
          <Cartao titulo={t("Meus avisos")} icone={Bell} verTodos="/app/ai/inbox" rotuloVerTodos={t("Central de avisos")}>
            <ListaDoBloco
              bloco={meuDia.avisos}
              rotulo="pedem a sua atenção"
              vazio="Nenhum aviso para você."
              comEscopo
              pendencia
              agrupar
            />
          </Cartao>
        </div>
      </section>

      {/* Só para gestor: o servidor manda `gestao` e a rota dos painéis exige manager. */}
      {gestao ? <PaineisDaClinica numerosDeHoje={gestao.numeros} /> : null}

      {gestao ? (
        <section aria-labelledby="inicio-gestao">
          <CabecalhoDaSecao id="inicio-gestao" titulo={t("Gestão")} descricao={t("O que impede o CRM de funcionar direito.")} />
          <div className="grid gap-4 lg:grid-cols-3">
            <Cartao titulo={t("Configuração pendente")}>
              <ListaDoBloco bloco={gestao.configuracao} rotulo="para resolver" vazio="Tudo configurado." comMotivo pendencia />
            </Cartao>
            <Cartao titulo={t("Gasto com IA no mês")} verTodos="/app/ai/usage" rotuloVerTodos={t("Abrir")}>
              {gestao.gastoIa?.ok ? (
                <p className="text-sm text-text-muted">
                  <b className="numero block text-3xl font-normal text-text">{dolares(gestao.gastoIa.consumidoCents)}</b>
                  {gestao.gastoIa.limiteCents != null
                    ? `${t("de")} ${dolares(gestao.gastoIa.limiteCents)}`
                    : t("sem limite configurado")}
                </p>
              ) : (
                <FalhaDoBloco />
              )}
            </Cartao>
            <Cartao titulo={t("Sistema")}>
              {saude.isLoading ? (
                <div role="status" aria-label={t("Carregando")} className="h-5 w-32 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
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
        </section>
      ) : null}
    </div>
  );
}
