"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import Link from "next/link";
import { format } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { CaretLeft } from "@/lib/ui/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLgpdRequest } from "@/hooks/useLgpdRequest";
import { SlaTimeline } from "./SlaTimeline";
import { PreviewPanel } from "./PreviewPanel";
import { ApproveButton } from "./ApproveButton";
import { FORMA_DE_ENTREGA_LABELS, MarcarEntregueButton } from "./MarcarEntregueButton";
import { AuditTrail } from "./AuditTrail";
import type { LgpdRequestStatus, LgpdRequestType } from "@/hooks/useLgpdRequests";
import { prazoEmBr } from "@/lib/lgpd/sla";
import { LGPD_CANAL_LABELS, type LgpdCanalDeChegada, type LgpdFormaDeEntrega } from "@/lib/lgpd/types";

interface Props {
  id: string;
  /** Fuso da organização, resolvido no servidor (`fusoUtilizavel`). */
  fuso: string;
}

const TYPE_LABELS: Record<LgpdRequestType, string> = {
  redact: "Apagar dados do paciente",
  data_request: "Cópia dos dados",
  store_redact: "Apagar dados da loja",
};

const SOURCE_LABELS: Record<string, string> = {
  manual: "Registrado pela equipe",
  nuvemshop: "Loja (Nuvemshop)",
  api: "Integração",
  support: "Suporte",
};

const STATUS_LABELS: Record<LgpdRequestStatus, string> = {
  received: "Recebido",
  processing: "Em andamento",
  completed: "Concluído",
  failed: "Falhou",
  expired: "Expirado",
  pending_review: "Aguardando revisão",
};

const STATUS_VARIANT: Record<
  LgpdRequestStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  received: "secondary",
  processing: "default",
  completed: "outline",
  failed: "destructive",
  expired: "destructive",
  pending_review: "secondary",
};

export function LgpdRequestDetail({ id, fuso }: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const { data, isLoading, error } = useLgpdRequest(id);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Skeleton className="h-48 rounded-lg" />
          <Skeleton className="h-48 rounded-lg" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        {t("Falha ao carregar solicitação.")}
      </div>
    );
  }

  const { request, audit_trail, signed_pdf_url } = data.data;

  // Pedido registrado pela equipe: por onde chegou, a observação e a entrega em mãos.
  const canal = request.request_payload?.channel as LgpdCanalDeChegada | undefined;
  const nota = request.request_payload?.note;
  const entrega = request.result?.manual_delivery as
    | { method?: LgpdFormaDeEntrega; note?: string | null }
    | undefined;

  const typeLabel = t(TYPE_LABELS[request.request_type] ?? request.request_type);
  const statusLabel = t(STATUS_LABELS[request.status] ?? request.status);

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild className="-ml-2 gap-1 text-muted-foreground">
            <Link href="/app/lgpd/requests">
              <CaretLeft size={14} aria-hidden />
              {t("Solicitações")}
            </Link>
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* De quem é o pedido: o título era o começo do id ("#3f2a9b1c"). */}
          <h1 className="text-xl font-semibold tracking-tight">{request.titular}</h1>
          <Badge variant={STATUS_VARIANT[request.status] ?? "secondary"}>
            {statusLabel}
          </Badge>
          <Badge variant="outline">{typeLabel}</Badge>
          {request.emergency && (
            <Badge variant="destructive">{t("Urgente")}</Badge>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          {t("Recebido em")}{" "}
          {format(new Date(request.received_at), `dd/MM/yyyy '${t("às")}' HH:mm`, { locale: localeDaData })}
          {request.due_at && (
            <>
              {" · "}
              {t("Vence em")}{" "}
              {/* O DIA que a coluna guarda, não o instante no fuso do navegador: no
                  Brasil o `format(new Date(due_at))` mostrava a véspera do prazo. */}
              {prazoEmBr(request.due_at)}
            </>
          )}
        </p>
      </div>

      {/* PDF download: delivered (completed) or for the operator to deliver by hand (pending_review) */}
      {signed_pdf_url && (
        <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm flex flex-wrap items-center justify-between gap-4">
          <span>{t("Relatório de exportação disponível (expira em 72h).")}</span>
          <Button size="sm" variant="outline" asChild className="shrink-0">
            <a href={signed_pdf_url} download>
              {t("Baixar PDF")}
            </a>
          </Button>
        </div>
      )}

      {/* Action row */}
      <div className="flex flex-wrap items-center gap-3">
        <PreviewPanel requestId={request.id} />
        <ApproveButton
          requestId={request.id}
          requestType={request.request_type}
          status={request.status}
          titular={request.titular}
        />
        <MarcarEntregueButton
          requestId={request.id}
          requestType={request.request_type}
          status={request.status}
        />
      </div>

      {/* 2-col grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* SLA Timeline */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{t("Prazo")}</CardTitle>
          </CardHeader>
          <CardContent>
            {request.due_at ? (
              <SlaTimeline
                received_at={request.received_at}
                due_at={request.due_at}
                request_type={request.request_type}
                status={request.status}
                completed_at={request.completed_at}
                fuso={fuso}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t("Sem prazo definido.")}</p>
            )}
          </CardContent>
        </Card>

        {/* Request info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{t("Detalhes")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label={t("Titular")} value={request.titular} />
            <Row label={t("Tipo")} value={typeLabel} />
            <Row label={t("Situação")} value={statusLabel} />
            <Row
              label={t("Origem")}
              value={request.source ? t(SOURCE_LABELS[request.source] ?? request.source) : "—"}
            />
            {canal && LGPD_CANAL_LABELS[canal] && (
              <Row label={t("Chegou por")} value={t(LGPD_CANAL_LABELS[canal])} />
            )}
            {typeof nota === "string" && nota && <Row label={t("Observação")} value={nota} />}
            {entrega?.method && FORMA_DE_ENTREGA_LABELS[entrega.method] && (
              <Row label={t("Entregue")} value={t(FORMA_DE_ENTREGA_LABELS[entrega.method])} />
            )}
            {entrega?.note && <Row label={t("Observação da entrega")} value={entrega.note} />}
            <Row label={t("Tentativas")} value={String(request.attempts)} />
            {request.contact_id && (
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground shrink-0">{t("Ficha")}</span>
                <Link href={`/app/contacts/${request.contact_id}`} className="text-right hover:underline">
                  {t("Abrir a ficha do paciente")}
                </Link>
              </div>
            )}
            {request.external_customer_id && (
              <Row label={t("Código do cliente na loja")} value={request.external_customer_id} />
            )}
            <Row label={t("Código do pedido")} value={request.id} mono />
            {request.completed_at && (
              <Row
                label={t("Concluído em")}
                value={format(new Date(request.completed_at), "dd/MM/yyyy HH:mm", { locale: localeDaData })}
              />
            )}
            {request.error_message && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1">
                <p className="text-xs text-muted-foreground">{t("Erro")}</p>
                <p className="text-destructive text-xs">{request.error_message}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Audit trail (spans both cols) */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              {t("Trilha de auditoria")} ({audit_trail.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <AuditTrail entries={audit_trail} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      {/* `title` dá o valor completo em hover — sem isso um uuid truncado
          (id do contato, id externo) virava informação irrecuperável na
          tela, justo num relatório que existe pra ser conferido. */}
      <span
        className={`text-right truncate ${mono ? "font-mono text-xs" : ""}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
