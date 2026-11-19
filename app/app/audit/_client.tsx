"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

import { useT } from "@/hooks/i18n/useT";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuditQuery, type AuditEntry, type AuditFilters } from "@/hooks/audit/useAuditQuery";
import { useTeamMembers } from "@/hooks/team/useTeamMembers";
import { AREAS_DA_AUDITORIA, fraseDaAcao, type AreaDaAuditoria } from "@/lib/audit/frase";

const TODOS = "__todos__";

function fmtDate(iso: string, idioma: string): string {
  try {
    return new Date(iso).toLocaleString(idioma, { dateStyle: "short", timeStyle: "medium", hour12: false });
  } catch {
    return iso;
  }
}

function truncJson(v: unknown, max = 80): string {
  if (v == null) return "—";
  const s = JSON.stringify(v);
  if (!s) return "—";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function AuditClient() {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const [area, setArea] = useState(TODOS);
  const [quem, setQuem] = useState(TODOS);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [exportando, setExportando] = useState(false);
  // A rota de auditoria já é gestor+, a mesma de /team: quem abre esta tela lê a equipe.
  const equipe = useTeamMembers();
  const nomes = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of equipe.data?.data ?? []) m.set(p.user_id, p.full_name ?? p.email ?? p.user_id.slice(0, 8));
    return m;
  }, [equipe.data]);

  const filters = useMemo<AuditFilters>(
    () => ({
      // O filtro de área casa pelo prefixo do código ("lead." → lead.created, lead.won…).
      action: area === TODOS ? undefined : `${area}.`,
      actor_id: quem === TODOS ? undefined : quem,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
    }),
    [area, quem, from, to],
  );

  const q = useAuditQuery(filters);
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);

  function quemFez(r: AuditEntry): string {
    if (r.acting_as_platform_admin) return t("Suporte");
    if (r.actor_user_id) return nomes.get(r.actor_user_id) ?? `${t("Pessoa")} ${r.actor_user_id.slice(0, 8)}`;
    if (r.actor_api_token_id) return `${t("Integração")} ${r.actor_api_token_id.slice(0, 8)}`;
    return t("Sistema");
  }

  // Baixa por `fetch` para MOSTRAR o erro: navegar direto para a rota abria a
  // resposta de erro (JSON) como página.
  async function handleExport() {
    const qs = new URLSearchParams();
    if (filters.action) qs.set("action", filters.action);
    if (filters.actor_id) qs.set("actor_id", filters.actor_id);
    if (filters.from) qs.set("from", filters.from);
    if (filters.to) qs.set("to", filters.to);
    setExportando(true);
    try {
      const res = await fetch(`/api/v1/audit/export?${qs.toString()}`, { cache: "no-store" });
      if (!res.ok) {
        const corpo = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        toast.error(corpo?.error?.message ?? t("Não foi possível exportar o histórico."));
        return;
      }
      const nome = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1];
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = nome ?? "historico.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      // O Safari cancela o download se a URL some no mesmo tick do clique.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      toast.error(t("Não foi possível exportar o histórico."));
    } finally {
      setExportando(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
          <div className="space-y-1">
            <label htmlFor="audit-quem" className="block text-xs text-muted-foreground">{t("Quem")}</label>
            <Select value={quem} onValueChange={setQuem}>
              <SelectTrigger id="audit-quem">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TODOS}>{t("Todos")}</SelectItem>
                {(equipe.data?.data ?? []).map((p) => (
                  <SelectItem key={p.user_id} value={p.user_id}>
                    {nomes.get(p.user_id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label htmlFor="audit-area" className="block text-xs text-muted-foreground">{t("O quê")}</label>
            <Select value={area} onValueChange={setArea}>
              <SelectTrigger id="audit-area">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TODOS}>{t("Tudo")}</SelectItem>
                {(Object.keys(AREAS_DA_AUDITORIA) as AreaDaAuditoria[]).map((a) => (
                  <SelectItem key={a} value={a}>
                    {t(AREAS_DA_AUDITORIA[a].nome)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label htmlFor="audit-de" className="block text-xs text-muted-foreground">{t("De")}</label>
            <Input id="audit-de" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="audit-ate" className="block text-xs text-muted-foreground">{t("Até")}</label>
            <Input id="audit-ate" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button variant="outline" className="w-full" onClick={handleExport} disabled={exportando}>
              {exportando ? t("Exportando…") : t("Exportar CSV")}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Quando")}</TableHead>
              <TableHead>{t("O que aconteceu")}</TableHead>
              <TableHead>{t("Detalhes")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 3 }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : q.isError ? (
              // Falha não é "nenhum registro no período".
              <TableRow>
                <TableCell colSpan={3} className="text-center text-sm text-muted-foreground" role="alert">
                  {t("Não foi possível carregar o histórico. Tente de novo.")}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">
                  {t("Nenhuma alteração no período.")}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {fmtDate(r.created_at, tagDoIdioma)}
                  </TableCell>
                  <TableCell className="text-sm">
                    <FraseDaLinha quem={quemFez(r)} acao={r.action} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {/* Os detalhes técnicos ficam guardados atrás de um clique: servem a quem
                        investiga com o suporte, não à leitura do dia a dia. */}
                    <details>
                      <summary className="cursor-pointer">{t("Ver")}</summary>
                      <p className="mt-1 font-mono text-[11px] break-all">
                        {r.action}
                        {r.resource_type ? ` · ${r.resource_type}` : ""}
                        {r.resource_id ? `:${r.resource_id.slice(0, 8)}` : ""}
                        {r.request_id ? ` · ${t("Código")} ${r.request_id.slice(0, 8)}` : ""}
                      </p>
                      <p className="font-mono text-[11px] break-all">{truncJson(r.metadata, 400)}</p>
                    </details>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {q.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => q.fetchNextPage()}
            disabled={q.isFetchingNextPage}
          >
            {q.isFetchingNextPage ? t("Carregando…") : t("Carregar mais")}
          </Button>
        </div>
      )}
    </div>
  );
}

function FraseDaLinha({ quem, acao }: { quem: string; acao: string }) {
  const t = useT();
  const frase = fraseDaAcao(acao);
  return (
    <span>
      <strong className="font-medium">{quem}</strong>{" "}
      {frase ? (
        <>
          {t(frase.verbo)}
          {frase.objeto ? ` ${t(frase.objeto)}` : ""}
        </>
      ) : (
        // Sem tradução segura, o código fica à vista — melhor que uma frase inventada.
        <span className="font-mono text-xs text-muted-foreground">{acao}</span>
      )}
    </span>
  );
}
