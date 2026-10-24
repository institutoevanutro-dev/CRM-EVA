"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

/** Quem aprovava saiu da equipe: o dono ou o platform admin toma a função para si. */
export function AssumirAprovacao({ userId }: { userId: string }) {
  const t = useT();
  const router = useRouter();
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function assumir() {
    setEnviando(true);
    setErro(null);
    try {
      await apiClient.put("/api/v1/bonus/programa", { aprovador_user_id: userId });
      router.refresh();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : t("Não foi possível salvar."));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-1">
      <Button className="self-start" size="sm" disabled={enviando} onClick={assumir}>
        {t("Assumir aprovação")}
      </Button>
      {erro ? <p className="text-sm text-destructive">{erro}</p> : null}
    </div>
  );
}
