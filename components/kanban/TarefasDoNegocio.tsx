"use client";

import { useState } from "react";

import { FormularioDeTarefa } from "@/app/app/tasks/_components/FormularioDeTarefa";
import { ListaDeTarefas } from "@/app/app/tasks/_components/ListaDeTarefas";
import { useUser } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useTasks } from "@/hooks/tasks/useTasks";
import { nomeDoResponsavel } from "@/lib/tarefas/rotulo-do-responsavel";
import { resumoDasTarefas, type NovaTarefa, type Tarefa } from "@/lib/tarefas/tipos";
import { Plus } from "@/lib/ui/icons";

interface Props {
  leadId: string;
  /** O contato do negócio vai junto na tarefa nova: a tarefa nasce presa aos dois. */
  contactId: string | null;
  /** Quem pode criar, concluir, editar e apagar: `agent` para cima, a régua da rota. */
  podeEditar: boolean;
  /** O dossiê aberto. Fechado, a consulta não sai. */
  aberto: boolean;
}

/**
 * A seção "Tarefas" do dossiê: o que ficou combinado PARA ESTE negócio.
 *
 * Portado do PR #2760 do upstream (melgarafael/DeskcommCRM, de @profpeque).
 *
 * A tabela, a rota e a lista já existiam (`crm_tasks`, `/api/v1/tasks`, tela de
 * Tarefas), e a tarefa já sabia ser presa a um negócio (`lead_id`). Mas a única
 * porta de criação era a tela de Tarefas, que não pergunta de qual negócio a
 * tarefa é: toda tarefa feita à mão nascia avulsa. Aqui ela nasce de dentro do
 * card, já presa a ele, e aparece na tela de Tarefas como qualquer outra.
 *
 * Nada de componente novo para a linha nem para o formulário: são OS MESMOS da
 * tela de Tarefas, para a régua de prazo, a confirmação de apagar e o campo de
 * responsável não divergirem entre os dois lugares.
 */
export function TarefasDoNegocio({ leadId, contactId, podeEditar, aberto }: Props) {
  const t = useT();
  const usuario = useUser();
  const [formAberto, setFormAberto] = useState(false);
  const [emEdicao, setEmEdicao] = useState<Tarefa | null>(null);
  // A chave de remontagem do formulário: o motivo está no `TarefasClient`.
  const [aberturas, setAberturas] = useState(0);

  const { tarefas, carregando, falhou, criarTarefa, editarTarefa, apagarTarefa, alternarConcluida } =
    useTasks({ lead_id: leadId }, { enabled: aberto });
  // A equipe que pode receber tarefa. A rota exige `agent`: para quem só lê ela
  // nem sai, e a linha fica sem o nome (nunca com um id cru).
  const equipe = useAssignableMembers(aberto && podeEditar);
  const membros = equipe.data;

  const resumo = resumoDasTarefas(tarefas);

  function abrir(tarefa: Tarefa | null) {
    setEmEdicao(tarefa);
    setAberturas((n) => n + 1);
    setFormAberto(true);
  }

  async function salvar(entrada: NovaTarefa) {
    if (emEdicao) await editarTarefa(emEdicao.id, entrada);
    else await criarTarefa(entrada);
  }

  return (
    <section
      className="border-b border-border py-3"
      aria-labelledby="dossie-tarefas"
      data-testid="tarefas-do-negocio"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3
          id="dossie-tarefas"
          className="text-xs font-medium uppercase tracking-wide text-text-muted"
        >
          {t("Tarefas")}
          {resumo.abertas > 0 ? (
            <span className="ml-1.5 normal-case tracking-normal">
              · {resumo.abertas} {resumo.abertas === 1 ? t("aberta") : t("abertas")}
              {resumo.atrasadas > 0 ? (
                <span className="font-semibold text-destructive">
                  {" "}
                  · {resumo.atrasadas} {resumo.atrasadas === 1 ? t("atrasada") : t("atrasadas")}
                </span>
              ) : null}
            </span>
          ) : null}
        </h3>
        {podeEditar ? (
          <button
            type="button"
            onClick={() => abrir(null)}
            // Alvo de toque de 32px de altura no celular sem crescer o cabeçalho
            // da seção: a área clicável sangra para fora com a margem negativa.
            className="-my-1.5 flex min-h-8 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-accent hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus size={12} aria-hidden />
            {t("Nova tarefa")}
          </button>
        ) : null}
      </div>

      {falhou ? (
        <p role="alert" className="text-xs text-destructive">
          {t("Não foi possível carregar as tarefas.")}
        </p>
      ) : carregando ? (
        <p className="text-xs text-text-muted" aria-busy>
          {t("Carregando…")}
        </p>
      ) : tarefas.length === 0 ? (
        // Vazio CURTO, e não o quadro tracejado da tela de Tarefas: no painel
        // estreito do dossiê ele empurraria a linha do tempo para baixo da dobra.
        <p className="text-xs text-text-muted">
          {t("Nenhuma tarefa neste negócio. Anote o próximo passo combinado, com prazo e responsável.")}
        </p>
      ) : (
        <ListaDeTarefas
          tarefas={tarefas}
          podeEditar={podeEditar}
          aoAlternarConcluida={alternarConcluida}
          aoEditar={abrir}
          aoApagar={(tarefa) => apagarTarefa(tarefa.id)}
          nomeDoResponsavel={(userId) => (membros ? nomeDoResponsavel(membros, userId) : null)}
          mostrarNegocio={false}
          compacta
        />
      )}

      <FormularioDeTarefa
        key={aberturas}
        aberto={formAberto}
        aoMudarAbertura={setFormAberto}
        tarefa={emEdicao}
        aoSalvar={salvar}
        leadId={leadId}
        contactId={contactId}
        membros={membros ?? []}
        usuarioId={usuario.id}
      />
    </section>
  );
}
