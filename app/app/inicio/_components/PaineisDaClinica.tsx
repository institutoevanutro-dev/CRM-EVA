"use client";
import { useState, type ReactNode } from "react";
import { CalendarDays, Filter, MessagesSquare, UserRound, Users } from "lucide-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import type { DiaDeConversas, Origem } from "@/lib/inicio/paineis";
import { CabecalhoDaSecao, Cartao, Esqueleto } from "./partes";

/**
 * "Visão da clínica" no Início — só para gestor (a rota responde 403 aos demais).
 * Spec: docs/superpowers/specs/2026-10-07-inicio-paineis-design.md
 */
type Falha = { ok: false };
type Conversas = { ok: true; dias: DiaDeConversas[]; primeiraRespostaMediaS: number | null } | Falha;
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
type Bloco = { ganhos: number; perdidos: number; valor: Record<string, string> };
type Funil =
  | { ok: true; semFunil: true; funis: Array<{ id: string; nome: string }> }
  | {
      ok: true;
      semFunil?: undefined;
      funilId: string;
      funis: Array<{ id: string; nome: string }>;
      etapas: Array<{ id: string; nome: string; abertos: number }>;
      mes: Bloco;
      anterior: Bloco;
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
type Resumo =
  | {
      ok: true;
      profissionais: Profissional[];
      esperando: { total: number; sem_responsavel: number; desde: string | null };
      leads: { novos_mes: number; novos_anterior: number; ganhos_mes: number; ganhos_anterior: number };
    }
  | Falha;
type Resposta = { resumo?: Resumo; conversas: Conversas; agenda: Agenda; funil: Funil; origem: OrigemPainel };

/** "Números de hoje" de /api/v1/inicio (gestão): entram na faixa de indicadores. */
export type NumerosDeHoje =
  | { ok: true; numeros: { conversasComPaciente: number; agendamentosCriados: number; leadsGanhos: number } }
  | { ok: false }
  | null;

// Verde da marca para a IA, dourado para a equipe e neutro para quem ficou sem resposta.
const CORES = {
  ia: "var(--color-accent-600)",
  equipe: "var(--color-gold)",
  semResposta: "var(--color-neutral-300)",
};

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

function duracao(segundos: number) {
  const min = Math.floor(segundos / 60);
  const s = Math.round(segundos % 60);
  if (min >= 60) return `${Math.floor(min / 60)} h ${min % 60} min`;
  return min > 0 ? `${min} min ${s} s` : `${s} s`;
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

function Variacao({ atual, anterior }: { atual: number; anterior: number }) {
  const t = useT();
  if (atual === anterior) return <span className="text-xs text-text-muted">{t("igual ao mês anterior")}</span>;
  const subiu = atual > anterior;
  // Seta + texto: a cor nunca é a única pista.
  return (
    <span className={`text-xs ${subiu ? "text-success" : "text-error"}`}>
      {subiu ? "▲" : "▼"} {Math.abs(atual - anterior)}{" "}
      <span className="text-text-muted">{subiu ? t("a mais que o mês anterior") : t("a menos que o mês anterior")}</span>
    </span>
  );
}

function pct(parte: number, todo: number): number | null {
  return todo > 0 ? Math.round((parte / todo) * 100) : null;
}

/** "há 3 h" desde um instante — a espera mais antiga. */
function haQuanto(iso: string, t: (s: string) => string): string {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (min < 60) return t("há {{n}} min").replace("{{n}}", String(min));
  const h = Math.round(min / 60);
  if (h < 48) return t("há {{n}} h").replace("{{n}}", String(h));
  return t("há {{n}} dias").replace("{{n}}", String(Math.round(h / 24)));
}

function horas(minutos: number): string {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return h ? (m ? `${h} h ${m}` : `${h} h`) : `${m} min`;
}

/** Um indicador: número grande, o que ele conta, e a janela — sempre explícita. */
function Indicador({
  rotulo,
  valor,
  janela,
  extra,
  alerta,
}: {
  rotulo: string;
  valor: string;
  janela: string;
  extra?: ReactNode;
  alerta?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-2xl border bg-surface p-4 shadow-sm">
      <dt className="text-sm text-text-muted">{rotulo}</dt>
      <dd className={`numero mt-1 text-3xl ${alerta ? "text-warning" : "text-text"}`}>{valor}</dd>
      <dd className="mt-1 text-xs text-text-muted">{janela}</dd>
      {extra ? <dd className="mt-1">{extra}</dd> : null}
    </div>
  );
}

function FaixaDeIndicadores({ resumo, conversas, hoje }: { resumo: Resumo | undefined; conversas: Conversas; hoje: NumerosDeHoje }) {
  const t = useT();
  const r = resumo?.ok ? resumo : null;
  const n = hoje?.ok ? hoje.numeros : null;
  const prof = r?.profissionais ?? [];
  const consultasHoje = prof.reduce((s, p) => s + p.hoje, 0);
  const realizadas = prof.reduce((s, p) => s + p.realizadas, 0);
  const faltas = prof.reduce((s, p) => s + p.faltas, 0);
  const comparecimento = pct(realizadas, realizadas + faltas);
  const totalConversas = conversas.ok
    ? conversas.dias.reduce((s, d) => s + d.ia_sozinha + d.com_equipe + d.sem_resposta, 0)
    : 0;
  const ia = conversas.ok ? pct(conversas.dias.reduce((s, d) => s + d.ia_sozinha, 0), totalConversas) : null;
  const traco = "—";
  return (
    <dl aria-label={t("Indicadores da clínica")} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Indicador
        rotulo={t("Esperando resposta")}
        valor={r ? String(r.esperando.total) : traco}
        janela={t("agora, a clínica toda")}
        alerta={Boolean(r?.esperando.total)}
        extra={
          r && r.esperando.total ? (
            <span className="text-xs text-text-muted">
              {r.esperando.sem_responsavel} {t("sem responsável")}
              {r.esperando.desde ? ` · ${t("a mais antiga")} ${haQuanto(r.esperando.desde, t)}` : ""}
            </span>
          ) : null
        }
      />
      <Indicador rotulo={t("Consultas hoje")} valor={r ? String(consultasHoje) : traco} janela={t("todos os profissionais")} />
      <Indicador
        rotulo={t("Comparecimento")}
        valor={comparecimento != null ? `${comparecimento}%` : traco}
        janela={t("nesta semana")}
        extra={r ? <span className="text-xs text-text-muted">{realizadas} {t("realizadas")} · {faltas} {t("faltas")}</span> : null}
      />
      <Indicador rotulo={t("IA resolveu sozinha")} valor={ia != null ? `${ia}%` : traco} janela={t("das conversas novas, 30 dias")} />
      <Indicador
        rotulo={t("Leads novos")}
        valor={r ? String(r.leads.novos_mes) : traco}
        janela={t("neste mês")}
        extra={r ? <Variacao atual={r.leads.novos_mes} anterior={r.leads.novos_anterior} /> : null}
      />
      <Indicador
        rotulo={t("Negócios ganhos")}
        valor={r ? String(r.leads.ganhos_mes) : traco}
        janela={t("neste mês, todos os funis")}
        extra={r ? <Variacao atual={r.leads.ganhos_mes} anterior={r.leads.ganhos_anterior} /> : null}
      />
      <Indicador rotulo={t("Agendamentos criados")} valor={n ? String(n.agendamentosCriados) : traco} janela={t("hoje")} />
      <Indicador rotulo={t("Conversas com pacientes")} valor={n ? String(n.conversasComPaciente) : traco} janela={t("hoje")} />
    </dl>
  );
}

function PainelProfissionais({ p }: { p: Resumo | undefined }) {
  const t = useT();
  if (!p || !p.ok) return <Falhou />;
  if (!p.profissionais.length) return <Vazio texto="Nenhuma consulta nesta semana." />;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[34rem] text-sm">
        <caption className="sr-only">{t("Agenda por profissional nesta semana")}</caption>
        <thead>
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
              <tr key={u.user_id ?? "sem"}>
                <th scope="row" className="max-w-[14rem] truncate px-1 py-2.5 text-left font-medium">
                  {u.user_id ? (u.nome ?? t("Profissional")) : t("Sem profissional")}
                </th>
                <td className="numero px-1 py-2.5 text-right">{u.hoje}</td>
                <td className="numero px-1 py-2.5 text-right">{u.semana}</td>
                <td className="numero whitespace-nowrap px-1 py-2.5 text-right">{horas(u.minutos)}</td>
                <td className="numero px-1 py-2.5 text-right">{u.faltas}</td>
                <td className="px-1 py-2.5">
                  <span className="flex items-center gap-2">
                    <span aria-hidden className="h-1.5 w-16 overflow-hidden rounded-full bg-border">
                      <span className="block h-full rounded-full bg-accent" style={{ width: `${c ?? 0}%` }} />
                    </span>
                    <span className="numero">{c != null ? `${c}%` : "—"}</span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PainelConversas({ p }: { p: Conversas }) {
  const t = useT();
  if (!p.ok) return <Falhou />;
  const total = p.dias.reduce((s, d) => s + d.ia_sozinha + d.com_equipe + d.sem_resposta, 0);
  if (!total) return <Vazio texto="Nenhuma conversa nova nos últimos 30 dias." />;
  const soma = (k: keyof Omit<DiaDeConversas, "dia">) => p.dias.reduce((s, d) => s + d[k], 0);
  const dados = p.dias.map((d) => ({ ...d, rotulo: d.dia.slice(8, 10) + "/" + d.dia.slice(5, 7) }));
  const iaSozinha = soma("ia_sozinha");
  const comEquipe = soma("com_equipe");
  const legenda = [
    { cor: CORES.ia, rotulo: t("IA sozinha") },
    { cor: CORES.equipe, rotulo: t("Com a equipe") },
    { cor: CORES.semResposta, rotulo: t("Sem resposta") },
  ];
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-4">
        <p>
          <span className="numero block whitespace-nowrap text-2xl text-text">{total}</span>
          <span className="text-text-muted">{t("conversas novas")}</span>
        </p>
        <p>
          <span className="numero block whitespace-nowrap text-2xl text-text">{iaSozinha}</span>
          <span className="text-text-muted">{t("a IA resolveu sozinha")}</span>
        </p>
        <p>
          <span className="numero block whitespace-nowrap text-2xl text-text">{comEquipe}</span>
          <span className="text-text-muted">{t("passaram para a equipe")}</span>
        </p>
        <p>
          <span className="numero block whitespace-nowrap text-2xl text-text">
            {p.primeiraRespostaMediaS != null ? duracao(p.primeiraRespostaMediaS) : "—"}
          </span>
          <span className="text-text-muted">{t("até a primeira resposta")}</span>
        </p>
      </div>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={dados} margin={{ top: 4, right: 0, bottom: 0, left: -28 }} barCategoryGap="28%">
            <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="rotulo"
              tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
              interval={4}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{ fill: "var(--color-row-hover)" }}
              contentStyle={{ borderRadius: 10, border: "1px solid var(--color-border)", background: "var(--color-surface)", fontSize: 12 }}
            />
            <Bar dataKey="ia_sozinha" name={t("IA sozinha")} stackId="c" isAnimationActive={false} fill={CORES.ia} />
            <Bar dataKey="com_equipe" name={t("Com a equipe")} stackId="c" isAnimationActive={false} fill={CORES.equipe} />
            <Bar dataKey="sem_resposta" name={t("Sem resposta")} stackId="c" isAnimationActive={false} fill={CORES.semResposta} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-2 flex flex-wrap gap-4 text-xs text-text-muted">
        {legenda.map(({ cor, rotulo }) => (
          <li key={rotulo} className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: cor }} />
            {rotulo}
          </li>
        ))}
      </ul>
    </>
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
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] text-text-muted">
            <th scope="col" className="px-1 pb-2 text-left font-normal">{t("Unidade")}</th>
            {colunas.map(([rotulo]) => (
              <th key={rotulo} className="px-1 pb-2 text-right font-normal">{t(rotulo)}</th>
            ))}
            <th className="px-1 pb-2 text-left font-normal">{t("Comparecimento")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {p.unidades.map((u) => {
            const pct = u.comparecimento != null ? Math.round(u.comparecimento * 100) : null;
            return (
              <tr key={u.unit_id ?? "sem"}>
                <td className="whitespace-nowrap px-1 py-2.5 font-medium">{u.unidade ?? t("Sem unidade")}</td>
                {colunas.map(([rotulo, campo]) => (
                  <td key={rotulo} className="numero px-1 py-2.5 text-right">{u[campo]}</td>
                ))}
                <td className="px-1 py-2.5">
                  <span className="flex items-center gap-2">
                    <span aria-hidden className="h-1.5 w-16 overflow-hidden rounded-full bg-border">
                      <span className="block h-full rounded-full bg-accent" style={{ width: `${pct ?? 0}%` }} />
                    </span>
                    <span className="numero">{pct != null ? `${pct}%` : "—"}</span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PainelFunil({ p, onTrocar }: { p: Funil; onTrocar: (id: string) => void }) {
  const t = useT();
  if (!p.ok) return <Falhou />;
  if (p.semFunil) return <Vazio texto="Nenhum funil ativo." />;
  const maior = Math.max(1, ...p.etapas.map((e) => e.abertos));
  return (
    <>
      {p.funis.length > 1 ? (
        <select
          aria-label={t("Funil")}
          className="mb-3 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm"
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
      <div className="mb-4 grid grid-cols-3 gap-3 text-sm">
        <p>
          <span className="numero block whitespace-nowrap text-2xl text-text">{p.mes.ganhos}</span>
          <span className="text-text-muted">{t("ganhos no mês")}</span>
          <span className="mt-0.5 block">
            <Variacao atual={p.mes.ganhos} anterior={p.anterior.ganhos} />
          </span>
        </p>
        <p>
          <span className="numero block whitespace-nowrap text-2xl text-text">{p.mes.perdidos}</span>
          <span className="text-text-muted">{t("perdidos no mês")}</span>
        </p>
        <p>
          <span className="numero block whitespace-nowrap text-xl text-text">{dinheiro(p.mes.valor)}</span>
          <span className="text-text-muted">{t("vendido no mês")}</span>
        </p>
      </div>
      {p.etapas.length ? (
        <ul className="space-y-1.5">
          {p.etapas.map((e) => (
            <li key={e.id} className="grid grid-cols-[minmax(0,13rem)_1fr_2.5rem] items-center gap-3 text-sm">
              <span className="leading-tight text-text-muted">{e.nome}</span>
              <span className="h-2 overflow-hidden rounded-full bg-border">
                <span className="block h-full rounded-full bg-accent" style={{ width: `${(e.abertos / maior) * 100}%` }} />
              </span>
              <span className="numero text-right">{e.abertos}</span>
            </li>
          ))}
        </ul>
      ) : (
        <Vazio texto="Nenhum lead aberto neste funil." />
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
          <span className="block h-2 overflow-hidden rounded-full bg-border">
            <span className="block h-full rounded-full bg-accent" style={{ width: `${(i.total / maior) * 100}%` }} />
          </span>
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

  return (
    <section aria-labelledby="inicio-visao">
      <CabecalhoDaSecao
        id="inicio-visao"
        titulo={t("Visão da clínica")}
        descricao={t("Como a clínica está indo: agenda, atendimento e vendas. Só gerente e admin veem.")}
      />
      {q.isLoading ? (
        <div className="space-y-4">
          <Esqueleto quantos={4} altura="h-28" colunas="grid-cols-2 lg:grid-cols-4" />
          <Esqueleto quantos={4} altura="h-64" colunas="lg:grid-cols-2" />
        </div>
      ) : q.isError || !q.data ? (
        <p role="alert" className="rounded-2xl border bg-surface p-5 text-sm">
          {t("Não foi possível carregar os painéis. Tente novamente.")}
        </p>
      ) : (
        <div className="space-y-4">
          <FaixaDeIndicadores resumo={q.data.resumo} conversas={q.data.conversas} hoje={numerosDeHoje} />
          <Cartao titulo={t("Agenda por profissional · semana")} icone={UserRound} verTodos="/app/agenda" rotuloVerTodos={t("Abrir")}>
            <PainelProfissionais p={q.data.resumo} />
          </Cartao>
          <div className="grid gap-4 lg:grid-cols-2">
            <Cartao titulo={t("Conversas · últimos 30 dias")} icone={MessagesSquare} verTodos="/app/inbox" rotuloVerTodos={t("Abrir")}>
              <PainelConversas p={q.data.conversas} />
            </Cartao>
            <Cartao titulo={t("Funil de vendas")} icone={Filter} verTodos="/app/kanban" rotuloVerTodos={t("Abrir")}>
              <PainelFunil p={q.data.funil} onTrocar={setFunil} />
            </Cartao>
            <Cartao titulo={t("Agenda por unidade · semana")} icone={CalendarDays} verTodos="/app/agenda" rotuloVerTodos={t("Abrir")}>
              <PainelAgenda p={q.data.agenda} />
            </Cartao>
            <Cartao titulo={t("Origem dos pacientes · mês")} icone={Users} verTodos="/app/contacts" rotuloVerTodos={t("Abrir")}>
              <PainelOrigem p={q.data.origem} />
            </Cartao>
          </div>
        </div>
      )}
    </section>
  );
}
