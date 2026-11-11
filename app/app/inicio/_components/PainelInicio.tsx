"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Bell, CalendarDays, CircleCheck, ListChecks, MessageCircle } from "lucide-react";

import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import {
  DIAS_DE_ESPERA_RECENTE,
  type Avisos,
  type Bloco,
  type Esperando,
  type Pendencias,
  type TipoDePendencia,
} from "@/lib/inicio/tipos";
import { PaineisDaClinica, type NumerosDeHoje } from "./PaineisDaClinica";
import { Barra, CabecalhoDaSecao, Cartao, Esqueleto, FOCO, haQuanto } from "./partes";

type Gasto =
  | { ok: true; consumidoCents: number; limiteCents: number | null }
  | { ok: false };
type Resposta = {
  meuDia: { avisos: Avisos; esperando: Esperando; agenda: Bloco; tarefas: Bloco };
  gestao: null | { configuracao: Pendencias; numeros: NumerosDeHoje; gastoIa: Gasto };
};

/** O `tipo` de cada grupo de pendências é um código; aqui vira o nome do grupo e o do resumo. */
const PENDENCIA: Record<TipoDePendencia, string> = {
  canal_fora: "WhatsApp fora do ar",
  sem_responsavel: "Atendimentos sem responsável na agenda",
  convite_vencido: "Convites vencidos",
  agente_rascunho: "Agentes de IA em rascunho",
};
const PENDENCIA_CURTA: Record<TipoDePendencia, string> = {
  canal_fora: "WhatsApp fora",
  sem_responsavel: "Agenda sem responsável",
  convite_vencido: "Convites vencidos",
  agente_rascunho: "Agentes em rascunho",
};
/** Onde se resolve o resto do grupo, quando a lista não mostra todos. */
const ONDE_RESOLVER: Record<TipoDePendencia, string> = {
  canal_fora: "/app/connections",
  sem_responsavel: "/app/agenda",
  convite_vencido: "/app/team",
  agente_rascunho: "/app/ai/agents",
};

/** Centavos de DÓLAR (o custo de IA é calculado em USD — ver BudgetCard). */
function dolares(cents: number) {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "USD" });
}

const LINHA = `-mx-2 flex min-h-11 items-center justify-between gap-3 rounded-md px-2 py-2 text-sm hover:bg-row-hover ${FOCO}`;

function FalhaDoBloco() {
  const t = useT();
  return (
    <p role="alert" className="text-sm text-error">
      {t("Não consegui carregar este bloco.")}
    </p>
  );
}

