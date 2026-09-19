/**
 * BUSCAR CONTATO POR TEXTO LIVRE — as condições do `.or()`, num lugar só.
 *
 * ═══ POR QUE ISTO SAIU DE `contacts/_handler.ts` ═══
 *
 * A lista de contatos já tinha aprendido, a duras penas, que `display_name`
 * tem de estar no OR: contato que entra pelo WhatsApp nasce só com o pushName
 * em `display_name` e `name` nulo. A rota da agenda (`/api/v1/agenda/vinculos`)
 * nasceu depois, escreveu a própria busca, e escreveu a versão ANTIGA — só
 * `name.ilike`. Medido numa instalação real (2026-09-18): a busca de "Buscar
 * cliente" da marcação devolvia `contacts: []` para QUALQUER termo, inclusive
 * `a`, porque todos os contatos da base vinham do WhatsApp. Nenhum agendamento
 * podia ser vinculado a paciente — e sem vínculo o lembrete da agenda não tem
 * para quem ir.
 *
 * Duas buscas de contato que divergem não divergem por descuido: divergem
 * porque cada rota nova reescreve o filtro do jeito que parece certo naquele
 * arquivo. Esta função é a régua comum.
 *
 * ═══ O QUE ELA NÃO FAZ ═══
 *
 * - Não aplica o filtro: devolve as condições, e quem chama faz `.or(...)`.
 *   Assim cada rota mantém o próprio `organization_id`, a própria ordenação e o
 *   próprio limite — isolamento de tenant continua visível no handler.
 * - Não busca por CPF. O CPF entra como hash (`cpf_hash`) e só a lista de
 *   contatos o oferece; quem quiser acrescenta a condição por fora.
 * - Não ignora acento. `ilike` no Postgres distingue "Andre" de "André" — o
 *   mesmo comportamento da lista de contatos, que continua sendo a referência.
 */

import { phoneLookupVariants } from "@/lib/channels/phone-variants";

/**
 * Condições no DSL do PostgREST para `.or(condicoes.join(","))`.
 *
 * Devolve `[]` para termo vazio ou só com espaço: um `ilike '%%'` casaria a base
 * inteira, e "não digitei nada" não é "quero todo mundo".
 */
export function condicoesDaBuscaDeContato(termo: string): string[] {
  const bruto = termo.trim();
  if (bruto === "") return [];

  // ⚠️ `%` e `_` são curingas do LIKE, e `,`/`(`/`)` são delimitadores do DSL
  // do `.or()` — um nome com vírgula ("Silva, Maria") injetaria uma condição
  // extra na string do filtro. Mesmo escape de conversations/_handler.ts.
  const s = bruto.replace(/[%_]/g, (m) => `\\${m}`).replace(/[,()]/g, " ");
  const digits = bruto.replace(/\D/g, "");

  const condicoes = [
    `name.ilike.%${s}%`,
    // ⚠️ `display_name` é a coluna que a tela MOSTRA para quem veio do WhatsApp,
    // e a ÚNICA preenchida em boa parte da base. Buscar sem ela devolve zero
    // para quem existe. Quem decide o nome exibido é `nomeDoContato` /
    // `rotuloDoContato` (lib/contacts/rotulo-do-contato.ts); o que justifica a
    // coluna aqui não é a ordem de exibição, é a cobertura.
    `display_name.ilike.%${s}%`,
    `email.ilike.%${s}%`,
    `phone_number.ilike.%${s}%`,
  ];

  if (digits.length >= 8) {
    // 10/11 dígitos sem DDI: no Brasil é DDD+local. Sem o 55, `3284793302`
    // não gera a variante com o 9 e o cadastro `+5532984793302` some da busca.
    const base =
      !digits.startsWith("55") && (digits.length === 10 || digits.length === 11)
        ? `55${digits}`
        : digits;
    for (const v of phoneLookupVariants(base)) {
      const d = v.replace(/\D/g, "");
      if (d && d !== digits) condicoes.push(`phone_number.ilike.%${d}%`);
    }
  }

  return condicoes;
}
