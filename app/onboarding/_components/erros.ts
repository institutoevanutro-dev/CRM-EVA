import { toast } from "sonner";

/**
 * Os erros do assistente em frase simples (auditoria 17/11, item 177).
 *
 * A tela mostrava o código cru ("Falha: forbidden", "Falha: db_error") e os
 * "Pular" falhavam calados. Aqui o código vira o que a pessoa pode fazer.
 */
export function fraseDoErro(codigo: string | undefined): string {
  switch (codigo) {
    case "auth_required":
      return "Sua sessão terminou. Entre de novo para continuar.";
    case "forbidden":
      return "Só quem administra a clínica pode fazer este passo.";
    case "no_active_org":
    case "not_found":
      return "Não achei a sua clínica. Recarregue a página.";
    case "invalid_input":
      return "Confira os campos e tente de novo.";
    default:
      return "Não consegui salvar agora. Tente de novo em instantes.";
  }
}

/** O `redirect()` de uma server action chega ao cliente como erro: deixe passar. */
export function ehRedirect(err: unknown): boolean {
  const digest = (err as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

/**
 * Roda um "Pular" (ou outra ação que só redireciona) e avisa se falhar.
 * O redirect segue adiante; qualquer outro erro vira um aviso em português.
 */
export async function rodarOuAvisar(
  acao: () => Promise<unknown>,
  t: (texto: string) => string,
  aviso = "Não consegui pular este passo. Tente de novo.",
): Promise<void> {
  try {
    await acao();
  } catch (err) {
    if (ehRedirect(err)) throw err;
    toast.error(t(aviso));
  }
}
