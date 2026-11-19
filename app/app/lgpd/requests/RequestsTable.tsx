"use client";
import { useState } from "react";
import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Warning } from "@/lib/ui/icons";
import {
  useLgpdRequests,
  type LgpdRequest,
  type LgpdRequestStatus,
  type LgpdRequestType,
  type SlaBucket,
} from "@/hooks/useLgpdRequests";
import { LGPD_ESTADOS_ABERTOS } from "@/lib/lgpd/types";
import { SlaBanner } from "./SlaBanner";

// ── Label helpers ─────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<LgpdRequestType, string> = {
  redact: "Apagar dados do paciente",
  data_request: "Cópia dos dados",
  store_redact: "Apagar dados da loja",
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
  processing: "secondary",
  completed: "default",
  failed: "destructive",
  expired: "destructive",
  pending_review: "outline",
};

const SLA_VARIANT: Record<SlaBucket, "error" | "warning" | "success"> = {
  overdue: "error",
  critical: "error",
  warning: "warning",
  ok: "success",
};

const SLA_LABELS: Record<SlaBucket, string> = {
  overdue: "Vencido",
  critical: "Urgente",
  warning: "Atenção",
  ok: "Em dia",
};

// ── Date helpers ──────────────────────────────────────────────────────────────

function fmtRelative(iso: string, t: (texto: string) => string): string {
  try {
    const now = Date.now();
    const then = new Date(iso).getTime();
    const diffMs = now - then;
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return t("agora");
    if (diffMin < 60) return `${diffMin}${t("min atrás")}`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}${t("h atrás")}`;
    const diffD = Math.floor(diffH / 24);
    return `${diffD}${t("d atrás")}`;
  } catch {
    return iso;
  }
}

/** Pedido encerrado não está "vencendo": mostra só a data. */
const ABERTOS = new Set<LgpdRequestStatus>(LGPD_ESTADOS_ABERTOS);

/** dd/MM do instante, no fuso de quem olha. */
function diaEMes(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ── Select options ────────────────────────────────────────────────────────────

const ALL = "__ALL__";

// ── Component ─────────────────────────────────────────────────────────────────

export function RequestsTable() {
  const t = useT();
  const [status, setStatus] = useState<LgpdRequestStatus | undefined>();
  const [type, setType] = useState<LgpdRequestType | undefined>();
  const [slaBucket, setSlaBucket] = useState<SlaBucket | undefined>();
  const [page, setPage] = useState(1);

  const q = useLgpdRequests({ status, type, sla_bucket: slaBucket, page, limit: 25 });
  const rows = q.data?.data ?? [];
  const meta = q.data?.meta;

  return (
    <div className="flex flex-col gap-4">
      {/* Aviso do topo: conta os abertos da organização inteira, não só a página. */}
      {meta?.alertas && <SlaBanner alertas={meta.alertas} />}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2">
        <Select
          value={status ?? ALL}
          onValueChange={(v) => {
            setStatus(v === ALL ? undefined : (v as LgpdRequestStatus));
            setPage(1);
          }}
        >
          <SelectTrigger className="h-9 w-[170px]">
            <SelectValue placeholder={t("Situação: todas")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("Situação: todas")}</SelectItem>
            <SelectItem value="received">{t(STATUS_LABELS.received)}</SelectItem>
            <SelectItem value="processing">{t(STATUS_LABELS.processing)}</SelectItem>
            <SelectItem value="completed">{t(STATUS_LABELS.completed)}</SelectItem>
            <SelectItem value="failed">{t(STATUS_LABELS.failed)}</SelectItem>
            <SelectItem value="pending_review">{t(STATUS_LABELS.pending_review)}</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={type ?? ALL}
          onValueChange={(v) => {
            setType(v === ALL ? undefined : (v as LgpdRequestType));
            setPage(1);
          }}
        >
          <SelectTrigger className="h-9 w-[200px]">
            <SelectValue placeholder={t("Tipo: todos")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("Tipo: todos")}</SelectItem>
            <SelectItem value="redact">{t(TYPE_LABELS.redact)}</SelectItem>
            <SelectItem value="data_request">{t(TYPE_LABELS.data_request)}</SelectItem>
            <SelectItem value="store_redact">{t(TYPE_LABELS.store_redact)}</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={slaBucket ?? ALL}
          onValueChange={(v) => {
            setSlaBucket(v === ALL ? undefined : (v as SlaBucket));
            setPage(1);
          }}
        >
          <SelectTrigger className="h-9 w-[160px]">
            <SelectValue placeholder={t("Prazo: todos")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("Prazo: todos")}</SelectItem>
            <SelectItem value="overdue">{t(SLA_LABELS.overdue)}</SelectItem>
            <SelectItem value="critical">{t(SLA_LABELS.critical)}</SelectItem>
            <SelectItem value="warning">{t(SLA_LABELS.warning)}</SelectItem>
            <SelectItem value="ok">{t(SLA_LABELS.ok)}</SelectItem>
          </SelectContent>
        </Select>

        {(status || type || slaBucket) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatus(undefined);
              setType(undefined);
              setSlaBucket(undefined);
              setPage(1);
            }}
          >
            {t("Limpar filtros")}
          </Button>
        )}

        {meta && (
          <span className="ml-auto text-xs text-muted-foreground">
            {meta.total} {t(meta.total === 1 ? "solicitação" : "solicitações")}
          </span>
        )}
      </div>

      {q.isLoading ? (
        <Card className="flex flex-col gap-3 p-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </Card>
      ) : q.isError ? (
        <Card className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
          <Warning size={24} weight="fill" className="text-error" aria-hidden />
          <p>{t("Erro ao carregar solicitações.")}</p>
          <Button size="sm" variant="outline" onClick={() => q.refetch()}>
            {t("Tentar novamente")}
          </Button>
        </Card>
      ) : rows.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
          <Warning size={32} weight="thin" aria-hidden />
          <p className="font-medium">{t("Nenhuma solicitação LGPD")}</p>
          <p className="text-xs">{t("Solicitações de dados e anonimizações aparecerão aqui.")}</p>
        </Card>
      ) : (
        <>
          {/* Celular: um cartão por pedido, sem tabela correndo para o lado. */}
          <ul className="flex flex-col gap-2 md:hidden">
            {rows.map((r) => (
              <li key={r.id}>
                <Card className="flex flex-col gap-2 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium" title={r.titular}>
                        {r.titular}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t(TYPE_LABELS[r.request_type] ?? r.request_type)} · {fmtRelative(r.received_at, t)}
                      </p>
                    </div>
                    <Button asChild size="sm" variant="outline" className="h-8 shrink-0 px-3 text-xs">
                      <Link href={`/app/lgpd/requests/${r.id}`}>{t("Ver")}</Link>
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Prazo r={r} t={t} />
                    <Urgencia r={r} t={t} />
                    <Situacao r={r} t={t} />
                  </div>
                </Card>
              </li>
            ))}
          </ul>

          <Card className="hidden overflow-hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Titular")}</TableHead>
                  <TableHead>{t("Tipo")}</TableHead>
                  <TableHead>{t("Recebido")}</TableHead>
                  <TableHead>{t("Prazo")}</TableHead>
                  <TableHead>{t("Urgência")}</TableHead>
                  <TableHead>{t("Situação")}</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="max-w-[220px] truncate text-sm" title={r.titular}>
                      {r.titular}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="whitespace-nowrap text-xs">
                        {t(TYPE_LABELS[r.request_type] ?? r.request_type)}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {fmtRelative(r.received_at, t)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      <Prazo r={r} t={t} empilhado />
                    </TableCell>
                    <TableCell>
                      <Urgencia r={r} t={t} />
                    </TableCell>
                    <TableCell>
                      <Situacao r={r} t={t} />
                    </TableCell>
                    <TableCell>
                      <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
                        <Link href={`/app/lgpd/requests/${r.id}`}>{t("Ver")}</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}

      {/* Pagination */}
      {meta && (meta.page > 1 || meta.has_more) && (
        <div className="flex items-center justify-between text-sm">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || q.isFetching}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            {t("Anterior")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t("Página")} {meta.page}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!meta.has_more || q.isFetching}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("Próxima")}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Células ───────────────────────────────────────────────────────────────────

type Linha = LgpdRequest;
type T = (texto: string) => string;

/**
 * O prazo da linha. Concluído para o relógio e diz quando terminou; aberto mostra
 * a data e quanto falta (data e estado vêm prontos do servidor, no fuso da
 * organização: a tela não refaz conta de prazo).
 */
function Prazo({ r, t, empilhado = false }: { r: Linha; t: T; empilhado?: boolean }) {
  if (r.status === "completed" && r.completed_at) {
    return (
      <span className="text-success-fg">
        {t("Concluído em")} {diaEMes(r.completed_at)}
      </span>
    );
  }
  const aberto = ABERTOS.has(r.status);
  const urgente = aberto && (r.prazo.estado === "vencido" || r.prazo.estado === "vence_hoje");
  const bloco = empilhado ? "block" : "";
  return (
    <span>
      <span className={`${bloco} text-foreground`}>{r.prazo.data ?? "—"}</span>
      {aberto && r.prazo.texto && (
        <span className={`${bloco} ${empilhado ? "" : "ml-1"} font-medium ${urgente ? "text-error-fg" : "text-muted-foreground"}`}>
          {r.prazo.texto}
        </span>
      )}
    </span>
  );
}

function Urgencia({ r, t }: { r: Linha; t: T }) {
  if (!r.sla_bucket) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <Badge variant={SLA_VARIANT[r.sla_bucket]} className="text-xs">
      {t(SLA_LABELS[r.sla_bucket])}
    </Badge>
  );
}

function Situacao({ r, t }: { r: Linha; t: T }) {
  return (
    <Badge variant={STATUS_VARIANT[r.status]} className="whitespace-nowrap text-xs">
      {t(STATUS_LABELS[r.status] ?? r.status)}
    </Badge>
  );
}
