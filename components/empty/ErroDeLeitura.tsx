"use client";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { Warning } from "@/lib/ui/icons";

/**
 * Falha ao ler do banco — e NÃO "não há nada aqui".
 *
 * As telas de IA tratavam a consulta que falhou como lista vazia: "Nenhuma
 * chave cadastrada ainda" com o banco fora do ar empurra quem administra a
 * cadastrar a chave de novo. O texto chega já traduzido de quem chama.
 *
 * Tons de erro, ícone e `role="alert"` para não parecer informação comum, e
 * "Tentar de novo" como saída: `router.refresh()` refaz a leitura do servidor
 * sem perder o que está na tela.
 */
export function ErroDeLeitura({ texto, testId = "erro-de-leitura" }: { texto: string; testId?: string }) {
  const t = useT();
  const router = useRouter();
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex flex-col items-center gap-3 rounded-lg border border-error/30 bg-error-bg p-6 text-center text-sm text-error-fg"
    >
      <Warning aria-hidden size={24} weight="duotone" />
      <p>{texto}</p>
      <Button type="button" size="sm" variant="outline" onClick={() => router.refresh()}>
        {t("Tentar de novo")}
      </Button>
    </div>
  );
}
