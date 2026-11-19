"use client";
/**
 * Tabs do detalhe de agent. Wave 12 (S-13.12) entrega Test, Runs e History.
 */
import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/hooks/i18n/useT";
import { AgentForm, type ChannelSessionLite } from "./AgentForm";
import type { CoberturaPorFunil } from "./FunisDoAgente";
import type { MaterialDoAcervo } from "./BasesDoAgente";
import type { FunilDaResposta } from "@/hooks/pipelines/usePipelines";
import { TestPanel } from "./TestPanel";
import { RunsTable } from "./RunsTable";
import { UsoDasCapacidades } from "./UsoDasCapacidades";
import { VersionHistory } from "./VersionHistory";
import { ProposalsPanel } from "./ProposalsPanel";
import type { AgentRow } from "@/hooks/ai/useAgent";
import type { AgentVersionRow, AgentVersionSummary } from "@/hooks/ai/useAgentVersions";
import type { CredentialRow } from "@/hooks/ai/useCredentials";

interface Props {
  /** Funis da org, para a marcação de escopo do agente (spec 17 passo 3). */
  funis?: FunilDaResposta[];
  cobertura?: CoberturaPorFunil;
  /** O acervo da organização, para a seção "o que ele consulta" (0181). */
  materiais?: MaterialDoAcervo[];
  agent: AgentRow;
  draft: AgentVersionRow | null;
  published: AgentVersionRow | null;
  /** De onde o formulário se hidrata — ver `lib/ai/agents/versoes-da-tela.ts`. */
  base?: AgentVersionRow | null;
  /** Rascunho anterior à publicada: existe, mas não abre nem publica. */
  draftObsoleto?: AgentVersionRow | null;
  /** A lista do Histórico, sem o texto das instruções (ver `AgentVersionSummary`). */
  versions: AgentVersionSummary[];
  credentials: CredentialRow[];
  /** Provedores cuja chave veio na instalação — ver `AgentForm`. */
  provedoresDaInstalacao?: string[];
  channelSessions: ChannelSessionLite[];
  routerMembership?: { routerId: string; routerName: string } | null;
  readOnly?: boolean;
}

export function AgentTabs(props: Props) {
  const t = useT();
  const [tab, setTab] = React.useState<
    "configuration" | "test" | "capacidades" | "runs" | "history" | "proposals"
  >("configuration");
  const hasVersion = !!(props.draft || props.published);
  // O que está escrito na Configuração e ainda não foi salvo. Teste, Propostas e
  // Histórico agem sobre a versão SALVA; sabendo disto, eles avisam em vez de
  // agir por cima do texto da tela.
  const [alteracoesNaoSalvas, setAlteracoesNaoSalvas] = React.useState(false);
  const [pedidoDeAbrir, setPedidoDeAbrir] = React.useState<{
    versao: AgentVersionRow;
    n: number;
  } | null>(null);
  const irParaConfiguracao = React.useCallback(() => setTab("configuration"), []);

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as typeof tab)}
      className="flex flex-col gap-4"
    >
      <TabsList>
        <TabsTrigger value="configuration">{t("Configuração")}</TabsTrigger>
        <TabsTrigger value="test" disabled={!hasVersion}>
          {t("Teste")}
        </TabsTrigger>
        <TabsTrigger value="capacidades">{t("Capacidades")}</TabsTrigger>
        <TabsTrigger value="runs">{t("Execuções")}</TabsTrigger>
        <TabsTrigger value="history">{t("Histórico")}</TabsTrigger>
        <TabsTrigger value="proposals">{t("Propostas")}</TabsTrigger>
      </TabsList>

      {/*
        SEMPRE montada, só escondida. Era desmontada ao trocar de aba (o padrão
        do Radix), e o prompt escrito e não salvo sumia sem aviso — bastava abrir
        o Teste para conferir alguma coisa.
      */}
      <TabsContent
        value="configuration"
        className="m-0"
        forceMount
        hidden={tab !== "configuration"}
      >
        <AgentForm
          mode="edit"
          agent={props.agent}
          draft={props.draft}
          published={props.published}
          base={props.base}
          draftObsoleto={props.draftObsoleto}
          credentials={props.credentials}
          provedoresDaInstalacao={props.provedoresDaInstalacao}
          channelSessions={props.channelSessions}
          funis={props.funis}
          cobertura={props.cobertura}
          materiais={props.materiais}
          routerMembership={props.routerMembership}
          readOnly={props.readOnly}
          onDirtyChange={setAlteracoesNaoSalvas}
          pedidoDeAbrir={pedidoDeAbrir}
        />
      </TabsContent>

      <TabsContent value="test" className="m-0">
        <TestPanel
          agent={props.agent}
          draft={props.draft}
          published={props.published}
          readOnly={props.readOnly}
          alteracoesNaoSalvas={alteracoesNaoSalvas}
          onIrParaConfiguracao={irParaConfiguracao}
        />
      </TabsContent>

      <TabsContent value="capacidades" className="m-0">
        <UsoDasCapacidades agentId={props.agent.id} active={tab === "capacidades"} />
      </TabsContent>

      <TabsContent value="runs" className="m-0">
        <RunsTable agentId={props.agent.id} active={tab === "runs"} />
      </TabsContent>

      <TabsContent value="proposals" className="m-0">
        <ProposalsPanel
          agentId={props.agent.id}
          active={tab === "proposals"}
          readOnly={props.readOnly}
          rascunhoVigente={props.draft}
          alteracoesNaoSalvas={alteracoesNaoSalvas}
          onIrParaConfiguracao={irParaConfiguracao}
        />
      </TabsContent>

      <TabsContent value="history" className="m-0">
        <VersionHistory
          agentId={props.agent.id}
          versions={props.versions}
          readOnly={props.readOnly}
          rascunhoVigente={props.draft}
          alteracoesNaoSalvas={alteracoesNaoSalvas}
          onIrParaConfiguracao={irParaConfiguracao}
          materiais={props.materiais}
          funis={props.funis}
          onAbrirNoEditor={(versao) => {
            setPedidoDeAbrir((anterior) => ({ versao, n: (anterior?.n ?? 0) + 1 }));
            setTab("configuration");
          }}
        />
      </TabsContent>
    </Tabs>
  );
}
