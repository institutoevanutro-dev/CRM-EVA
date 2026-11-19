"use client";

/**
 * O SEGUNDO INTERRUPTOR, ao lado do telefone (`_telefoneDeFichaVazia.tsx`):
 * nome completo, CPF, e-mail, nascimento e endereço ditos ao assistente entram
 * sozinhos no campo VAZIO da ficha, ou esperam uma pessoa. Mesma forma e mesmo
 * gate; salva no clique.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirCadastroDeFichaVazia } from "@/app/actions/settings/definirCadastroDeFichaVazia";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

const ERRO: Record<string, string> = {
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um administrador da organização pode mudar esta opção.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
};

export function CadastroDeFichaVazia({
  ligada,
  idioma,
  podeMudar,
}: {
  ligada: boolean;
  idioma: Idioma;
  /** Espelha o `admin` que a action cobra. Cortesia, não autorização. */
  podeMudar: boolean;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [valor, setValor] = useState(ligada);
  const [isPending, startTransition] = useTransition();

  function mudar(novo: boolean) {
    setValor(novo);
    startTransition(async () => {
      const r = await definirCadastroDeFichaVazia(novo);
      if (r.ok) {
        setValor(r.ligado);
        toast.success(t("Opção salva."));
        router.refresh();
        return;
      }
      setValor(!novo);
      toast.error(t(ERRO[r.error] ?? "Não consegui salvar agora."));
    });
  }

  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="cadastro_de_ficha_vazia">
            {t("Dados de cadastro informados ao assistente entram sozinhos na ficha vazia")}
          </Label>
          <p className="max-w-2xl text-xs text-muted-foreground">
            {t(
              "Quando o cliente diz ao assistente o nome completo, o CPF, o e-mail, a data de nascimento ou o endereço, o dado é gravado na hora se aquele campo da ficha estiver vazio, e aparece na linha do tempo do contato quando ele tem um negócio aberto. O que já está preenchido nunca é trocado: continua esperando uma pessoa conferir. Vem desligada.",
            )}
          </p>
          <p className="max-w-2xl text-xs" data-testid="cadastro-de-ficha-vazia-estado">
            {valor
              ? t("Ligado: os dados de cadastro ditos ao assistente preenchem os campos vazios da ficha.")
              : t("Desligado: os dados de cadastro ditos ao assistente viram proposta para alguém conferir.")}
          </p>
          {!podeMudar && (
            <p className="text-xs text-muted-foreground">
              {t("Só um administrador da organização pode mudar esta opção.")}
            </p>
          )}
        </div>
        <Switch
          id="cadastro_de_ficha_vazia"
          checked={valor}
          disabled={isPending || !podeMudar}
          onCheckedChange={mudar}
        />
      </div>
    </Card>
  );
}
