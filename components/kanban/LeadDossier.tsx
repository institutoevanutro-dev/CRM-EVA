"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useEffect, useRef, useState } from "react";

import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useLeadTimeline } from "@/hooks/leads/useLeadTimeline";
import { ROLE_RANK } from "@/lib/auth/types";
import type { Lead } from "@/lib/types/leads";
import { ConversaNoDossie } from "./ConversaNoDossie";
import { LeadFieldsForm } from "./LeadFieldsForm";
import { ScoreSlot } from "./ScoreSlot";
import { LeadTimeline } from "./LeadTimeline";
import { TarefasDoNegocio } from "./TarefasDoNegocio";
import { OwnerBadge } from "./OwnerBadge";
import { SecaoDoDossie, useSecoesRecolhidas } from "./SecaoDoDossie";
import { resolveLeadOwner } from "@/lib/kanban/owner";
import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  lead: Lead;
  pipelineId: string;
  fieldDefs?: CustomFieldDef[];
  stageName: string;
  ownerNames?: Map<string, string | null>;
}

function formatBRL(cents: number | null, currency: string | null): string {
  if (cents === null) return "—";
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: currency ?? "BRL",
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `R$ ${(cents / 100).toFixed(0)}`;
  }
}

/** Quantas entradas a linha do tempo mostra com a seção recolhida (#3181). */
const ENTRADAS_COM_A_LINHA_RECOLHIDA = 3;

/**
 * O dossiê do negócio: cabeçalho vivo → Dados do negócio → Tarefas → Linha do
 * tempo (upstream #3181).
 *
 * A ordem antiga punha a linha do tempo antes dos campos ("primeiro saber o que
 * aconteceu"). Com uso real a linha do tempo cresce (mensagens, etapas,
 * automações, follow-ups) e empurra os CAMPOS DO FUNIL, que são o que se
 * preenche durante o atendimento, para baixo de uma parede de rolagem. Agora o
 * que se PREENCHE vem antes do que se CONSULTA, e as duas seções são
 * recolhíveis com o estado lembrado no navegador (`SecaoDoDossie.tsx`).
 *
 * Fora: a ordem configurável por funil (sugestão 3 do upstream), que pediria
 * uma preferência por funil que não existe.
 *
 * SALVAR NÃO FECHA. Quem edita precisa ver a atividade que acabou de gerar
 * entrar na timeline; fechar esconderia o registro justamente de quem o
 * produziu, e a funcionalidade que prova "sua ação fica registrada" provaria
 * isso para todo mundo menos para o autor.
 */
