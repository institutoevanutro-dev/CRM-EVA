"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { CalendarDays, Filter, MessagesSquare, UserRound, Users } from "lucide-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import type { FaixasDeAtendimento, Origem } from "@/lib/inicio/paineis";
import { DIAS_DE_ESPERA_RECENTE } from "@/lib/inicio/tipos";
import { Barra, CabecalhoDaSecao, Cartao, Esqueleto, FOCO } from "./partes";

/**
 * "Visão da clínica" no Início — só para gestor (a rota responde 403 aos demais).
 * Três blocos, e o título de cada um diz o período: hoje, últimos 30 dias, o mês.
 * Specs: docs/superpowers/specs/2026-10-07-inicio-paineis-design.md e
 * 2026-11-11-inicio-claro.md
 */
type Falha = { ok: false };
type Atendimento =
  | ({ ok: true; deCadaDez: FaixasDeAtendimento | null; medianaPrimeiraRespostaS: number | null } & FaixasDeAtendimento)
  | Falha;
type Esperando = { ok: true; recentes: number; semResponsavel: number; antigas: number } | Falha;
type Unidade = {
  unit_id: string | null;
  unidade: string | null;
  marcadas: number;
  confirmadas: number;
  realizadas: number;
  faltas: number;
  canceladas: number;
  comparecimento: number | null;
};
type Agenda = { ok: true; de: string; ate: string; unidades: Unidade[] } | Falha;
type Funil =
  | { ok: true; semFunil: true; funis: Array<{ id: string; nome: string }> }
  | {
      ok: true;
      semFunil?: undefined;
      funilId: string;
      funis: Array<{ id: string; nome: string }>;
      etapas: Array<{ id: string; nome: string; abertos: number }>;
    }
  | Falha;
type OrigemItem = { origem: Origem; rotulo: string; total: number; detalhes: Array<{ utm: string; total: number }> };
type OrigemPainel = { ok: true; itens: OrigemItem[] } | Falha;
type Profissional = {
  user_id: string | null;
  nome: string | null;
  hoje: number;
  semana: number;
  realizadas: number;
  faltas: number;
  canceladas: number;
  minutos: number;
};
type Vendas = { novos_mes: number; novos_anterior: number; ganhos_mes: number; perdidos_mes: number; valor: Record<string, string> };
type Resumo = { ok: true; profissionais: Profissional[]; vendas: Vendas } | Falha;
type Resposta = {
  periodo: { mes: string; mesAnterior: string };
  resumo: Resumo;
  atendimento: Atendimento;
  esperando: Esperando;
  agenda: Agenda;
  funil: Funil;
  origem: OrigemPainel;
};

/** "Números de hoje" de /api/v1/inicio (gestão): entram no bloco "A clínica hoje". */
export type NumerosDeHoje =
  | { ok: true; numeros: { conversasComPaciente: number; agendamentosCriados: number; leadsGanhos: number } }
  | { ok: false }
  | null;

// Dourado para a equipe, verde da marca para a IA e erro (com hachura) para quem
// ficou sem resposta: é a faixa que pede ação. Os `--grafico-*` mudam no escuro
// (globals.css); a IA usa `accent-strong`, que segue a cor da marca da instalação.
const CORES = {
  equipe: "var(--grafico-equipe)",
  ia: "var(--color-accent-strong)",
  semResposta: "var(--grafico-sem-resposta)",
};
/** A hachura faz "sem resposta" se distinguir sem depender da cor. */
const hachura = (cor: string) =>
  `repeating-linear-gradient(45deg, ${cor} 0 3px, color-mix(in srgb, ${cor} 55%, var(--color-surface)) 3px 5px)`;
const TRACO = "—";
/**
 * A frase do atendimento, com o fim certo para cada caso: "1 ficaram" não é
 * português, e "0 ficaram" seria mentira quando alguma ficou (menos de 5% das
 * conversas arredonda para zero em dez).
 */
const DE_CADA_10 = {
  varias: "De cada 10 conversas novas, a equipe atendeu {{equipe}}, a IA resolveu {{ia}} sozinha e {{semResposta}} ficaram sem resposta.",
  uma: "De cada 10 conversas novas, a equipe atendeu {{equipe}}, a IA resolveu {{ia}} sozinha e 1 ficou sem resposta.",
  menosDeUma: "De cada 10 conversas novas, a equipe atendeu {{equipe}}, a IA resolveu {{ia}} sozinha e menos de 1 ficou sem resposta.",
  nenhuma: "De cada 10 conversas novas, a equipe atendeu {{equipe}}, a IA resolveu {{ia}} sozinha e nenhuma ficou sem resposta.",
} as const;

