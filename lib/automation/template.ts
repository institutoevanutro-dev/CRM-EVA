import { resolveField } from "@/lib/automation/conditions";
import { nomeDoContato, type ContatoNomeavel } from "@/lib/contacts/rotulo-do-contato";
import { semAVariavel } from "@/lib/inbox/template-vars";

const ALIASES: Record<string, string> = {
  telefone: "contact.phone_number",
  email: "contact.email",
};

/** As marcações que falam com a pessoa pelo nome. */
const DO_NOME = new Set(["nome", "primeiro_nome", "contact.name"]);

/**
 * Onde o nome faltou. NUL não cabe num `text` do Postgres, então nenhum valor
 * vindo do banco o contém: a marca não colide com dado do contato.
 */
const NOME_AUSENTE = "\u0000";

/**
 * `formatarValor` recebe cada VALOR já resolvido, nunca o template: quem
 * renderiza para HTML escapa o que veio do contato ou do negócio e mantém a
 * marcação que o operador escreveu (porte do upstream #2794).
 *
 * O nome segue a régua única de nome de gente (`nomeDoContato`): o cadastrado,
 * depois o do perfil do WhatsApp, nunca um identificador técnico. Contato que
 * chega pelo WhatsApp tem `name` nulo, e ler só `contact.name` dava "Olá , ..."
 * no primeiro contato (porte do upstream #2374). Sem nome nenhum, a marcação sai
 * com a pontuação em volta, pela mesma régua do follow-up (`semAVariavel`):
 * "Olá {{nome}}, tudo bem?" vira "Olá, tudo bem?".
 */
export function renderTemplate(
  template: string,
  context: Record<string, unknown>,
  formatarValor: (valor: string) => string = (valor) => valor,
): string {
  let saida = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    if (DO_NOME.has(path)) {
      const nome = nomeDoContato(context.contact as ContatoNomeavel | undefined) ?? "";
      // `{{primeiro_nome}}` = primeira palavra do nome, como no Inbox e na campanha.
      const valor = path === "primeiro_nome" ? (nome.split(/\s+/)[0] ?? "") : nome;
      return valor === "" ? NOME_AUSENTE : formatarValor(valor);
    }
    return formatarValor(String(resolveField(context, ALIASES[path] ?? path) ?? ""));
  });
  for (let i = saida.indexOf(NOME_AUSENTE); i !== -1; i = saida.indexOf(NOME_AUSENTE)) {
    saida = semAVariavel(saida, i, NOME_AUSENTE.length);
  }
  return saida;
}
