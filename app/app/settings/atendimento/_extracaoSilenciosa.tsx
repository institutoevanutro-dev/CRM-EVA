"use client";

/**
 * O INTERRUPTOR DA EXTRAÇÃO SILENCIOSA DE CADASTRO (migration 0407).
 *
 * Salva no clique, como o `TelefoneDeFichaVazia` ao lado: nada é reescrito em
 * nenhum dos dois sentidos — a opção é lida no ato, em cada mensagem que chega.
 * O texto diz o que NÃO acontece (não responde, não religa a IA, não troca o
 * que já está na ficha), porque é isso que quem liga precisa saber antes.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirExtracaoSilenciosa } from "@/app/actions/settings/definirExtracaoSilenciosa";
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

export function ExtracaoSilenciosa({
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
      const r = await definirExtracaoSilenciosa(novo);
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
          <Label htmlFor="extracao_silenciosa">
            {t("Ler o cadastro que o cliente manda nas conversas atendidas pela equipe")}
          </Label>
          <p className="max-w-2xl text-xs text-muted-foreground">
            {t(
              "Quando a equipe está atendendo e o cliente manda CPF, e-mail, data de nascimento ou endereço, o dado entra sozinho na ficha se o campo estiver vazio. Se a ficha já tem um valor diferente, nada é trocado: vira uma sugestão na ficha e um aviso na Central. Nenhuma mensagem é enviada ao cliente e a IA continua parada na conversa. Grupos, contatos bloqueados e contatos anonimizados ficam de fora. Vem desligada.",
            )}
          </p>
          <p className="max-w-2xl text-xs" data-testid="extracao-silenciosa-estado">
            {valor
              ? t("Ligado: os dados de cadastro das conversas da equipe preenchem a ficha vazia, com registro na linha do tempo.")
              : t("Desligado: ninguém lê os dados de cadastro das conversas atendidas pela equipe.")}
          </p>
          {!podeMudar && (
            <p className="text-xs text-muted-foreground">
              {t("Só um administrador da organização pode mudar esta opção.")}
            </p>
          )}
        </div>
        <Switch
          id="extracao_silenciosa"
          checked={valor}
          disabled={isPending || !podeMudar}
          onCheckedChange={mudar}
        />
      </div>
    </Card>
  );
}
