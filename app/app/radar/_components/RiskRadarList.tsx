"use client";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useAtRiskLeads, type AtRiskLead } from "@/hooks/leads/useAtRiskLeads";
import type { RiskBucket } from "@/lib/leads/risk-radar";
import {
  ArrowRight,
  CheckCircle,
  ClockCountdown,
  PaperPlaneTilt,
  Warning,
} from "@/lib/ui/icons";

const RISK_META: Record<
  Exclude<RiskBucket, "em_dia">,
  { label: string; variant: "error" | "warning" | "info" }
> = {
  critico: { label: "Crítico", variant: "error" },
  em_risco: { label: "Em risco", variant: "warning" },
  // "Em voo" era jargão interno: para a equipe, é um retorno já marcado.
  em_voo: { label: "Retorno agendado", variant: "info" },
};

function coldFor(hours: number, t: (texto: string) => string): string {
  if (hours < 48) return `${t("parado há")} ${hours}h`;
  return `${t("parado há")} ${Math.round(hours / 24)}d`;
}

/** Tempo em aberto como a equipe lê: horas só no primeiro par de dias, depois dias. */
function abertaHa(hours: number, t: (texto: string) => string): string {
  if (hours < 48) return `${t("aberta há")} ${hours}h`;
  return `${t("aberta há")} ${Math.round(hours / 24)} ${t("dias")}`;
}

/** Quantas pendências o bloco mostra antes do "ver todas". */
const PRIMEIRAS_PENDENCIAS = 5;

function followupWhen(iso: string, t: (texto: string) => string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return t("agora");
  const hours = Math.round(diffMs / 3_600_000);
  if (hours < 48) return `${t("em")} ${Math.max(1, hours)}h`;
  return `${t("em")} ${Math.round(hours / 24)}d`;
}

export function RiskRadarList() {
  const t = useT();
  const { data, isLoading, isError, refetch } = useAtRiskLeads();
  const [verTodas, setVerTodas] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  // Falha não é vazio: o aviso verde de "nenhum risco" numa carga que falhou
  // dizia à equipe que estava tudo bem justo quando ela não sabia de nada.
  if (isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center" data-testid="radar-erro">
        <Warning size={28} className="text-warning-fg" aria-hidden />
        <p className="text-sm font-medium">{t("Não foi possível carregar o radar.")}</p>
        <Button size="sm" variant="outline" onClick={() => void refetch()}>
          {t("Tentar de novo")}
        </Button>
      </div>
    );
  }

  // O vazio só é vazio se as DUAS listas estiverem vazias. Sem esta condição,
  // uma organização com 8 demandas sem próximo passo e nenhum lead frio veria
  // "Nenhuma demanda em risco" — escondendo exatamente o vazamento que o
  // invariante 4 existe para denunciar.
  const semPasso = data?.sem_proximo_passo ?? [];
  if (!data || (data.total === 0 && semPasso.length === 0)) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center"
        data-testid="radar-empty"
      >
        <CheckCircle size={28} className="text-success-fg/70" aria-hidden />
        <p className="text-sm font-medium">{t("Nenhuma demanda em risco")}</p>
        <p className="text-xs text-muted-foreground">
          {t("Toda demanda aberta teve atividade recente ou já tem um retorno agendado.")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* INVARIANTE 4 em forma acionável: o índice de atrito publica a CONTAGEM
          ("N demandas abertas sem próximo passo"); contagem sem lugar para agir
          viola o invariante 5. Esta é a lista que responde "e daí?". */}
      {semPasso.length > 0 ? (
        <section
          className="rounded-lg border border-warning-border bg-warning-bg/40 p-3"
          data-testid="radar-sem-proximo-passo"
        >
          <p className="text-sm font-medium">
            {semPasso.length}{" "}
            {semPasso.length === 1
              ? t("demanda aberta sem próximo passo")
              : t("demandas abertas sem próximo passo")}
          </p>
          <p className="mb-2 text-xs text-muted-foreground">
            {t(
              "Ninguém marcou o que acontece a seguir. Cada uma é alguém esperando sem que nada esteja combinado.",
            )}
          </p>
          <ul className="flex flex-col gap-1">
            {(verTodas ? semPasso : semPasso.slice(0, PRIMEIRAS_PENDENCIAS)).map((d) => (
              <li key={d.id} className="flex items-baseline justify-between gap-3 text-xs">
                <span className="truncate">{d.contact_name ?? t("Contato sem nome")}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {abertaHa(d.horas_aberta, t)}
                </span>
              </li>
            ))}
          </ul>
          {semPasso.length > PRIMEIRAS_PENDENCIAS ? (
            <button
              type="button"
              onClick={() => setVerTodas((v) => !v)}
              className="mt-2 text-xs font-medium text-accent-strong underline-offset-2 hover:underline"
            >
              {verTodas ? t("Mostrar menos") : `${t("Ver todas")} (${semPasso.length})`}
            </button>
          ) : null}
        </section>
      ) : null}

      <div className="flex flex-wrap gap-2" data-testid="radar-counts">
        <Badge variant="error">
          {data.counts.critico} {data.counts.critico === 1 ? t("crítico") : t("críticos")}
        </Badge>
        <Badge variant="warning">
          {data.counts.em_risco} {t("em risco")}
        </Badge>
        <Badge variant="info">
          {data.counts.em_voo} {t("com retorno agendado")}
        </Badge>
      </div>

      <ul className="divide-y divide-border rounded-lg border border-border">
        {data.items.map((lead) => (
          <RadarRow key={lead.id} lead={lead} />
        ))}
      </ul>
    </div>
  );
}

