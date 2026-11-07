"use client";

import { useT } from "@/hooks/i18n/useT";

import { useSyncExternalStore } from "react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useNotificationPermission } from "@/hooks/notifications/useNotificationPermission";
import {
  NOTIFY_UI_CATEGORIES,
  assinarPrefs,
  getPrefsSnapshot,
  getPrefsSnapshotDoServidor,
  gravarCanal,
  type NotifyCategory,
  type NotifyChannelPref,
} from "@/lib/notifications/prefs";
import { syncPushSubscription } from "@/lib/notifications/push_client";

const LABELS: Record<NotifyCategory, string> = {
  handoff: "Conversa passada pela IA",
  message: "Nova mensagem",
  lead_assigned: "Lead atribuído a você",
  lead_won: "Lead ganho",
  lead_lost: "Lead perdido",
  mention: "Você foi mencionado",
};

export function NotificationPrefsClient() {
  const t = useT();
  const { permission, request } = useNotificationPermission();
  const prefs = useSyncExternalStore(assinarPrefs, getPrefsSnapshot, getPrefsSnapshotDoServidor);
  const denied = permission === "denied";
  const unsupported = permission === "unsupported";

  async function onToggle(category: NotifyCategory, channel: NotifyChannelPref, on: boolean) {
    if (channel === "push" && on) {
      if (permission !== "granted") {
        const next = await request();
        if (next !== "granted") return;
      }
    }
    gravarCanal(category, channel, on);
    // O servidor precisa saber: é ele quem manda (ou não) o push de mensagem.
    // A linha da IA inscreve o aparelho, com "Nova mensagem" do jeito que está.
    if ((category === "message" || category === "handoff") && channel === "push") {
      void syncPushSubscription();
    }
  }

  return (
    <Card className="p-0">
      <table className="w-full text-sm">
        <thead className="border-b">
          <tr>
            <th className="px-4 py-3 text-left font-medium">{t("Categoria")}</th>
            <th className="px-4 py-3 text-center font-medium">Email</th>
            <th className="px-4 py-3 text-center font-medium">In-app</th>
            <th className="px-4 py-3 text-center font-medium">Push</th>
          </tr>
        </thead>
        <tbody>
          {NOTIFY_UI_CATEGORIES.map((cat) => (
            <tr key={cat} className="border-b last:border-0">
              <td className="px-4 py-3">
                {t(LABELS[cat])}
                {cat === "handoff" && unsupported ? (
                  <p data-testid="push-sem-suporte" className="mt-1 text-xs text-muted-foreground">
                    {t(
                      "Este navegador não recebe avisos. No iPhone, adicione o site à Tela de Início (Compartilhar › Adicionar à Tela de Início) e abra por lá. Precisa do iOS 16.4 ou mais novo.",
                    )}
                  </p>
                ) : null}
                {(cat === "handoff" || cat === "message") && denied ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(
                      "O navegador bloqueou as notificações. Libere-as nas configurações do site e recarregue.",
                    )}
                  </p>
                ) : null}
              </td>
              <td className="px-4 py-3 text-center">
                <Switch checked={false} disabled aria-label={`${t(LABELS[cat])} via email`} />
              </td>
              <td className="px-4 py-3 text-center">
                {/* A conversa passada pela IA já aparece na Central: o in-app daqui não faria nada. */}
                <Switch
                  checked={cat === "handoff" ? false : prefs[cat].in_app}
                  disabled={cat === "handoff"}
                  onCheckedChange={(on) => void onToggle(cat, "in_app", on)}
                  aria-label={`${t(LABELS[cat])} via in_app`}
                />
              </td>
              <td className="px-4 py-3 text-center">
                {/* Ligada por padrão, mas só aparece ligada com a permissão do navegador:
                    é ligando-a que a pessoa chega ao "Permitir". */}
                <Switch
                  checked={cat === "handoff" ? prefs.handoff.push && permission === "granted" : prefs[cat].push}
                  disabled={denied || unsupported}
                  onCheckedChange={(on) => void onToggle(cat, "push", on)}
                  aria-label={`${t(LABELS[cat])} via push`}
                  data-testid={cat === "message" ? (prefs.message.push ? "alerts-toggle" : "alerts-enable") : undefined}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
