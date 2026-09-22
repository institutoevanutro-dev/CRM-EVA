"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { ArrowsClockwise, CalendarBlank, ListChecks, Plus } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useTasks } from "@/hooks/tasks/useTasks";
import { nomeDoResponsavel } from "@/lib/tarefas/rotulo-do-responsavel";
import type { NovaTarefa, SituacaoDaTarefa, Tarefa } from "@/lib/tarefas/tipos";

import { CalendarioDeTarefas } from "./CalendarioDeTarefas";
import { FormularioDeTarefa } from "./FormularioDeTarefa";
import { ListaDeTarefas } from "./ListaDeTarefas";

/** "aberto" não é uma situação do banco: é o filtro que a tela abre por padrão. */
type FiltroDeSituacao = "aberto" | SituacaoDaTarefa;

export function TarefasClient({ podeEditar, usuarioId }: { podeEditar: boolean; usuarioId: string }) {
  const t = useT();
  // A equipe que pode receber tarefa. A rota exige `agent`: para o visualizador
  // ela não carrega, e a lista simplesmente não mostra o nome.
  const equipe = useAssignableMembers(true);
  const membros = equipe.data;
  const rotuloDoResponsavel = (userId: string | null) =>
    membros ? nomeDoResponsavel(membros, userId) : null;
  const [modo, setModo] = useState<"lista" | "calendario">("lista");
  const [situacao, setSituacao] = useState<FiltroDeSituacao>("aberto");
  const [emEdicao, setEmEdicao] = useState<Tarefa | null>(null);
  const [formAberto, setFormAberto] = useState(false);
  const [prazoSugerido, setPrazoSugerido] = useState<string | undefined>();
  // A CHAVE DE REMONTAGEM do formulário. Ele lê o estado inicial das props
  // (nada de `useEffect` sincronizando), então abrir duas vezes seguidas o
  // "Nova tarefa" precisa de uma chave NOVA — senão a segunda abertura traz o
  // que ficou digitado na primeira.
  const [aberturas, setAberturas] = useState(0);

  const {
    tarefas,
    carregando,
    falhou,
    recarregar,
    criarTarefa,
    editarTarefa,
    apagarTarefa,
    alternarConcluida,
  } = useTasks(
    situacao === "aberto" ? { aberto: true } : { status: situacao },
  );

  function abrirNova(dia?: string) {
    setEmEdicao(null);
    setPrazoSugerido(dia);
    setAberturas((n) => n + 1);
    setFormAberto(true);
  }

  function abrirEdicao(tarefa: Tarefa) {
    setEmEdicao(tarefa);
    setPrazoSugerido(undefined);
    setAberturas((n) => n + 1);
    setFormAberto(true);
  }

  async function salvar(entrada: NovaTarefa) {
    if (emEdicao) await editarTarefa(emEdicao.id, entrada);
    else await criarTarefa(entrada);
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Tarefas")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              "O que ficou combinado, com prazo. Tarefa presa a um negócio aparece na linha do tempo dele.",
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={situacao}
            onValueChange={(v) => setSituacao(v as FiltroDeSituacao)}
          >
            <SelectTrigger className="h-9 w-[168px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="aberto">{t("Em aberto")}</SelectItem>
              <SelectItem value="pending">{t("Pendente")}</SelectItem>
              <SelectItem value="in_progress">{t("Em andamento")}</SelectItem>
              <SelectItem value="done">{t("Concluída")}</SelectItem>
              <SelectItem value="cancelled">{t("Cancelada")}</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center gap-0.5 rounded-md border bg-muted p-0.5">
            <button
              type="button"
              onClick={() => setModo("lista")}
              aria-pressed={modo === "lista"}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                modo === "lista"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <ListChecks size={14} aria-hidden />
              {t("Lista")}
            </button>
            <button
              type="button"
              onClick={() => setModo("calendario")}
              aria-pressed={modo === "calendario"}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                modo === "calendario"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <CalendarBlank size={14} aria-hidden />
              {t("Calendário")}
            </button>
          </div>

          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 text-xs"
            onClick={() => recarregar()}
            disabled={carregando}
          >
            <ArrowsClockwise size={14} className={cn(carregando && "animate-spin")} aria-hidden />
            {t("Atualizar")}
          </Button>

          {podeEditar && (
            <Button size="sm" className="h-9 gap-1.5 text-xs" onClick={() => abrirNova()}>
              <Plus size={14} aria-hidden />
              {t("Nova tarefa")}
            </Button>
          )}
        </div>
      </div>

      {falhou ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
          <p className="text-sm font-medium text-destructive">
            {t("Não foi possível carregar as tarefas.")}
          </p>
          <Button variant="outline" size="sm" className="mt-3 text-xs" onClick={() => recarregar()}>
            {t("Tentar novamente")}
          </Button>
        </div>
      ) : carregando ? (
        <div className="space-y-3" aria-busy>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg border bg-card" />
          ))}
        </div>
      ) : modo === "calendario" ? (
        <CalendarioDeTarefas
          tarefas={tarefas}
          podeEditar={podeEditar}
          aoAbrirTarefa={abrirEdicao}
          aoClicarNoDia={abrirNova}
          nomeDoResponsavel={rotuloDoResponsavel}
        />
      ) : (
        <ListaDeTarefas
          tarefas={tarefas}
          podeEditar={podeEditar}
          aoAlternarConcluida={alternarConcluida}
          aoEditar={abrirEdicao}
          aoApagar={(tarefa) => apagarTarefa(tarefa.id)}
          nomeDoResponsavel={rotuloDoResponsavel}
        />
      )}

      <FormularioDeTarefa
        key={aberturas}
        aberto={formAberto}
        aoMudarAbertura={setFormAberto}
        tarefa={emEdicao}
        prazoSugerido={prazoSugerido}
        aoSalvar={salvar}
        membros={membros ?? []}
        usuarioId={usuarioId}
      />
    </div>
  );
}