function RadarRow({ lead }: { lead: AtRiskLead }) {
  const t = useT();
  const meta = RISK_META[lead.risk as Exclude<RiskBucket, "em_dia">] ?? RISK_META.em_risco;
  const href = lead.conversation_id
    ? `/app/inbox?id=${lead.conversation_id}`
    : `/app/pipelines/${lead.pipeline_id}`;

  const claim = useClaimConversation();
  const qc = useQueryClient();

  // Dono do NEGÓCIO — humano OU agente (0070). Antes desta linha o radar lia só
  // `owner_user_id`, então um lead que a IA trabalha há dezenas de turnos aparecia
  // como "Sem dono" e mandava um humano resgatar o que já estava sendo tocado.
  // A distinção é a MESMA do card (OwnerBadge): geométrica, nunca ícone de robô —
  // uma fonte de verdade para "quem é o dono", em todas as telas.
  const dono =
    lead.owner_kind === "ai"
      ? `${t("Assistente de IA:")} ${lead.owner_agent_name ?? t("sem nome")}`
      : lead.owner_user_id || lead.assignee_kind === "user"
        ? t("Com atendente")
        : lead.assignee_kind === "ai"
          ? t("Assistente na conversa")
          : t("Sem dono");

  // "Assumir" é tirar da IA e trazer para si: continua valendo enquanto não há
  // dono HUMANO — dono agente não bloqueia o handoff, é justamente o caso dele.
  const ownedByHuman = Boolean(lead.owner_user_id) || lead.assignee_kind === "user";
  const canClaim = Boolean(lead.conversation_id) && !ownedByHuman;

  function handleClaim() {
    if (!lead.conversation_id) return;
    claim.mutate(
      { conversation_id: lead.conversation_id },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: ["leads-at-risk"] });
          toast.success(t("Você assumiu a demanda"));
        },
      },
    );
  }

  return (
    <li
      data-testid="radar-item"
      data-risk={lead.risk}
      className="flex items-start gap-2 pr-3 transition-colors hover:bg-accent/50"
    >
      <Link href={href} className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3">
        <Badge variant={meta.variant} className="mt-0.5 shrink-0">
          {t(meta.label)}
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{lead.title}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {lead.contact_name ? <span className="truncate">{lead.contact_name}</span> : null}
            <span className="inline-flex items-center gap-1">
              <ClockCountdown size={13} aria-hidden />
              {coldFor(lead.hours_since_activity, t)}
            </span>
            <span className="inline-flex items-center gap-1" data-testid="radar-assignee">
              {dono}
            </span>
          </p>
          {lead.agenda?.appointment_id ? (
            <p className="mt-1 text-xs text-info-fg">{t(lead.agenda.motivo === "presenca_vencida" ? "Presença não confirmada · revise o compromisso" : lead.agenda.motivo === "presenca_pendente" ? "Confirme a presença · cobrança aguardando" : "Compromisso agendado · cobrança aguardando")}</p>
          ) : lead.in_flight && lead.next_followup_at ? (
            <p className="mt-1 inline-flex items-center gap-1 text-xs text-info-fg">
              <PaperPlaneTilt size={13} aria-hidden />
              {t("Assistente retorna")} {followupWhen(lead.next_followup_at, t)}
            </p>
          ) : (
            <p className="mt-1 inline-flex items-center gap-1 text-xs text-warning-fg">
              <Warning size={13} aria-hidden />
              {t("Sem próximo passo agendado")}
            </p>
          )}
        </div>
      </Link>
      <div className="flex shrink-0 items-center gap-2 self-center">
        {lead.agenda?.appointment_id ? <Link className="text-xs underline" href={`/app/agenda?compromisso=${lead.agenda.appointment_id}`}>{t("Ver compromisso")}</Link> : null}
        {canClaim ? (
          <Button
            size="sm"
            variant="outline"
            disabled={claim.isPending}
            onClick={handleClaim}
            data-testid="radar-claim"
          >
            {t("Assumir")}
          </Button>
        ) : null}
        <ArrowRight size={16} className="text-muted-foreground" aria-hidden />
      </div>
    </li>
  );
}
