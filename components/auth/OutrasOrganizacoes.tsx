"use client";

import { useState } from "react";

import { setActiveOrg } from "@/app/actions/shell/setActiveOrg";
import { avisarOutrasAbas } from "@/components/shell/TenantSwitcher";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";

/**
 * As outras organizações de quem caiu numa tela de bloqueio (conta suspensa).
 * Sem isto, quem é de duas clínicas e tinha a suspensa ativa ficava preso: o
 * seletor mora na casca do app, que a suspensão não deixa abrir (auditoria
 * 17/11, item 54). Mesmo caminho do seletor: a ação confere o vínculo ativo de
 * novo, e um documento novo leva o resto.
 */
export function OutrasOrganizacoes({ organizacoes }: { organizacoes: { id: string; nome: string }[] }) {
  const t = useT();
  const [indo, setIndo] = useState<string | null>(null);
  const [falhou, setFalhou] = useState(false);
  if (organizacoes.length === 0) return null;

  const ir = async (id: string) => {
    setIndo(id);
    setFalhou(false);
    const r = await setActiveOrg(id).catch(() => ({ ok: false }));
    if (r.ok) {
      avisarOutrasAbas(id);
      window.location.assign("/app/inbox");
      return;
    }
    setIndo(null);
    setFalhou(true);
  };

  return (
    <div className="space-y-2 text-left">
      <p className="text-sm font-medium">{t("Abrir outra organização")}</p>
      {organizacoes.map((o) => (
        <Button
          key={o.id}
          type="button"
          variant="outline"
          className="w-full justify-start"
          disabled={indo !== null}
          onClick={() => void ir(o.id)}
        >
          <span className="truncate">{indo === o.id ? t("Abrindo…") : o.nome}</span>
        </Button>
      ))}
      {falhou && (
        <p role="alert" className="text-sm text-destructive">
          {t("Não foi possível abrir esta organização. Seu acesso pode ter mudado.")}
        </p>
      )}
    </div>
  );
}
