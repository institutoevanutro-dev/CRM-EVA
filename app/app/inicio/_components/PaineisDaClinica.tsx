"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import type { DiaDeConversas, Origem } from "@/lib/inicio/paineis";

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
type Resposta = { conversas: Conversas; agenda: Agenda; funil: Funil; origem: OrigemPainel };

const CORES = {
  ia: "var(--color-accent-600)",
  equipe: "var(--color-warning)",
  semResposta: "var(--color-neutral-300)",
};

function Cartao({ titulo, children, href }: { titulo: string; children: ReactNode; href?: string }) {
  const t = useT();
  return (
    <section className="rounded-2xl border bg-surface p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h3 className="font-medium text-text">{titulo}</h3>
        {href ? (
          <Link className="text-sm text-accent underline" href={href}>
            {t("Abrir")}
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

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
  if (atual === anterior) return <span className="text-xs text-text-muted">=</span>;
  const subiu = atual > anterior;
  return (
    <span className={`text-xs ${subiu ? "text-success" : "text-error"}`} aria-label={subiu ? t("subiu em relação ao mês anterior") : t("caiu em relação ao mês anterior")}>
      {subiu ? "▲" : "▼"} {Math.abs(atual - anterior)}
    </span>
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
      <div className="mb-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <p>
          <span className="block text-2xl font-semibold">{total}</span>
          <span className="text-text-muted">{t("conversas novas")}</span>
        </p>
        <p>
          <span className="block text-2xl font-semibold">{iaSozinha}</span>
          <span className="text-text-muted">{t("a IA resolveu sozinha")}</span>
        </p>
        <p>
          <span className="block text-2xl font-semibold">{comEquipe}</span>
          <span className="text-text-muted">{t("passaram para a equipe")}</span>
        </p>
        <p>
          <span className="block text-2xl font-semibold">
            {p.primeiraRespostaMediaS != null ? duracao(p.primeiraRespostaMediaS) : "—"}
          </span>
          <span className="text-text-muted">{t("até a primeira resposta")}</span>
        </p>
      </div>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={dados} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
            <XAxis dataKey="rotulo" tick={{ fontSize: 11 }} interval={4} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
            <Tooltip
              contentStyle={{ borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-surface)" }}
            />
            <Bar dataKey="ia_sozinha" name={t("IA sozinha")} stackId="c" fill={CORES.ia} />
            <Bar dataKey="com_equipe" name={t("Com a equipe")} stackId="c" fill={CORES.equipe} />
            <Bar dataKey="sem_resposta" name={t("Sem resposta")} stackId="c" fill={CORES.semResposta} radius={[3, 3, 0, 0]} />
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
  return (
    <ul className="space-y-3">
      {p.unidades.map((u) => (
        <li key={u.unit_id ?? "sem"} className="rounded-xl border p-3">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <span className="font-medium">{u.unidade ?? t("Sem unidade")}</span>
            <span className="text-sm text-text-muted">
              {t("comparecimento")}{" "}
              <b className="text-base text-text">
                {u.comparecimento != null ? `${Math.round(u.comparecimento * 100)}%` : "—"}
              </b>
            </span>
          </div>
          <dl className="grid grid-cols-5 gap-2 text-center text-xs text-text-muted">
            {(
              [
                ["Marcadas", u.marcadas],
                ["Confirmadas", u.confirmadas],
                ["Realizadas", u.realizadas],
                ["Faltas", u.faltas],
                ["Canceladas", u.canceladas],
              ] as const
            ).map(([rotulo, n]) => (
              <div key={rotulo}>
                <dd className="text-lg font-semibold text-text">{n}</dd>
                <dt>{t(rotulo)}</dt>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
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
          <span className="block text-2xl font-semibold">{p.mes.ganhos}</span>
          <span className="text-text-muted">{t("ganhos no mês")}</span> <Variacao atual={p.mes.ganhos} anterior={p.anterior.ganhos} />
        </p>
        <p>
          <span className="block text-2xl font-semibold">{p.mes.perdidos}</span>
          <span className="text-text-muted">{t("perdidos no mês")}</span>
        </p>
        <p>
          <span className="block text-lg font-semibold">{dinheiro(p.mes.valor)}</span>
          <span className="text-text-muted">{t("vendido no mês")}</span>
        </p>
      </div>
      {p.etapas.length ? (
        <ul className="space-y-1.5">
          {p.etapas.map((e) => (
            <li key={e.id} className="grid grid-cols-[minmax(0,9rem)_1fr_2rem] items-center gap-2 text-sm">
              <span className="truncate text-text-muted">{e.nome}</span>
              <span className="h-2.5 overflow-hidden rounded-full bg-neutral-200">
                <span className="block h-full rounded-full bg-accent" style={{ width: `${(e.abertos / maior) * 100}%` }} />
              </span>
              <span className="text-right font-medium tabular-nums">{e.abertos}</span>
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
            <span className="font-medium tabular-nums">{i.total}</span>
          </div>
          <span className="block h-2.5 overflow-hidden rounded-full bg-neutral-200">
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

export function PaineisDaClinica() {
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
  });

  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold">{t("Visão da clínica")}</h2>
      {q.isLoading ? (
        <div role="status" aria-label={t("Carregando")} className="grid gap-4 lg:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-64 animate-pulse rounded-2xl border bg-surface" />
          ))}
        </div>
      ) : q.isError || !q.data ? (
        <p role="alert">{t("Não foi possível carregar os painéis. Tente novamente.")}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Cartao titulo={t("Conversas · últimos 30 dias")} href="/app/inbox">
            <PainelConversas p={q.data.conversas} />
          </Cartao>
          <Cartao titulo={t("Agenda da semana")} href="/app/agenda">
            <PainelAgenda p={q.data.agenda} />
          </Cartao>
          <Cartao titulo={t("Funil de vendas")} href="/app/kanban">
            <PainelFunil p={q.data.funil} onTrocar={setFunil} />
          </Cartao>
          <Cartao titulo={t("Origem dos pacientes · mês")} href="/app/contacts">
            <PainelOrigem p={q.data.origem} />
          </Cartao>
        </div>
      )}
    </div>
  );
}
