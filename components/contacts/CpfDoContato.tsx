"use client";

/**
 * O CPF na ficha do contato — guardado cifrado, revelado sob pedido.
 *
 * O número NÃO vem no carregamento da ficha: a resposta normal traz só
 * `cpf_available`. Quem clica em "Ver" faz uma segunda chamada com o cabeçalho
 * `X-Decrypt-Purpose`, e é ESSA chamada que o servidor decifra e registra em
 * `api_audit_log` (`contact.cpf_viewed`). Duas razões para não vir sempre:
 * ninguém precisa do CPF para ler uma conversa, e um registro que dissesse
 * "abriu a ficha" não responde quem consultou o dado sensível.
 *
 * Visualizador não tem o botão — o servidor recusaria de todo jeito
 * (`cpf_decrypt_denied`), e oferecer um botão que sempre falha é pior que não
 * oferecer. A checagem que vale é a do servidor; esta aqui é cortesia.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  contactId: string;
  /** A ficha tem CPF guardado (o número não vem no carregamento). */
  disponivel: boolean;
  /** Papel do usuário alcança atendente ou acima. */
  podeVer: boolean;
}

/** 529.982.247-25 — só para exibir; o dado gravado são os 11 dígitos. */
function formatarCpf(digitos: string): string {
  const d = digitos.replace(/\D/g, "");
  if (d.length !== 11) return digitos;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

export function CpfDoContato({ contactId, disponivel, podeVer }: Props) {
  const t = useT();
  const [cpf, setCpf] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  if (!disponivel) return <span className="text-muted-foreground">—</span>;

  if (cpf) {
    return (
      <span className="flex flex-wrap items-baseline gap-2">
        <span data-testid="cpf-revelado" className="tabular-nums">
          {formatarCpf(cpf)}
        </span>
        <span className="text-xs text-muted-foreground">{t("consulta registrada")}</span>
      </span>
    );
  }

  if (!podeVer) {
    return <span className="text-muted-foreground">{t("cadastrado")}</span>;
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <span aria-hidden className="tabular-nums text-muted-foreground">
        •••.•••.•••-••
      </span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 px-2"
        disabled={carregando}
        onClick={async () => {
          setCarregando(true);
          try {
            const r = await apiClient.get<{ data: { cpf_decrypted?: string | null } }>(
              `/api/v1/contacts/${contactId}`,
              { headers: { "X-Decrypt-Purpose": "ficha do contato" } },
            );
            const valor = r.data.cpf_decrypted;
            if (valor) setCpf(valor);
            else showApiError(new Error(t("Não foi possível ler o CPF desta ficha.")));
          } catch (err) {
            showApiError(err);
          } finally {
            setCarregando(false);
          }
        }}
      >
        {carregando ? t("Abrindo…") : t("Ver CPF")}
      </Button>
    </span>
  );
}
