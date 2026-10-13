"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { roleAtLeast } from "@/lib/auth/types";
import { CircleNotch, FilePdf } from "@/lib/ui/icons";

/**
 * Baixa o histórico da conversa em PDF (porte do DeskcommCRM #2229, que entregou
 * a rota e deixou o botão por fazer).
 *
 * Só ícone, ao lado da busca: é ferramenta de leitura, não ação de atendimento,
 * e a barra de ações já estourou a largura do cabeçalho uma vez. Os 32px daqui
 * cabem na menor largura que os divisores da Inbox deixam.
 *
 * Quem não pode exportar não vê o botão. A regra de verdade é a da rota
 * (`requireRole("agent")` + RLS); esconder aqui é só não oferecer o que seria
 * recusado.
 */
export function ExportarConversaEmPdf({ conversationId }: { conversationId: string }) {
  const t = useT();
  const { user, activeOrg } = useAuth();
  const [baixando, setBaixando] = useState(false);

  if (user.support || !roleAtLeast(activeOrg?.role, "agent")) return null;

  async function baixar() {
    setBaixando(true);
    try {
      const res = await fetch(`/api/v1/conversations/${conversationId}/export?formato=pdf`, { cache: "no-store" });
      if (!res.ok) {
        // A rota já devolve a frase no idioma de quem está logado.
        const corpo = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        toast.error(corpo?.error?.message ?? t("Não foi possível gerar o PDF desta conversa."));
        return;
      }
      const nome = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1];
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = nome ?? "historico-conversa.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      // O Safari cancela o download se a URL some no mesmo tick do clique.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (res.headers.get("X-Export-Truncated") === "1") {
        toast.warning(t("A conversa é maior que o limite de um arquivo. O PDF traz só as mensagens mais recentes."));
      } else {
        toast.success(t("PDF da conversa baixado."));
      }
    } catch {
      toast.error(t("Não foi possível gerar o PDF desta conversa."));
    } finally {
      setBaixando(false);
    }
  }

  const rotulo = baixando ? t("Gerando o PDF da conversa...") : t("Baixar a conversa em PDF");
  return (
    <Button
      size="sm"
      variant="ghost"
      className="w-11 px-0 lg:w-8"
      onClick={baixar}
      disabled={baixando}
      aria-busy={baixando}
      aria-label={rotulo}
      title={rotulo}
      data-testid="exportar-conversa-pdf"
    >
      {baixando ? <CircleNotch size={16} className="animate-spin" aria-hidden /> : <FilePdf size={16} aria-hidden />}
    </Button>
  );
}
