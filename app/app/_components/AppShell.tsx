"use client";
import { useState, type ReactNode } from "react";
import { Sidebar } from "@/components/shell/Sidebar";
import { TopBar } from "@/components/shell/TopBar";
import { BarraDeProgressoNavegacao } from "@/components/shell/BarraDeProgressoNavegacao";
import { useInboundMessageAlerts } from "@/hooks/notifications/useInboundMessageAlerts";
import { useCrmAlerts } from "@/hooks/notifications/useCrmAlerts";
import { useNotifyOpenFromServiceWorker } from "@/lib/notifications/notify_open";
import { useT } from "@/hooks/i18n/useT";

interface AppShellProps {
  sidebarCollapsed: boolean;
  children: ReactNode;
}

export function AppShell({ sidebarCollapsed, children }: AppShellProps) {
  useInboundMessageAlerts();
  useCrmAlerts();
  useNotifyOpenFromServiceWorker();
  const t = useT();
  // Recolher otimista (D1.10): nasce do cookie lido no servidor e muda no clique.
  const [recolhido, setRecolhido] = useState(sidebarCollapsed);
  return (
    // Menos `--faixas-de-cima` (publicada por `FaixasDeCima`, porte do original
    // #3190): as faixas do topo ficam ACIMA da casca, e sem o desconto o
    // documento media a tela mais a faixa, rolável justo quando o WhatsApp está
    // desconectado. `dvh` acompanha a barra do navegador do celular.
    <div className="flex min-h-[calc(100dvh-var(--faixas-de-cima,0px))] w-full bg-background">
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:rounded-md focus:border focus:border-border focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-text"
      >
        {t("Pular para o conteúdo")}
      </a>
      <BarraDeProgressoNavegacao />
      <div className="hidden md:block">
        <Sidebar collapsed={recolhido} onAlternarRecolhido={() => setRecolhido((r) => !r)} />
      </div>
      {/*
        `min-w-0` é o que permite a coluna de conteúdo ENCOLHER. Um flex item
        nasce com `min-width: auto`, ou seja, nunca fica menor que o conteúdo —
        então qualquer bloco largo (uma fila de abas, uma tabela) empurrava a
        PÁGINA INTEIRA para o lado em vez de rolar dentro da própria caixa, e o
        conteúdo sumia sem nada indicando que existia.

        Medido em 390x844 no detalhe do agente, que tem seis abas: a página
        estourava 476px na horizontal; com esta classe, 212px — o que sobra é o
        cabeçalho, presente também em telas que não têm abas (a lista de agentes
        estoura 236px). Isolado ancestral por ancestral: é este o que decide.
      */}
      {/*
        Sem `md:ml-*`: a barra voltou a ocupar lugar na linha (ver o comentário
        em `Sidebar.tsx`), então o que sobra para esta coluna é exatamente o que
        ela não usou. A margem existia para compensar uma barra `fixed`, e era a
        SEGUNDA medida da mesma coisa — a que discordava e deixava a barra por
        cima da lista.
      */}
      <div className="flex min-h-[calc(100dvh-var(--faixas-de-cima,0px))] min-w-0 flex-1 flex-col">
        <TopBar />
        <main id="conteudo" tabIndex={-1} className="flex-1 overflow-auto p-6 focus:outline-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
