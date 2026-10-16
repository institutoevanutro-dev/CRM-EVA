"use client";

import { useState } from "react";

import { FormularioDeTarefa } from "@/app/app/tasks/_components/FormularioDeTarefa";
import { ListaDeTarefas } from "@/app/app/tasks/_components/ListaDeTarefas";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useTasks } from "@/hooks/tasks/useTasks";
import { ROLE_RANK } from "@/lib/auth/types";
import { nomeDoResponsavel } from "@/lib/tarefas/rotulo-do-responsavel";
import { resumoDasTarefas, type NovaTarefa, type Tarefa } from "@/lib/tarefas/tipos";
import { Plus } from "@/lib/ui/icons";

interface Props {
  /** O contato da conversa: a tarefa nasce presa a ele. */
  contactId: string;
  /** O negócio ativo do contato, quando houver: a tarefa também o aponta. */
  leadId: string | null;
  /** O painel em modo suporte só lê. */
  readonly: boolean;
}

/**
 * "Tarefas deste contato" no painel do Inbox (porte do upstream #2842, issue
 * #2818, de @webtecnica).
 *
 * Quem atende combina algo no meio da conversa ("te chamo amanhã") e deixa isso
 * como tarefa, com prazo e responsável, SEM sair do Inbox. A tarefa nasce presa
 * ao contato e ao negócio ativo, e aparece na tela de Tarefas como qualquer
 * outra. Linha e formulário são OS MESMOS da tela de Tarefas e do dossiê.
 *
 * Diferença do upstream: lá a tarefa também fica presa à DEMANDA vigente, por
 * uma coluna nova (`crm_tasks.demanda_id`). Aqui não há migration: o vínculo é
 * pelo contato (e pelo negócio), que `crm_tasks` já tem, e a seção mostra as
 * tarefas em aberto do contato.
 */
export function TarefasDoAtendimento({ contactId, leadId, readonly }: Props) {
  const t = useT();
  const { user: usuario, activeOrg } = useAuth();
  // Criar tarefa é `agent`+, a régua da rota e da tela de Tarefas.
  const podeEditar =
    !readonly &&
    ((usuario.is_platform_admin && !usuario.support) ||
      (activeOrg ? ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent : false));
  const [formAberto, setFormAberto] = useState(false);
  const [emEdicao, setEmEdicao] = useState<Tarefa | null>(null);
  const [aberturas, setAberturas] = useState(0);

  const { tarefas, carregando, falhou, criarTarefa, editarTarefa, apagarTarefa, alternarConcluida } =
    useTasks({ contact_id: contactId, aberto: true });
  const equipe = useAssignableMembers(podeEditar);
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
    <section data-testid="inbox-tarefas-do-contato">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-text">
          {t("Tarefas deste contato")}
          {resumo.abertas > 0 ? (
            <span className="ml-1.5 font-normal text-text-muted">
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
            data-testid="inbox-nova-tarefa"
            onClick={() => abrir(null)}
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
        <p className="text-xs text-text-muted">
          {t("Nenhuma tarefa em aberto. Anote o próximo passo combinado, com prazo e responsável.")}
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