export function LeadDossier({
  open,
  onOpenChange,
  lead,
  pipelineId,
  fieldDefs = [],
  stageName,
  ownerNames,
}: Props) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const campos = useRef<HTMLDivElement | null>(null);
  const timeline = useLeadTimeline(open ? lead.id : null, lead.contact_id);
  const { fechadas, alternar, abrir } = useSecoesRecolhidas();
  const timelineRecolhida = fechadas.has("linha-do-tempo");
  // As três MAIS RECENTES: a rota devolve `performed_at` decrescente, então o
  // corte é no início da lista.
  const itensDaTimeline = timelineRecolhida
    ? timeline.itens.slice(0, ENTRADAS_COM_A_LINHA_RECOLHIDA)
    : timeline.itens;
  const temMaisNaTimeline = timeline.itens.length > ENTRADAS_COM_A_LINHA_RECOLHIDA;
  // O atalho "Editar campos" rola DEPOIS de a seção abrir: rolar no mesmo tique
  // mediria a posição com os campos ainda escondidos.
  const [pedidoDeRolagem, setPedidoDeRolagem] = useState(0);
  useEffect(() => {
    if (pedidoDeRolagem === 0) return;
    campos.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [pedidoDeRolagem]);
  const owner = resolveLeadOwner(lead, ownerNames);
  const score = lead.score ?? null;
  // Tarefas são de `agent` para cima, a mesma régua da tela de Tarefas e da
  // rota. O suporte temporário só lê, como lá (`requireSupportWrite`).
  const user = useUser();
  const activeOrg = useActiveOrg();
  const podeEditarTarefas =
    (user.is_platform_admin && !user.support) ||
    (activeOrg ? ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent : false);

  // Montadas uma vez e usadas nos dois estados da seção: duplicar o bloco é o
  // jeito mais fácil de o estado recolhido (o menos olhado) divergir. Props, e
  // não o elemento numa variável: `tests/unit/dossie-atalho-conversa` mede a
  // posição do elemento da linha do tempo no arquivo (por isso este comentário
  // não escreve a tag).
  const propsDaLinhaDoTempo = {
    itens: itensDaTimeline,
    chegouAoVivo: timeline.chegouAoVivo,
    isLoading: timeline.isLoading,
    isError: timeline.isError,
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-md"
        // Observável pelo mesmo motivo do board: "a assinatura morreu" e "nada
        // aconteceu" têm a mesma aparência, que é silêncio.
        data-realtime-status={timeline.realtimeStatus.toLowerCase()}
        // Observável como no board: "a entrega morreu" e "nada aconteceu"
        // têm a mesma aparência, e no dossiê a segunda é ainda mais crível —
        // negócio sem novidade é um estado normal.
        data-refetch-divergencias={timeline.seguranca.divergencias}
      >
        <SheetHeader className="pb-3">
          <SheetTitle className="text-base leading-6">{lead.title}</SheetTitle>
        </SheetHeader>

        {/* ① cabeçalho vivo */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border pb-3 text-xs">
          <span className="font-medium tabular-nums text-text">
            {formatBRL(lead.value_cents, lead.currency)}
          </span>
          <span className="text-text-muted">{stageName}</span>
          <OwnerBadge
            ownerKind={owner.kind}
            ownerName={owner.name}
            agentVersion={owner.agentVersion}
          />
          {score && (
            // O MESMO componente do card, não uma cópia do medidor.
            // "Superfície nova herda as decisões da antiga" só vale como
            // mecanismo: herdar por cópia é como as duas listas do evidence —
            // funciona hoje e diverge no mês em que alguém mudar um dos dois.
            // De brinde, o rótulo honesto da âncora ("registro que sustenta",
            // nunca "momento da conversa") vem junto, sem eu reescrever nada.
            <ScoreSlot
              probability={score.probability}
              band={score.band}
              reason={score.reason}
              factors={score.factors.slice(0, 3)}
            />
          )}

          <button
            type="button"
            onClick={() => {
              // Recolhidos, os campos também abrem: rolar até um título
              // fechado entregaria um destino vazio.
              abrir("dados-do-negocio");
              setPedidoDeRolagem((n) => n + 1);
            }}
            className="ml-auto text-text-muted underline-offset-2 hover:text-text hover:underline"
          >
            {t("Editar campos")}
          </button>
        </div>

        {/* O score NÃO aparece na timeline: recálculo é telemetria e não emite
            atividade (silêncio para telemetria, pulso para mudança de estado).
            Sem esta linha, quem visse o número mudando no cabeçalho e nunca na
            timeline concluiria que a timeline está incompleta. */}
        {score?.at && (
          <p className="pt-2 text-[11px] text-text-muted">
            {t("Probabilidade recalculada automaticamente")} ·{" "}
            {new Date(score.at).toLocaleString(tagDoIdioma)}
          </p>
        )}

        <ConversaNoDossie conversa={lead.conversa} />

        {/* ② Dados do negócio: o que se PREENCHE, antes da linha do tempo. */}
        <SecaoDoDossie
          id="dados-do-negocio"
          titulo={t("Dados do negócio")}
          recolhida={fechadas.has("dados-do-negocio")}
          aoAlternar={alternar}
        >
          <div ref={campos}>
            <LeadFieldsForm lead={lead} pipelineId={pipelineId} fieldDefs={fieldDefs} />
          </div>
        </SecaoDoDossie>

        {/* As tarefas ANTES da linha do tempo: a timeline conta o que já
            aconteceu, a tarefa é o que ainda falta fazer. Quem abre o card
            para agir procura o próximo passo primeiro. */}
        <TarefasDoNegocio
          leadId={lead.id}
          contactId={lead.contact_id}
          podeEditar={podeEditarTarefas}
          aberto={open}
        />

        {/* ③ Linha do tempo: a CONSULTA, por último. Recolhida, mostra as três
            entradas mais recentes e o "ver tudo". */}
        <SecaoDoDossie
          id="linha-do-tempo"
          titulo={t("Linha do tempo")}
          recolhida={timelineRecolhida}
          aoAlternar={alternar}
          className="flex-1 border-b-0"
          conteudoRecolhido={
            <>
              <LeadTimeline {...propsDaLinhaDoTempo} />
              {/* Só quando há o que ver: "ver tudo" numa lista de três não
                  levaria a lugar nenhum. */}
              {temMaisNaTimeline && (
                <button
                  type="button"
                  onClick={() => alternar("linha-do-tempo")}
                  className="mt-2 text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
                >
                  {t("Ver tudo")}
                </button>
              )}
            </>
          }
        >
          <LeadTimeline {...propsDaLinhaDoTempo} />
        </SecaoDoDossie>
      </SheetContent>
    </Sheet>
  );
}