/**
 * No celular a tabela vira lista: cada linha é um bloco com o nome em cima, e
 * cada número leva o nome da coluna na frente (`data-rotulo`). Nada rola para o
 * lado — nem a página, nem a tabela dentro do cartão.
 */
const LINHA = "max-sm:block max-sm:py-2.5";
const NOME_DA_LINHA = "px-1 py-2.5 text-left font-medium max-sm:block max-sm:py-0";
const CELULA =
  "px-1 py-2.5 max-sm:inline-block max-sm:py-0.5 max-sm:pr-4 max-sm:text-left max-sm:before:mr-1.5 max-sm:before:text-xs max-sm:before:font-normal max-sm:before:tracking-normal max-sm:before:text-text-muted max-sm:before:content-[attr(data-rotulo)]";

function Falhou() {
  const t = useT();
  return (
    <p role="alert" className="text-sm">
      {t("Não foi possível carregar este painel.")}
    </p>
  );
}

function Vazio({ texto }: { texto: string }) {
  const t = useT();
  return <p className="py-6 text-center text-sm text-text-muted">{t(texto)}</p>;
}

/** "na hora", "4 min", "2 h 30 min": a duração dita como gente diz. */
function ateQuando(segundos: number, t: (s: string) => string): string {
  if (segundos < 60) return t("na hora");
  const min = Math.round(segundos / 60);
  if (min < 60) return t("em até {{n}} min").replace("{{n}}", String(min));
  const h = Math.floor(min / 60);
  const resto = min % 60;
  return t("em até {{n}}").replace("{{n}}", resto ? `${h} h ${resto} min` : `${h} h`);
}

function dinheiro(valor: Record<string, string>) {
  const moedas = Object.entries(valor);
  if (!moedas.length) return "R$ 0,00";
  return moedas
    .map(([moeda, cents]) =>
      (Number(cents) / 100).toLocaleString("pt-BR", { style: "currency", currency: moeda }),
    )
    .join(" + ");
}

function pct(parte: number, todo: number): number | null {
  return todo > 0 ? Math.round((parte / todo) * 100) : null;
}

function horas(minutos: number): string {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return h ? (m ? `${h} h ${m}` : `${h} h`) : `${m} min`;
}

/** "novembro", no idioma de quem lê, a partir do primeiro dia do mês (`YYYY-MM-DD`). */
function useNomeDoMes(): (primeiroDia: string | undefined) => string {
  const tag = useTagDeIdioma();
  return (primeiroDia) =>
    primeiroDia
      ? new Intl.DateTimeFormat(tag, { month: "long", timeZone: "UTC" }).format(new Date(`${primeiroDia}T00:00:00Z`))
      : "";
}

/** Um bloco da Visão: título que diz o período, e o conteúdo embaixo, na largura toda. */
function Bloco({ id, titulo, children }: { id: string; titulo: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-4">
      <h3 id={id} className="rotulo-secao border-b border-border pb-2 text-text-muted">
        {titulo}
      </h3>
      {children}
    </section>
  );
}

/** Um indicador: o que ele conta, o número grande e, se houver, a comparação. */
function Indicador({ rotulo, valor, extra }: { rotulo: string; valor: string; extra?: ReactNode }) {
  return (
    // No celular o indicador é uma linha (o que conta à esquerda, o número à direita).
    <div className="flex min-w-0 flex-col rounded-2xl border bg-surface p-4 shadow-sm max-sm:flex-row max-sm:flex-wrap max-sm:items-baseline max-sm:justify-between max-sm:gap-x-3">
      <dt className="text-sm text-text-muted">{rotulo}</dt>
      <dd className="numero-destaque mt-1 text-text max-sm:mt-0">{valor}</dd>
      {extra ? <dd className="mt-1 text-xs text-text-muted max-sm:basis-full">{extra}</dd> : null}
    </div>
  );
}