/** Vazio com frase própria de cada bloco: "nada aqui" diz menos que "ninguém esperando resposta". */
function Vazio({ texto }: { texto: string }) {
  return (
    <p className="flex items-center gap-2 py-2 text-sm text-success-fg">
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
function Total({ valor, rotulo, pendencia }: { valor: number; rotulo: string; pendencia?: boolean }) {
  return (
    <p className="mb-2 flex items-baseline gap-2">
      <span className={`numero-destaque ${pendencia ? "text-warning-fg" : "text-text"}`}>{valor}</span>
      <span className="text-sm text-text-muted">{rotulo}</span>
    </p>
  );
}

function Abrir() {
  const t = useT();
  return <span className="shrink-0 text-xs font-medium text-accent">{t("Abrir")} →</span>;
}

function ListaDoBloco({ bloco, vazio, rotulo }: { bloco: Bloco; vazio: string; rotulo: string }) {
  const t = useT();
  if (!bloco.ok) return <FalhaDoBloco />;
  if (bloco.total === 0) return <Vazio texto={t(vazio)} />;
  return (
    <>
      <Total valor={bloco.total} rotulo={t(rotulo)} />
      <ul className="divide-y divide-border">
        {bloco.itens.map((i) => (
          <li key={i.id}>
            {/* Alvo de toque generoso: a recepção usa isto no celular. */}
            <Link className={LINHA} href={i.href}>
              <span className="line-clamp-2 min-w-0 break-words text-text">
                {i.detalhe ? `${i.detalhe} · ` : ""}
                {i.titulo}
              </span>
              <Abrir />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Quem espera resposta de quem está logado. O número grande são as esperas
 * RECENTES (com a pessoa + sem responsável); as antigas ficam à parte, apagadas,
 * porque "210 esperando" com 113 esquecidas há semanas não diz o que fazer hoje.
 */
function EsperandoResposta({ e }: { e: Esperando }) {
  const t = useT();
  if (!e.ok) return <FalhaDoBloco />;
  const dias = String(DIAS_DE_ESPERA_RECENTE);
  return (
    <>
      {e.total === 0 ? (
        <Vazio texto={t("Ninguém esperando resposta.")} />
      ) : (
        <Total valor={e.total} rotulo={t("esperando há até {{n}} dias").replace("{{n}}", dias)} pendencia />
      )}
      <dl className="space-y-1 text-sm">
        {e.total > 0 ? (
          <div className="flex justify-between gap-3">
            <dt>{t("Com você")}</dt>
            <dd className="numero">{e.comVoce}</dd>
          </div>
        ) : null}
        {/* Quem não pode abrir conversa sem responsável não vê um zero que engana. */}
        {e.total > 0 && e.veSemResponsavel ? (
          <div className="flex justify-between gap-3">
            <dt>{t("Sem responsável")}</dt>
            <dd className="numero">{e.semResponsavel}</dd>
          </div>
        ) : null}
        {e.antigas > 0 ? (
          <div className="flex justify-between gap-3 text-text-muted">
            <dt>{t("Conversas antigas sem resposta (mais de {{n}} dias)").replace("{{n}}", dias)}</dt>
            <dd className="numero font-normal">{e.antigas}</dd>
          </div>
        ) : null}
      </dl>
      {e.itens.length ? (
        <ul className="mt-2 divide-y divide-border border-t border-border">
          {e.itens.map((i) => (
            <li key={i.id}>
              <Link className={LINHA} href={i.href}>
                <span className="min-w-0 text-text">
                  <span className="line-clamp-1 break-words">{i.titulo}</span>
                  <span className="block text-xs text-text-muted">{haQuanto(i.desde, t)}</span>
                </span>
                <Abrir />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** Avisos por assunto: "139 avisos" não diz nada; "50 atendimentos parados" diz. */
function AvisosPorAssunto({ a }: { a: Avisos }) {
  const t = useT();
  if (!a.ok) return <FalhaDoBloco />;
  if (a.total === 0) return <Vazio texto={t("Nenhum aviso para você.")} />;
  const linhas = [
    ...a.grupos.map((g) => ({ chave: g.kind, rotulo: t(g.rotulo), total: g.total })),
    ...(a.outros > 0 ? [{ chave: "outros", rotulo: t("Outros avisos do sistema"), total: a.outros }] : []),
  ];
  return (
    <>
      <Total valor={a.total} rotulo={t("pedem a sua atenção")} pendencia />
      <ul className="divide-y divide-border">
        {linhas.map((l) => (
          <li key={l.chave}>
            {/* A Central não filtra por assunto na URL: a linha abre a Central inteira. */}
            <Link className={LINHA} href="/app/ai/inbox">
              <span className="flex min-w-0 items-baseline gap-3 text-text">
                <span className="numero w-8 shrink-0 text-right text-base">{l.total}</span>
                <span className="min-w-0 break-words">{l.rotulo}</span>
              </span>
              <Abrir />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function Sistema({ carregando, saude }: { carregando: boolean; saude: { status: string; version?: string } | undefined }) {
  const t = useT();
  if (carregando)
    return <div role="status" aria-label={t("Carregando")} className="h-5 w-32 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />;
  const noAr = saude?.status === "healthy";
  return (
    <>
      {/* Bolinha + frase: a cor nunca é a única pista. */}
      <p role={noAr ? undefined : "alert"} className="flex items-center gap-2 text-sm">
        <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${noAr ? "bg-success" : "bg-error"}`} />
        {noAr ? t("Tudo no ar") : t("Algum serviço está fora do ar. Avise o suporte.")}
      </p>
      {saude?.version ? (
        <p className="mt-1 text-xs text-text-muted">
          {t("versão")} {saude.version}
        </p>
      ) : null}
    </>
  );
}

function GastoComIa({ g }: { g: Gasto }) {
  const t = useT();
  if (!g.ok) return <FalhaDoBloco />;
  if (g.limiteCents == null)
    return (
      <p className="text-sm text-text-muted">
        <b className="numero block text-xl text-text">{dolares(g.consumidoCents)}</b>
        {t("sem limite configurado")}
      </p>
    );
  const pct = Math.round((g.consumidoCents / g.limiteCents) * 100);
  return (
    <>
      <p className="text-sm text-text-muted">
        <b className="numero text-xl text-text">{dolares(g.consumidoCents)}</b> {t("de")} {dolares(g.limiteCents)}
      </p>
      <Barra pct={pct} className="mt-2 h-1.5" />
      <p className="mt-1 text-xs text-text-muted">
        {t("{{n}}% do limite do mês").replace("{{n}}", String(pct))}
      </p>
    </>
  );
}

function ParaArrumar({ p }: { p: Pendencias }) {
  const t = useT();
  if (!p.ok) return <FalhaDoBloco />;
  if (p.total === 0) return <Vazio texto={t("Tudo configurado.")} />;
  return (
    <>
      <Total valor={p.total} rotulo={t("para resolver")} pendencia />
      <p className="text-xs text-text-muted">
        {p.grupos.map((g) => `${t(PENDENCIA_CURTA[g.tipo])}: ${g.total}`).join(" · ")}
      </p>
    </>
  );
}

/** A lista do que arrumar, por tipo, abaixo dos três quadros da Gestão. */
function ListaParaArrumar({ p }: { p: Pendencias }) {
  const t = useT();
  if (!p.ok || p.total === 0) return null;
  return (
    <Cartao titulo={t("O que arrumar, por tipo")} className="mt-4">
      <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
        {p.grupos.map((g) => (
          <div key={g.tipo} className="min-w-0">
            <h4 className="flex items-baseline justify-between gap-3 text-sm font-semibold text-text">
              <span>{t(PENDENCIA[g.tipo])}</span>
              <span className="numero text-warning-fg">{g.total}</span>
            </h4>
            <ul className="mt-1 divide-y divide-border">
              {g.itens.map((i) => (
                <li key={i.id}>
                  <Link className={LINHA} href={i.href}>
                    <span className="line-clamp-2 min-w-0 break-words text-text">{i.titulo}</span>
                    <Abrir />
                  </Link>
                </li>
              ))}
              {g.total > g.itens.length ? (
                <li>
                  <Link className={LINHA} href={ONDE_RESOLVER[g.tipo]}>
                    <span className="text-text-muted">
                      {t("e mais {{n}}").replace("{{n}}", String(g.total - g.itens.length))}
                    </span>
                    <Abrir />
                  </Link>
                </li>
              ) : null}
            </ul>
          </div>
        ))}
      </div>
    </Cartao>
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
          className={`mt-3 min-h-11 rounded-lg border px-3 text-sm font-medium hover:bg-row-hover ${FOCO}`}
        >
          {t("Tentar de novo")}
        </button>
      </div>
    );
  const { meuDia, gestao } = painel.data;
  // Sem tarefa, o quadro não ocupa um quarto da tela para dizer "nenhuma": vira uma linha.
  const semTarefas = meuDia.tarefas.ok && meuDia.tarefas.total === 0;

  return (
    <div className="space-y-10">
      <section aria-labelledby="inicio-meu-dia">
        <CabecalhoDaSecao
          id="inicio-meu-dia"
          titulo={t("Meu dia")}
          descricao={
            gestao
              ? t("O que precisa de você hoje, mais o que ninguém assumiu na clínica.")
              : t("O que precisa de você hoje: conversas, agenda, tarefas e avisos.")
          }
        />
        <div className="grid gap-4 md:grid-cols-2">
          <Cartao titulo={t("Pacientes esperando resposta")} icone={MessageCircle} verTodos="/app/inbox">
            <EsperandoResposta e={meuDia.esperando} />
          </Cartao>
          <Cartao titulo={t("Minha agenda de hoje")} icone={CalendarDays} verTodos="/app/agenda">
            <ListaDoBloco bloco={meuDia.agenda} rotulo="compromissos hoje" vazio="Nenhum compromisso seu hoje." />
          </Cartao>
          <Cartao
            titulo={t("Avisos, separados por assunto")}
            icone={Bell}
            verTodos="/app/ai/inbox"
            rotuloVerTodos={t("Central de avisos")}
            className={semTarefas ? "md:col-span-2" : ""}
          >
            <AvisosPorAssunto a={meuDia.avisos} />
          </Cartao>
          {semTarefas ? null : (
            <Cartao titulo={t("Minhas tarefas")} icone={ListChecks} verTodos="/app/tasks">
              <ListaDoBloco bloco={meuDia.tarefas} rotulo="para hoje ou atrasadas" vazio="Nenhuma tarefa sua para hoje." />
            </Cartao>
          )}
        </div>
        {semTarefas ? (
          <p className="mt-3 flex flex-wrap items-center gap-x-2 text-sm text-text-muted">
            <ListChecks aria-hidden className="size-4 shrink-0" />
            {t("Nenhuma tarefa sua para hoje.")}
            <Link
              className={`inline-flex items-center rounded-md text-accent underline-offset-4 hover:underline max-lg:min-h-11 toque:min-h-11 ${FOCO}`}
              href="/app/tasks"
            >
              {t("Ver tarefas")}
            </Link>
          </p>
        ) : null}
      </section>

      {/* Só para gestor: o servidor manda `gestao` e a rota dos painéis exige manager. */}
      {gestao ? <PaineisDaClinica numerosDeHoje={gestao.numeros} /> : null}

      {gestao ? (
        <section aria-labelledby="inicio-gestao">
          <CabecalhoDaSecao id="inicio-gestao" titulo={t("Gestão")} descricao={t("O que impede o CRM de funcionar direito.")} />
          <div className="grid gap-4 md:grid-cols-3">
            <Cartao titulo={t("Sistema")}>
              <Sistema carregando={saude.isLoading} saude={saude.data} />
            </Cartao>
            <Cartao titulo={t("Gasto com IA no mês")} verTodos="/app/ai/usage" rotuloVerTodos={t("Abrir")}>
              <GastoComIa g={gestao.gastoIa} />
            </Cartao>
            <Cartao titulo={t("Para arrumar")}>
              <ParaArrumar p={gestao.configuracao} />
            </Cartao>
          </div>
          <ListaParaArrumar p={gestao.configuracao} />
        </section>
      ) : null}
    </div>
  );
}
