"use client";
import { useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import type { GoogleConflict } from "@/lib/agenda/google/sync-model";
export interface SyncDetail {
  revision: string;
  local_revision: string;
  etag: string | null;
  synced_at: string | null;
  error: string | null;
  pending: boolean;
  conflict: GoogleConflict | null;
  can_resolve: boolean;
  /** Situação da conexão Google de quem lançou; null quando não há ou não dá para ver. */
  connection_status?: string | null;
}
/**
 * Conexões que não voltam sozinhas: o mesmo conjunto que a exclusão de contato
 * trata como "travado" (`CONEXAO_PEDE_ATENCAO` em app/api/v1/contacts/_handler.ts).
 * O aviso daquela tela promete que o motivo aparece aqui.
 */
const MOTIVO_DA_CONEXAO: Record<string, string> = {
  token_expired:
    "A conexão com o Google de quem lançou este compromisso expirou. Quem o lançou precisa reconectar o Google em Configurar suas agendas.",
  scope_missing:
    "A conexão com o Google de quem lançou este compromisso está sem permissão para a agenda. Quem o lançou precisa reconectar o Google em Configurar suas agendas.",
  error:
    "A conexão com o Google de quem lançou este compromisso está com erro. Quem o lançou precisa reconectar o Google em Configurar suas agendas.",
};

export function SincronizacaoDoCompromisso({
  id,
  sync,
  onSaved,
}: {
  id: string;
  sync: SyncDetail;
  onSaved: () => void;
}) {
  const t = useT();
  const locale = useTagDeIdioma();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  async function decide(choice: "local" | "google" | "preserve_remote" | "retry") {
    setBusy(true);
    try {
      await apiClient.post(
        `/api/v1/agenda/agendamentos/${id}/google/${choice === "retry" ? "retry" : "resolver"}`,
        {
          choice,
          expected_domain_revision: sync.revision,
          expected_google_local_revision: sync.local_revision,
          etag: sync.etag,
        },
      );
      setSent(`${sync.revision}:${sync.local_revision}:${sync.etag}`);
      onSaved();
    } catch (e) {
      showApiError(e);
      onSaved();
    } finally {
      setBusy(false);
    }
  }
  const period = (value: GoogleConflict["local"]) =>
    value.cancelled
      ? t("Cancelado")
      : new Intl.DateTimeFormat(locale, {
          timeZone: value.time_zone,
          dateStyle: "short",
          timeStyle: "short",
        }).formatRange(new Date(value.starts_at), new Date(value.ends_at));
  const c = sync.conflict;
  const motivoDaConexao = MOTIVO_DA_CONEXAO[sync.connection_status ?? ""];
  return (
    <section className="space-y-2 rounded-md border p-3" aria-label={t("Sincronização Google")}>
      <h3 className="text-sm font-medium">{t("Sincronização Google")}</h3>
      <p className="text-sm">
        {t(
          c
            ? "Este compromisso precisa de uma decisão de sincronização."
            : sync.pending
              ? "Há alterações aguardando sincronização."
              : sync.synced_at
                ? "Alterações sincronizadas."
                : "Ainda não publicado no Google.",
        )}
      </p>
      {sync.synced_at && (
        <p className="text-xs text-muted-foreground">
          {t("Última sincronização")}:{" "}
          {new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(
            new Date(sync.synced_at),
          )}
        </p>
      )}
      {sync.error && (
        <p role="alert" className="text-sm text-destructive">
          {sync.error}
        </p>
      )}
      {motivoDaConexao && (
        <p role="alert" className="text-sm text-destructive">
          {t(motivoDaConexao)}
        </p>
      )}
      {c && (
        <div className="space-y-2 text-sm" role="alert">
          <p>
            {t("Aqui")}: {period(c.local)}
          </p>
          <p>
            {t("No Google")}:{" "}
            {c.remote ? period(c.remote) : t("Evento indisponível ou incompatível")}
          </p>
          {!!c.groups.length && (
            <p>
              {t(
                "A publicação também substituiria campos alterados no Google. Revise antes de continuar.",
              )}
            </p>
          )}
          {["outcome", "series", "identity", "missing"].includes(c.reason) && (
            <p>
              {t(
                "Preservamos o histórico daqui. Revise o evento no Google ou crie outro compromisso pela Agenda.",
              )}
            </p>
          )}
          {sync.can_resolve && !["outcome", "series", "identity", "missing"].includes(c.reason) && (
            <div className="flex flex-wrap gap-2">
              {!c.groups.length && (
                <Button
                  variant="outline"
                  onClick={() => void decide("google")}
                  disabled={busy || !!c.resolution}
                >
                  {t(
                    c.remote?.cancelled ? "Usar cancelamento do Google" : "Usar horário do Google",
                  )}
                </Button>
              )}
              {!c.remote?.cancelled && (
                <Button
                  variant="outline"
                  onClick={() => void decide("local")}
                  disabled={busy || !!c.resolution}
                >
                  {t(c.groups.length ? "Publicar alteração daqui" : "Manter horário daqui")}
                </Button>
              )}
              {!!c.groups.length && (
                <Button
                  variant="outline"
                  onClick={() => void decide("preserve_remote")}
                  disabled={busy || !!c.resolution}
                >
                  {t("Preservar campos do Google")}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {((sent === `${sync.revision}:${sync.local_revision}:${sync.etag}` &&
        (sync.pending || !!sync.conflict)) ||
        c?.resolution) && (
        <p className="text-xs">
          {t(
            "Decisão registrada. O Google será relido antes de aplicar; mudanças novas exigem outra decisão.",
          )}
        </p>
      )}
      {!c && !motivoDaConexao && sync.can_resolve && (sync.error || sync.pending) && (
        <Button variant="outline" onClick={() => void decide("retry")} disabled={busy}>
          {t("Tentar sincronizar novamente")}
        </Button>
      )}
      <Link href="/app/settings/tenant/agenda" className="block text-xs underline">
        {t("Configurar suas agendas")}
      </Link>
    </section>
  );
}
