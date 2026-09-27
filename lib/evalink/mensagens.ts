/** Mensagens da tela de login para os motivos de `?evalink=` devolvidos por /evalink/volta. */
export const MENSAGENS_EVALINK: Record<string, string> = {
  falhou: "Não foi possível entrar pelo EvaLink.",
  conflito:
    "Seu e-mail já tem cadastro aqui. Peça ao administrador para ligar sua conta ao EvaLink.",
  sem_organizacao:
    "Você não está em nenhuma organização deste CRM. Fale com o administrador.",
  ultimo_admin:
    "O CRM precisa de pelo menos um administrador em cada organização. Na Conta, mantenha seu papel como administrador ou dê esse papel a outra pessoa antes.",
};

/**
 * Só devolve mensagem para string que é chave própria do objeto (`Object.hasOwn`,
 * não `in`): protege contra `"constructor"`, `"__proto__"`, `"toString"` e afins,
 * que existem em qualquer objeto JS mas não são um motivo válido.
 */
export function mensagemDoEvalink(v: unknown): string | undefined {
  return typeof v === "string" && Object.hasOwn(MENSAGENS_EVALINK, v)
    ? MENSAGENS_EVALINK[v]
    : undefined;
}
