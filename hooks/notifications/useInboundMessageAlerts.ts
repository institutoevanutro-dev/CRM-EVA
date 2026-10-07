"use client";

import { useCallback, useEffect } from "react";

import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { getOpenConversationId } from "@/hooks/notifications/OpenConversationContext";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { rotuloDoContato, SEM_NOME } from "@/lib/contacts/rotulo-do-contato";
import { marcarReleitura } from "@/lib/audit/releitura";
import { avatarUrlServivel } from "@/lib/notifications/avatar_url";
import { entregarAviso } from "@/lib/notifications/deliver";
import { shouldNotifyInbound } from "@/lib/notifications/policy";
import { syncPushSubscription } from "@/lib/notifications/push_client";

function tabFocused(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
}

/** postgres_changes entrega `{ new }`; alguns mocks aninham em `payload`. */
function rowFromRealtime(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as {
    tipo?: unknown;
    new?: unknown;
    record?: unknown;
    payload?: { new?: unknown };
  };
  if (p.tipo === "reassinado") return null;
  const raw = p.new ?? p.record ?? p.payload?.new;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function previewFromMessage(row: { type?: unknown; body?: unknown }): string {
  if (row.type !== "text") return "Mídia";
  const body = typeof row.body === "string" ? row.body.trim() : "";
  return body || "Nova mensagem";
}

/**
 * ⚠️ POR QUE ESTA LEITURA PASSA PELA ROTA, E NÃO PELO SUPABASE DO BROWSER.
 *
 * Isto já foi um `createClient().from("contacts").select(...)`: o client do
 * browser não enxerga a sessão (cookie httpOnly — ver `lib/supabase/browser.ts`),
 * o select saía como `anon` e a RLS respondia ZERO LINHAS, sem erro. O título
 * caía sempre em "Nova mensagem". A rota autentica no servidor, como a busca do
 * avatar logo abaixo. (Porte do DeskcommCRM aea803e1c.)
 *
 * `?atualizacao=1`: o aviso não é a pessoa ABRINDO a ficha do contato. Sem a
 * marca, cada mensagem que chega gravaria um `contact.viewed` falso na trilha
 * de leitura (`lib/audit/releitura.ts`).
 */
async function contatoDaRota(contactId: string): Promise<Record<string, unknown> | null> {
  try {
    const qs = marcarReleitura(new URLSearchParams(), true);
    const r = await fetch(`/api/v1/contacts/${contactId}?${qs.toString()}`, { credentials: "include" });
    if (!r.ok) return null;
    const dado = ((await r.json()) as { data?: unknown }).data;
    if (!dado || typeof dado !== "object" || Array.isArray(dado)) return null;
    return dado as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function contactNotifyBits(contactId: string): Promise<{ title: string; icon?: string }> {
  const row = await contatoDaRota(contactId);
  // A mesma regra do push do servidor (`push.handler.ts`): nome, senão o
  // telefone; identificador técnico nunca. Sem nenhum dos dois, o literal.
  const rotulo = row ? rotuloDoContato(row as Parameters<typeof rotuloDoContato>[0]) : SEM_NOME;
  const title = rotulo === SEM_NOME ? "Nova mensagem" : rotulo;
  let icon: string | undefined;
  try {
    const r = await fetch(`/api/v1/contacts/${contactId}/avatar`, {
      credentials: "include",
      redirect: "follow",
    });
    icon = r.ok ? avatarUrlServivel(r.url, window.location.origin) : undefined;
  } catch {
    // sem foto: badge da marca
  }
  return { title, icon };
}

async function contactIdFromRow(
  row: Record<string, unknown>,
  conversationId: string | null,
): Promise<string | null> {
  if (typeof row.contact_id === "string") return row.contact_id;
  if (!conversationId) return null;
  // Mesmo motivo de `contatoDaRota`: pelo client do browser este select voltava
  // vazio SEM erro. A rota autentica no servidor.
  try {
    const r = await fetch(`/api/v1/conversations/${conversationId}`, { credentials: "include" });
    if (!r.ok) return null;
    const c = ((await r.json()) as { data?: { contact_id?: string | null } | null }).data;
    return typeof c?.contact_id === "string" ? c.contact_id : null;
  } catch {
    return null;
  }
}

export function useInboundMessageAlerts(): void {
  const orgId = useActiveOrg()?.orgId ?? null;

  useEffect(() => {
    if (!orgId) return;
    void syncPushSubscription();
  }, [orgId]);

  const onChange = useCallback((payload: unknown) => {
    const row = rowFromRealtime(payload);
    if (!row) return;
    const conversationId = typeof row.conversation_id === "string" ? row.conversation_id : null;
    const direction = typeof row.direction === "string" ? row.direction : null;
    if (
      !shouldNotifyInbound({
        direction,
        conversationId,
        openConversationId: getOpenConversationId(),
        tabFocused: tabFocused(),
        tipo: (payload as { tipo?: unknown }).tipo,
      })
    ) {
      return;
    }
    void (async () => {
      const contactId = await contactIdFromRow(row, conversationId);
      const bits = contactId
        ? await contactNotifyBits(contactId)
        : { title: "Nova mensagem" as const, icon: undefined };
      entregarAviso({
        category: "message",
        kind: "message_inbound",
        title: bits.title,
        body: previewFromMessage(row),
        tag: conversationId ?? undefined,
        href: conversationId ? `/app/inbox?id=${conversationId}` : undefined,
        icon: bits.icon,
      });
    })();
  }, []);

  useRealtimeChannel({
    name: orgId ? `alerts-messages-${orgId}` : "alerts-messages-disabled",
    postgresChanges: orgId
      ? {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `organization_id=eq.${orgId}`,
        }
      : undefined,
    onChange,
    enabled: !!orgId,
  });
}
