"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { EmptyState } from "@/components/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { RespostaDoPrograma } from "@/lib/bonus/tela";
import { Trophy } from "@/lib/ui/icons";

import { BonusDaEquipe } from "./BonusDaEquipe";
import { ConfiguracaoDoBonus } from "./ConfiguracaoDoBonus";
import { MeuBonus } from "./MeuBonus";

interface Props {
  papel: { existe: boolean; aprovador: boolean; participante: boolean };
}

export function BonusClient({ papel }: Props) {
  const t = useT();
  const qc = useQueryClient();
  const programa = useQuery({
    queryKey: ["bonus", "programa"],
    queryFn: () => apiClient.get<{ data: RespostaDoPrograma }>("/api/v1/bonus/programa"),
    enabled: !papel.existe,
  });
  const criar = useMutation({
    mutationFn: () => apiClient.post("/api/v1/bonus/programa", {}),
    onSuccess: () => window.location.reload(),
  });

  if (!papel.existe) {
    const podeCriar = programa.data?.data.pode_criar ?? false;
    return (
      <div className="flex flex-col items-center gap-2">
        <EmptyState
          icon={Trophy}
          headline={t("O programa de bônus não está ligado.")}
          subcopy={
            podeCriar
              ? t("Ligue o programa e preencha a configuração antes do primeiro dia do mês.")
              : t("Quem administra a organização liga o programa.")
          }
          primary={podeCriar && !criar.isPending ? { label: t("Ligar o programa"), onClick: () => criar.mutate() } : undefined}
        />
        {criar.isError ? <p className="text-sm text-destructive">{t("Não foi possível ligar o programa.")}</p> : null}
      </div>
    );
  }
  if (!papel.aprovador && !papel.participante) {
    return <EmptyState icon={Trophy} headline={t("Você não participa do programa de bônus.")} />;
  }

  const inicial = papel.participante ? "meu" : "equipe";
  return (
    <Tabs defaultValue={inicial} onValueChange={() => void qc.invalidateQueries({ queryKey: ["bonus"] })}>
      <TabsList>
        {papel.participante ? <TabsTrigger value="meu">{t("Meu bônus")}</TabsTrigger> : null}
        {papel.aprovador ? <TabsTrigger value="equipe">{t("Bônus da equipe")}</TabsTrigger> : null}
        {papel.aprovador ? <TabsTrigger value="config">{t("Configuração")}</TabsTrigger> : null}
      </TabsList>
      {papel.participante ? (
        <TabsContent value="meu">
          <MeuBonus />
        </TabsContent>
      ) : null}
      {papel.aprovador ? (
        <TabsContent value="equipe">
          <BonusDaEquipe />
        </TabsContent>
      ) : null}
      {papel.aprovador ? (
        <TabsContent value="config">
          <ConfiguracaoDoBonus />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}
