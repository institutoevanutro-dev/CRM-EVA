"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";
import { SeloDoCanal } from "@/components/inbox/SeloDoCanal";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/**
 * POR QUAIS CANAIS ESTA PESSOA FALA — uma linha por conversa 1:1.
 *
 * Um contato pode ter uma conversa no WhatsApp e outra no Instagram (dois
 * perfis da clínica), e desde o merge de duplicados (Task 4) até DUAS
 * identidades do Instagram — uma por perfil que a pessoa escreveu. O
 * cabeçalho da ficha só mostra o telefone; sem esta lista não há como saber
 * que existe conversa no Instagram, nem qual @ e qual perfil da clínica.
 *
 * Ausência é normal (contato criado à mão, ou que só ligou): a seção não
 * aparece, em vez de um "sem canais" que ocuparia espaço para não dizer nada.
 */
export function CanaisDoContato({ contactId }: { contactId: string }) {
  const t = useT();
  const [conversas, setConversas] = useState<ConversationWithContact[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    setConversas([]);
    fetch(`/api/v1/conversations?contact_id=${contactId}&limit=50`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) return;
        const body = (await r.json()) as { data?: ConversationWithContact[] };
        if (!controller.signal.aborted) setConversas(body.data ?? []);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [contactId]);

  // Grupo não tem `contact_id` (SKIP CRM binding), então o filtro do backend já
  // os exclui — o `is_group` aqui é só uma segunda trava, defensiva.
  const canais = conversas.filter(
    (c): c is ConversationWithContact & { channel: "whatsapp" | "instagram" } =>
      !c.is_group && (c.channel === "whatsapp" || c.channel === "instagram"),
  );

  if (canais.length === 0) return null;

  return (
    <div className="space-y-2">
      <h2 className="text-xs uppercase text-muted-foreground">{t("Canais")}</h2>
      <ul className="space-y-1.5">
        {canais.map((conversa) => {
          const identidadesInstagram = (
            conversa.contacts?.contact_channel_identities ?? []
          ).filter((i) => i.channel === "instagram");
          const identidade =
            identidadesInstagram.find(
              (i) => i.external_id && i.external_id === conversa.provider_conversation_id,
            ) ?? identidadesInstagram[0];

          const identificador =
            conversa.channel === "instagram"
              ? identidade?.handle
                ? `@${identidade.handle}`
                : t("Instagram")
              : phoneForDisplay(conversa.contacts?.phone_number);

          const via =
            conversa.channel_sessions?.display_name ??
            phoneForDisplay(conversa.channel_sessions?.phone_number) ??
            "";

          return (
            <li key={conversa.id}>
              <Link
                href={`/app/inbox?id=${conversa.id}`}
                className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2 text-sm transition-colors hover:border-primary/40 hover:bg-muted"
              >
                <SeloDoCanal canal={conversa.channel} tamanho="pequeno" />
                <span className="font-medium">{identificador}</span>
                {via && (
                  <span className="text-xs text-muted-foreground">
                    {t("via")} {via}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
