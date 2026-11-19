"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { diaLocalDoPrazo, estaAtrasada, estaEncerrada, type Tarefa } from "@/lib/tarefas/tipos";
import { CaretLeft, CaretRight } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  tarefas: Tarefa[];
  podeEditar: boolean;
  aoAbrirTarefa: (tarefa: Tarefa) => void;
  /** `YYYY-MM-DD` do dia clicado — o formulário abre já com esse prazo. */
  aoClicarNoDia: (dia: string) => void;
  /** Nome de quem faz a tarefa, para o balão do dia. */
  nomeDoResponsavel: (userId: string | null) => string | null;
}

const POR_DIA_VISIVEIS = 3;

/**
 * O mês, com o que vence em cada dia.
 *
 * ⚠️ Nem o nome do mês nem o do dia da semana são escritos à mão: os do
 * original eram dois arrays em português, e a tela em espanhol mostraria
 * "Março". `Intl` os produz a partir da etiqueta de idioma de quem está lendo,
 * que é a mesma regra que `tests/unit/i18n-a-data-segue-o-idioma.test.ts` cobra.
 */
function diasDaGrade(ano: number, mes: number): (Date | null)[] {
  const primeiroDiaDaSemana = new Date(ano, mes, 1).getDay();
  const diasNoMes = new Date(ano, mes + 1, 0).getDate();
  const grade: (Date | null)[] = Array<Date | null>(primeiroDiaDaSemana).fill(null);
  for (let dia = 1; dia <= diasNoMes; dia++) grade.push(new Date(ano, mes, dia));
  while (grade.length % 7 !== 0) grade.push(null);
  return grade;
}

export function CalendarioDeTarefas({
  tarefas,
  podeEditar,
  aoAbrirTarefa,
  aoClicarNoDia,
  nomeDoResponsavel,
}: Props) {
  const t = useT();
  const tag = useTagDeIdioma();
  const hoje = new Date();
  const [ano, setAno] = useState(hoje.getFullYear());
  const [mes, setMes] = useState(hoje.getMonth());
  // Dias com o "+N mais" aberto: a lista do dia inteira na própria célula.
  const [diasAbertos, setDiasAbertos] = useState<ReadonlySet<string>>(new Set());
  const nomeDoDia = new Intl.DateTimeFormat(tag, { day: "numeric", month: "long" });

  const grade = diasDaGrade(ano, mes);
  const diaDeHoje = diaLocalDoPrazo(hoje.toISOString());

  const porDia = new Map<string, Tarefa[]>();
  for (const tarefa of tarefas) {
    if (!tarefa.due_date) continue;
    const chave = diaLocalDoPrazo(tarefa.due_date);
    const atual = porDia.get(chave);
    if (atual) atual.push(tarefa);
    else porDia.set(chave, [tarefa]);
  }

  const nomeDoMes = new Intl.DateTimeFormat(tag, { month: "long", year: "numeric" }).format(
    new Date(ano, mes, 1),
  );
  const nomeDoDiaDaSemana = new Intl.DateTimeFormat(tag, { weekday: "short" });
  // 2026-03-01 é um domingo: a semana começa no índice 0 da grade.
  const cabecalhos = Array.from({ length: 7 }, (_, i) =>
    nomeDoDiaDaSemana.format(new Date(2026, 2, 1 + i)),
  );

  function mover(delta: number) {
    const alvo = new Date(ano, mes + delta, 1);
    setAno(alvo.getFullYear());
    setMes(alvo.getMonth());
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label={t("Mês anterior")}
          onClick={() => mover(-1)}
        >
          <CaretLeft size={16} aria-hidden />
        </Button>
        <h2 className="text-base font-semibold first-letter:uppercase">{nomeDoMes}</h2>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label={t("Próximo mês")}
          onClick={() => mover(1)}
        >
          <CaretRight size={16} aria-hidden />
        </Button>
      </div>

      <div className="grid grid-cols-7 border-b bg-muted/40">
        {cabecalhos.map((rotulo) => (
          <div
            key={rotulo}
            className="py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {rotulo}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 divide-x divide-y">
        {grade.map((dia, i) => {
          if (!dia) return <div key={`vazio-${i}`} className="min-h-[104px] bg-muted/15" />;

          const chave = diaLocalDoPrazo(dia.toISOString());
          const doDia = porDia.get(chave) ?? [];
          const aberto = diasAbertos.has(chave);
          const excedente = aberto ? 0 : doDia.length - POR_DIA_VISIVEIS;

          return (
            <div
              key={chave}
              className={cn(
                "flex min-h-[104px] flex-col gap-1 p-1.5",
                chave === diaDeHoje && "bg-primary/5",
                podeEditar && "cursor-pointer transition-colors hover:bg-muted/30",
              )}
              onClick={podeEditar ? () => aoClicarNoDia(chave) : undefined}
            >
              {/* O número do dia é o BOTÃO de criar nele (item 193): a célula
                  inteira só respondia ao mouse; teclado e leitor de tela chegam aqui. */}
              {(() => {
                const classe = cn(
                  "flex h-6 w-6 items-center justify-center self-start rounded-full text-xs font-semibold",
                  chave === diaDeHoje ? "bg-primary font-bold text-primary-foreground" : "text-muted-foreground",
                );
                return podeEditar ? (
                  <button
                    type="button"
                    className={cn(classe, "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring")}
                    aria-label={t("Nova tarefa em {{dia}}").replace("{{dia}}", nomeDoDia.format(dia))}
                    onClick={(e) => {
                      e.stopPropagation();
                      aoClicarNoDia(chave);
                    }}
                  >
                    {dia.getDate()}
                  </button>
                ) : (
                  <span className={classe}>{dia.getDate()}</span>
                );
              })()}

              {(aberto ? doDia : doDia.slice(0, POR_DIA_VISIVEIS)).map((tarefa) => {
                const titulo = nomeDoResponsavel(tarefa.assigned_to)
                  ? `${tarefa.title} — ${t(nomeDoResponsavel(tarefa.assigned_to)!)}`
                  : tarefa.title;
                const cor = cn(
                  "w-full truncate rounded-md px-1.5 py-0.5 text-left text-[10px] font-medium",
                  estaEncerrada(tarefa)
                    ? "bg-muted text-muted-foreground line-through"
                    : estaAtrasada(tarefa)
                      ? "bg-destructive/15 font-semibold text-destructive"
                      : "bg-primary/10 text-primary",
                );
                // Quem só lê não abre a edição (item 193): o Salvar dava erro.
                return podeEditar ? (
                  <button
                    key={tarefa.id}
                    type="button"
                    title={titulo}
                    onClick={(e) => {
                      e.stopPropagation();
                      aoAbrirTarefa(tarefa);
                    }}
                    className={cor}
                  >
                    {tarefa.title}
                  </button>
                ) : (
                  <span key={tarefa.id} title={titulo} className={cor}>
                    {tarefa.title}
                  </span>
                );
              })}

              {excedente > 0 ? (
                <button
                  type="button"
                  className="self-start rounded-md pl-1 text-[10px] font-semibold text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDiasAbertos((atual) => new Set(atual).add(chave));
                  }}
                >
                  +{excedente} {t("mais")}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
