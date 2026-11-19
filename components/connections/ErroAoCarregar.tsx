"use client";
import { Warning } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";

/**
 * Falha de leitura aparece como ERRO, com caminho de volta. Antes cada aba de
 * Conexões mostrava outro estado no lugar dele — o formulário de conectar (até
 * para quem já está conectado), "Não conectado" ou "Carregando…" para sempre
 * (auditoria 17/11, item 119).
 */
export function ErroAoCarregar({ texto, onTentar }: { texto: string; onTentar: () => void }) {
  const t = useT();
  return (
    <Card role="alert" className="flex flex-col items-center gap-3 p-8 text-center">
      <Warning size={28} className="text-error-fg" aria-hidden />
      <p className="text-sm text-error-fg">{texto}</p>
      <Button variant="outline" size="sm" onClick={onTentar}>
        {t("Tentar de novo")}
      </Button>
    </Card>
  );
}
