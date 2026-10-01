"use client";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { useCadastroIncorporado, type OfficialChannelState } from "@/hooks/channels/useOfficialChannel";
import { abrirCadastroIncorporado } from "@/lib/channels/meta/cadastro-incorporado-cliente";

export function CadastroIncorporado({ estado }: { estado: OfficialChannelState }) {
  const t = useT();
  const concluir = useCadastroIncorporado();
  const [abrindo, setAbrindo] = useState(false);
  const cfg = estado.cadastroIncorporado;
  if (!cfg) return null;

  if (!cfg.disponivel) {
    return (
      <Card className="p-4" data-testid="cadastro-incorporado-indisponivel">
        <h2 className="font-medium">{t("Conectar WhatsApp pelo botão")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Falta configurar na instalação:")} <span className="font-mono">{cfg.faltam.join(", ")}</span>.{" "}
          {t("Enquanto isso, use o formulário abaixo.")}
        </p>
        {cfg.configurarEm ? (
          <Link href={cfg.configurarEm} className="text-sm font-medium underline underline-offset-2">
            {t("Abrir API Oficial (Meta) na administração")}
          </Link>
        ) : null}
      </Card>
    );
  }

  async function conectar() {
    setAbrindo(true);
    try {
      const r = await abrirCadastroIncorporado({ appId: cfg!.appId!, configId: cfg!.configId!, versao: cfg!.versao });
      if (!r.ok) {
        if (r.motivo !== "cancelado") toast.error(t("Não deu para concluir o fluxo da Meta. Tente de novo."));
        return;
      }
      const resp = await concluir.mutateAsync({
        code: r.resultado.code,
        evento: r.resultado.evento,
        waba_id: r.resultado.wabaId,
        phone_number_id: r.resultado.phoneNumberId,
      });
      toast.success(`${t("Conectado:")} ${resp.data.displayName} ${resp.data.phoneNumber ?? ""}`.trim());
      if (resp.data.webhook?.assinado === false) {
        toast.warning(t("Conectado, mas a Meta não aceitou o endereço de recebimento. As mensagens não vão chegar."), {
          description: resp.data.webhook.motivo,
          duration: Infinity,
        });
      }
    } catch {
      /* o erro da API já foi mostrado por `showApiError` no hook */
    } finally {
      setAbrindo(false);
    }
  }

  return (
    <Card className="p-4" data-testid="cadastro-incorporado">
      <h2 className="font-medium">{estado.connected ? t("Reconectar pelo botão") : t("Conectar WhatsApp")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("Abre a janela da Meta. Para manter o número no WhatsApp Business do celular, escolha essa opção lá dentro.")}
      </p>
      <Button className="mt-3" onClick={conectar} disabled={abrindo || concluir.isPending} data-testid="btn-conectar-whatsapp">
        {abrindo || concluir.isPending ? t("Aguardando a Meta…") : t("Conectar WhatsApp")}
      </Button>
    </Card>
  );
}