function PainelProfissionais({ p }: { p: Resumo }) {
  const t = useT();
  if (!p.ok) return <Falhou />;
  if (!p.profissionais.length) return <Vazio texto="Nenhuma consulta nesta semana." />;
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{t("Agenda por profissional nesta semana")}</caption>
      <thead className="max-sm:hidden">
        <tr className="text-xs text-text-muted">
          <th scope="col" className="px-1 pb-2 text-left font-normal">{t("Profissional")}</th>
          <th scope="col" className="px-1 pb-2 text-right font-normal">{t("Hoje")}</th>
          <th scope="col" className="px-1 pb-2 text-right font-normal">{t("Semana")}</th>
          <th scope="col" className="px-1 pb-2 text-right font-normal">{t("Horas marcadas")}</th>
          <th scope="col" className="px-1 pb-2 text-right font-normal">{t("Faltas")}</th>
          <th scope="col" className="px-1 pb-2 text-left font-normal">{t("Comparecimento")}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {p.profissionais.map((u) => {
          const c = pct(u.realizadas, u.realizadas + u.faltas);
          return (
            <tr key={u.user_id ?? "sem"} className={LINHA}>
              <th scope="row" className={`${NOME_DA_LINHA} sm:max-w-[14rem] sm:truncate`}>
                {u.user_id ? (u.nome ?? t("Profissional")) : t("Sem profissional")}
              </th>
              <td data-rotulo={t("Hoje")} className={`numero text-right ${CELULA}`}>{u.hoje}</td>
              <td data-rotulo={t("Semana")} className={`numero text-right ${CELULA}`}>{u.semana}</td>
              <td data-rotulo={t("Horas marcadas")} className={`numero whitespace-nowrap text-right ${CELULA}`}>{horas(u.minutos)}</td>
              <td data-rotulo={t("Faltas")} className={`numero text-right ${CELULA}`}>{u.faltas}</td>
              <td data-rotulo={t("Comparecimento")} className={CELULA}>
                <span className="inline-flex items-center gap-2">
                  <Barra pct={c ?? 0} className="h-1.5 w-16" />
                  <span className="numero">{c != null ? `${c}%` : TRACO}</span>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PainelAgenda({ p }: { p: Agenda }) {
  const t = useT();
  if (!p.ok) return <Falhou />;
  if (!p.unidades.length) return <Vazio texto="Nenhuma consulta nesta semana." />;
  const colunas = [
    ["Marcadas", "marcadas"],
    ["Confirmadas", "confirmadas"],
    ["Realizadas", "realizadas"],
    ["Faltas", "faltas"],
    ["Canceladas", "canceladas"],
  ] as const;
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{t("Agenda por unidade nesta semana")}</caption>
      <thead className="max-sm:hidden">
        <tr className="text-xs text-text-muted">
          <th scope="col" className="px-1 pb-2 text-left font-normal">{t("Unidade")}</th>
          {colunas.map(([rotulo]) => (
            <th key={rotulo} scope="col" className="px-1 pb-2 text-right font-normal">{t(rotulo)}</th>
          ))}
          <th scope="col" className="px-1 pb-2 text-left font-normal">{t("Comparecimento")}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {p.unidades.map((u) => {
          const c = u.comparecimento != null ? Math.round(u.comparecimento * 100) : null;
          return (
            <tr key={u.unit_id ?? "sem"} className={LINHA}>
              <th scope="row" className={`${NOME_DA_LINHA} sm:whitespace-nowrap`}>{u.unidade ?? t("Sem unidade")}</th>
              {colunas.map(([rotulo, campo]) => (
                <td key={rotulo} data-rotulo={t(rotulo)} className={`numero text-right ${CELULA}`}>{u[campo]}</td>
              ))}
              <td data-rotulo={t("Comparecimento")} className={CELULA}>
                <span className="inline-flex items-center gap-2">
                  <Barra pct={c ?? 0} className="h-1.5 w-16" />
                  <span className="numero">{c != null ? `${c}%` : TRACO}</span>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Atendimento em 30 dias, em três frases: de cada 10 conversas novas, quem
 * atendeu; em quanto tempo sai a primeira resposta (MEDIANA — a média de
 * "10 h 58 m" era puxada por poucas conversas esquecidas); e quem espera agora.
 */
function PainelAtendimento({ a, e }: { a: Atendimento; e: Esperando }) {
  const t = useT();
  if (!a.ok) return <Falhou />;
  const total = a.equipe + a.ia + a.semResposta;
  const faixas = [
    { chave: "equipe", rotulo: t("Atendidas pela equipe"), n: a.equipe, fundo: CORES.equipe },
    { chave: "ia", rotulo: t("Resolvidas pela IA sozinha"), n: a.ia, fundo: CORES.ia },
    { chave: "sem", rotulo: t("Sem resposta"), n: a.semResposta, fundo: hachura(CORES.semResposta), href: "/app/radar" },
  ];
  const dias = String(DIAS_DE_ESPERA_RECENTE);
  return (
    <div className="space-y-5">
      {a.deCadaDez ? (
        <>
          <p className="max-w-3xl text-base text-text">
            {t(DE_CADA_10[a.deCadaDez.semResposta > 1 ? "varias" : a.deCadaDez.semResposta === 1 ? "uma" : a.semResposta > 0 ? "menosDeUma" : "nenhuma"])
              .replace("{{equipe}}", String(a.deCadaDez.equipe))
              .replace("{{ia}}", String(a.deCadaDez.ia))
              .replace("{{semResposta}}", String(a.deCadaDez.semResposta))}
          </p>
          <div>
            {/* UMA barra: a proporção das três faixas. Os números estão na legenda. */}
            <div aria-hidden className="flex h-3 gap-px overflow-hidden rounded-full bg-border">
              {faixas
                .filter((f) => f.n > 0)
                .map((f) => (
                  <span key={f.chave} className="h-full" style={{ flexGrow: f.n, flexBasis: 0, background: f.fundo }} />
                ))}
            </div>
            <ul className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
              {faixas.map((f) => {
                const texto = (
                  <>
                    <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-sm" style={{ background: f.fundo }} />
                    <span className="numero">{f.n}</span>
                    <span className="text-text-muted">{f.rotulo}</span>
                  </>
                );
                return (
                  <li key={f.chave}>
                    {f.href && f.n > 0 ? (
                      // O paciente sem retorno precisa de número e de porta, não só de cor.
                      <Link className={`flex min-h-11 items-center gap-1.5 rounded-md underline-offset-4 hover:underline lg:min-h-0 toque:min-h-11 ${FOCO}`} href={f.href}>
                        {texto}
                      </Link>
                    ) : (
                      <span className="flex items-center gap-1.5">{texto}</span>
                    )}
                  </li>
                );
              })}
              <li className="text-text-muted">
                {t("{{n}} conversas novas no total").replace("{{n}}", String(total))}
              </li>
            </ul>
          </div>
        </>
      ) : (
        <Vazio texto="Nenhuma conversa nova nos últimos 30 dias." />
      )}
      <dl className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-text-muted">{t("Tempo até a primeira resposta")}</dt>
          <dd className="mt-1 text-base text-text">
            {a.medianaPrimeiraRespostaS != null
              ? t("Metade das conversas recebe resposta {{prazo}}.").replace("{{prazo}}", ateQuando(a.medianaPrimeiraRespostaS, t))
              : TRACO}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-text-muted">{t("Esperando resposta agora")}</dt>
          {e.ok ? (
            <>
              <dd className="mt-1 flex flex-wrap items-baseline gap-x-2">
                <span className={`numero-destaque ${e.recentes ? "text-warning-fg" : "text-text"}`}>{e.recentes}</span>
                <span className="text-sm text-text-muted">
                  {t("há até {{n}} dias").replace("{{n}}", dias)}
                  {e.recentes ? ` · ${t("{{n}} sem responsável").replace("{{n}}", String(e.semResponsavel))}` : ""}
                </span>
              </dd>
              {e.antigas ? (
                <dd className="mt-1 text-sm text-text-muted">
                  {t("{{n}} conversas antigas sem resposta (mais de {{dias}} dias)")
                    .replace("{{n}}", String(e.antigas))
                    .replace("{{dias}}", dias)}
                </dd>
              ) : null}
            </>
          ) : (
            <dd className="mt-1">
              <Falhou />
            </dd>
          )}
        </div>
      </dl>
    </div>
  );
}

/** ▲/▼ + texto: a cor nunca é a única pista. Compara com os MESMOS DIAS do mês anterior. */
function Variacao({ atual, anterior, mesAnterior }: { atual: number; anterior: number; mesAnterior: string }) {
  const t = useT();
  if (atual === anterior) return <>{t("igual aos mesmos dias de {{mes}}").replace("{{mes}}", mesAnterior)}</>;
  const subiu = atual > anterior;
  return (
    <>
      <span className={subiu ? "text-success-fg" : "text-error-fg"}>
        {subiu ? "▲" : "▼"} {Math.abs(atual - anterior)}
      </span>{" "}
      {(subiu ? t("a mais que nos mesmos dias de {{mes}}") : t("a menos que nos mesmos dias de {{mes}}")).replace("{{mes}}", mesAnterior)}
    </>
  );
}

function PainelEtapas({ p, onTrocar }: { p: Funil; onTrocar: (id: string) => void }) {
  const t = useT();
  if (!p.ok) return <Falhou />;
  if (p.semFunil) return <Vazio texto="Nenhum funil ativo." />;
  const maior = Math.max(1, ...p.etapas.map((e) => e.abertos));
  return (
    <>
      {/* Seleção em cima, conteúdo embaixo. */}
      {p.funis.length > 1 ? (
        <select
          aria-label={t("Funil")}
          className={`mb-3 h-11 w-full rounded-lg border border-border-input bg-surface px-2 text-sm lg:h-10 toque:h-11 ${FOCO}`}
          value={p.funilId}
          onChange={(e) => onTrocar(e.target.value)}
        >
          {p.funis.map((f) => (
            <option key={f.id} value={f.id}>
              {f.nome}
            </option>
          ))}
        </select>
      ) : null}
      {p.etapas.length ? (
        <ol className="space-y-2">
          {p.etapas.map((e, i) => (
            <li key={e.id} className="grid grid-cols-[1.25rem_minmax(0,1fr)_2.5rem] items-center gap-x-2 gap-y-1 text-sm sm:grid-cols-[1.25rem_minmax(0,13rem)_1fr_2.5rem]">
              <span aria-hidden className="numero text-xs text-text-muted">{i + 1}</span>
              {/* O nome da etapa vem do banco: sai como a clínica cadastrou. */}
              <span className="leading-tight text-text">{e.nome}</span>
              <Barra pct={(e.abertos / maior) * 100} className="col-span-2 col-start-2 row-start-2 sm:col-span-1 sm:col-start-3 sm:row-start-1" />
              <span className="numero col-start-3 row-start-1 text-right sm:col-start-4">{e.abertos}</span>
            </li>
          ))}
        </ol>
      ) : (
        <Vazio texto="Nenhum paciente em aberto neste funil." />
      )}
    </>
  );
}

function PainelOrigem({ p }: { p: OrigemPainel }) {
  const t = useT();
  if (!p.ok) return <Falhou />;
  if (!p.itens.length) return <Vazio texto="Nenhum contato novo neste mês." />;
  const maior = Math.max(...p.itens.map((i) => i.total));
  return (
    <ul className="space-y-2">
      {p.itens.map((i) => (
        <li key={i.origem} className="text-sm">
          <div className="mb-1 flex justify-between gap-2">
            <span>{t(i.rotulo)}</span>
            <span className="numero">{i.total}</span>
          </div>
          <Barra pct={(i.total / maior) * 100} />
          {i.detalhes.length ? (
            <p className="mt-1 text-xs text-text-muted">{i.detalhes.map((d) => `${d.utm} (${d.total})`).join(" · ")}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function PaineisDaClinica({ numerosDeHoje = null }: { numerosDeHoje?: NumerosDeHoje }) {
  const t = useT();
  const nomeDoMes = useNomeDoMes();
  const [funil, setFunil] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["inicio-paineis", funil],
    queryFn: async () =>
      (
        await apiClient.get<{ data: Resposta }>(
          `/api/v1/inicio/paineis${funil ? `?funil=${encodeURIComponent(funil)}` : ""}`,
        )
      ).data,
    refetchOnWindowFocus: true,
    // Agregados de 30 dias não mudam a cada foco; trocar de funil mantém os cards na tela.
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  const d = q.data;
  const resumo = d?.resumo.ok ? d.resumo : null;
  const hoje = numerosDeHoje?.ok ? numerosDeHoje.numeros : null;
  const mes = nomeDoMes(d?.periodo.mes);
  const mesAnterior = nomeDoMes(d?.periodo.mesAnterior);
  const f = d?.funil;
  const funilAtual = f?.ok && !f.semFunil ? f.funis.find((x) => x.id === f.funilId) : null;

  return (
    <section aria-labelledby="inicio-visao">
      <CabecalhoDaSecao
        id="inicio-visao"
        titulo={t("Visão da clínica")}
        descricao={t("Como a clínica está indo: agenda, atendimento e vendas. Só gerente e admin veem.")}
      />
      {q.isLoading ? (
        <div className="space-y-4">
          <Esqueleto quantos={3} altura="h-24" colunas="sm:grid-cols-3" />
          <Esqueleto quantos={2} altura="h-64" colunas="grid-cols-1" />
        </div>
      ) : q.isError || !d ? (
        <p role="alert" className="rounded-2xl border bg-surface p-5 text-sm">
          {t("Não foi possível carregar os painéis. Tente novamente.")}
        </p>
      ) : (
        <div className="space-y-8">
          <Bloco id="inicio-visao-hoje" titulo={t("A clínica hoje")}>
            <dl className="grid gap-3 sm:grid-cols-3">
              <Indicador
                rotulo={t("Consultas hoje")}
                valor={resumo ? String(resumo.profissionais.reduce((s, p) => s + p.hoje, 0)) : TRACO}
              />
              <Indicador rotulo={t("Pacientes que escreveram hoje")} valor={hoje ? String(hoje.conversasComPaciente) : TRACO} />
              <Indicador rotulo={t("Agendamentos feitos hoje")} valor={hoje ? String(hoje.agendamentosCriados) : TRACO} />
            </dl>
            <Cartao tituloComo="h4" titulo={t("Agenda por profissional · semana")} icone={UserRound} verTodos="/app/agenda" rotuloVerTodos={t("Abrir")}>
              <PainelProfissionais p={d.resumo} />
            </Cartao>
            <Cartao tituloComo="h4" titulo={t("Agenda por unidade · semana")} icone={CalendarDays} verTodos="/app/agenda" rotuloVerTodos={t("Abrir")}>
              <PainelAgenda p={d.agenda} />
            </Cartao>
          </Bloco>

          <Bloco id="inicio-visao-atendimento" titulo={t("Atendimento · últimos 30 dias")}>
            <Cartao tituloComo="h4" titulo={t("Como as conversas novas foram atendidas")} icone={MessagesSquare} verTodos="/app/metrics" rotuloVerTodos={t("Abrir")}>
              <PainelAtendimento a={d.atendimento} e={d.esperando} />
            </Cartao>
          </Bloco>

          <Bloco id="inicio-visao-vendas" titulo={t("Vendas · {{mes}}, todos os funis").replace("{{mes}}", mes)}>
            <dl className="grid gap-3 sm:grid-cols-3">
              <Indicador
                rotulo={t("Pacientes novos")}
                valor={resumo ? String(resumo.vendas.novos_mes) : TRACO}
                extra={
                  resumo ? (
                    <Variacao atual={resumo.vendas.novos_mes} anterior={resumo.vendas.novos_anterior} mesAnterior={mesAnterior} />
                  ) : null
                }
              />
              <Indicador
                rotulo={t("Vendas fechadas")}
                valor={resumo ? String(resumo.vendas.ganhos_mes) : TRACO}
                extra={resumo ? <span className="numero text-sm text-text">{dinheiro(resumo.vendas.valor)}</span> : null}
              />
              <Indicador rotulo={t("Desistiram")} valor={resumo ? String(resumo.vendas.perdidos_mes) : TRACO} />
            </dl>
            <div className="grid gap-4 lg:grid-cols-2">
              <Cartao
                tituloComo="h4"
                titulo={funilAtual ? `${t("Onde os pacientes estão agora")} · ${funilAtual.nome}` : t("Onde os pacientes estão agora")}
                icone={Filter}
                verTodos="/app/kanban"
                rotuloVerTodos={t("Abrir")}
              >
                <PainelEtapas p={d.funil} onTrocar={setFunil} />
              </Cartao>
              <Cartao tituloComo="h4" titulo={t("Origem dos pacientes · mês")} icone={Users} verTodos="/app/contacts" rotuloVerTodos={t("Abrir")}>
                <PainelOrigem p={d.origem} />
              </Cartao>
            </div>
          </Bloco>
        </div>
      )}
    </section>
  );
}
