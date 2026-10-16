import { resolveField } from "@/lib/automation/conditions";

const ALIASES: Record<string, string> = {
  nome: "contact.name",
  primeiro_nome: "contact.name",
  telefone: "contact.phone_number",
  email: "contact.email",
};

/**
 * `formatarValor` recebe cada VALOR já resolvido, nunca o template: quem
 * renderiza para HTML escapa o que veio do contato ou do negócio e mantém a
 * marcação que o operador escreveu (porte do upstream #2794).
 */
export function renderTemplate(
  template: string,
  context: Record<string, unknown>,
  formatarValor: (valor: string) => string = (valor) => valor,
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const resolved = resolveField(context, ALIASES[path] ?? path);
    // `{{primeiro_nome}}` = primeira palavra do nome, como no Inbox e na campanha.
    const texto = String(resolved ?? "");
    return formatarValor(path === "primeiro_nome" ? (texto.trim().split(/\s+/)[0] ?? "") : texto);
  });
}
