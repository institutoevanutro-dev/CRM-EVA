"use client";

import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";

/**
 * O aviso das telas de marca com `CONTA_URL` ligada (Plano 6): nome, cor e logo
 * da clínica são editados na Conta Eva Link, e o CRM só os lê. Uma peça para as
 * duas telas (`/admin/marca` e Configurações › Marca), para o texto não divergir.
 */
export function AvisoDaMarcaNaConta({ contaUrl }: { contaUrl: string }) {
  const t = useT();
  return (
    <Card data-aviso-marca-na-conta className="space-y-2 p-6">
      <p className="text-sm font-semibold text-text">
        {t("A marca da clínica é configurada na Conta Eva Link")}
      </p>
      <p className="text-sm text-text-muted">
        {t("Nome, cor e logo são lidos de lá e aparecem aqui sozinhos pouco depois de salvos.")}
      </p>
      <a
        href={`${contaUrl}/admin/marca`}
        target="_blank"
        rel="noopener"
        className="inline-block text-sm font-medium text-accent underline underline-offset-4"
      >
        {t("Abrir a marca na Conta Eva Link")}
      </a>
    </Card>
  );
}
