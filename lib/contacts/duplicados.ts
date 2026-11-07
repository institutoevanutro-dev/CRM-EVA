/**
 * Contatos duplicados — quem é a MESMA pessoa cadastrada duas vezes.
 *
 * ─── Por que isto não é código morto num banco com índice único ─────────────
 * `contacts` tem três índices ÚNICOS PARCIAIS — telefone, e-mail normalizado e
 * hash de CPF — todos com `where ... and is_merged_into is null`. Num banco
 * saudável, portanto, duas linhas ATIVAS nunca repetem a MESMA string. A
 * duplicata real chega por dois caminhos que o índice não vê:
 *
 *  1. **Grafias diferentes do mesmo número.** `+553198966398` (12 dígitos, como
 *     o WhatsApp às vezes entrega o `wa_id`) e `+5531998966398` (13, como o
 *     brasileiro digita) são strings distintas para o Postgres e a mesma pessoa
 *     para o mundo. É o nono dígito, já tratado em `lib/channels/phone-variants`.
 *  2. **O conflito que a ingestão PARKOU de propósito.** Quando o webhook do
 *     WhatsApp descobre que o contato @lid tem um telefone que já pertence a
 *     outro contato vivo, `fn_upsert_wa_contact` não funde — grava o número em
 *     `source_metadata.telefone_em_conflito` e, nas palavras da própria
 *     migration, "a decisão de fundir fica para quem opera". Este módulo é o que
 *     leva essa decisão até quem opera.
 *
 * A igualdade EXATA continua sendo procurada porque o índice único é criado com
 * `if not exists` e o `update.sh` do clone roda **sem** `ON_ERROR_STOP`: numa
 * instalação onde a criação falhou (dados já duplicados na época), o índice
 * simplesmente não existe e a duplicata exata é possível. Procurar por ela custa
 * seis linhas e é a única coisa que enxerga esse clone. Vale igual para o
 * `uniq_contacts_org_cpf` sobre `cpf_hash` (porte do original #4104): o CPF entra
 * aqui pelo mesmo argumento do telefone e do e-mail.
 *
 * O `cpf_hash` é PII derivada: entra na comparação e NÃO sai na resposta da
 * rota. Desde a 0289 `authenticated` não lê a coluna; quem a traz é o servidor
 * (`app/api/v1/contacts/duplicates/route.ts`), filtrado pela organização.
 *
 * ─── Nome parecido: sugestão, não igualdade (porte do #3640) ────────────────
 * Tudo acima é IGUALDADE (o mesmo número, o mesmo e-mail). `nome_parecido` não
 * é: o nome sugere, não prova — pode ser outra pessoa com nome parecido, como
 * alguém da mesma família. Por isso `encontrarParecidosPorNome` entrega pares
 * separados dos grupos fortes, só para gestor, e a tela os mostra em
 * "Parecidos — confira", com a comparação lado a lado antes de qualquer ação.
 *
 * ─── Vocabulário ────────────────────────────────────────────────────────────
 * Contato é contato em todo nicho — não passa pelo `vocabulary` do funil, que
 * renomeia lead/deal/won/lost. Nada aqui conhece "Paciente", "Cliente" ou etapa.
 */
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";

/** Por que estes dois registros caíram no mesmo grupo. `nome_parecido` é o único que não é igualdade. */
export type MotivoDeDuplicidade =
  | "telefone"
  | "email"
  | "telefone_em_conflito"
  | "cpf"
  | "mesmo_nome_instagram_whatsapp"
  | "nome_parecido";

/**
 * O recorte de `contacts` que a detecção precisa. Deliberadamente menor que
 * `Contact`: a detecção é pura e roda igual no servidor e no teste.
 */
export interface ContatoParaDeduplicar {
  id: string;
  name: string | null;
  display_name: string | null;
  email: string | null;
  email_normalized: string | null;
  phone_number: string | null;
  /**
   * HMAC do CPF (`lib/contacts/cpf.ts`, 0289). Obrigatório no recorte de
   * propósito: quem monta um contato para deduplicar tem de dizer o que sabe do
   * CPF. `null`/vazio nunca casa: vazio não é documento.
   */
  cpf_hash: string | null;
  is_merged_into: string | null;
  is_anonymized: boolean;
  source_metadata: Record<string, unknown> | null;
  created_at: string;
  last_activity_at: string | null;
  /** Tem identidade de Instagram em `contact_channel_identities` (linha desse canal). */
  do_instagram: boolean;
}

export interface GrupoDeDuplicados {
  /** Estável entre chamadas: o menor id do grupo. Serve de `key` de lista. */
  chave: string;
  motivos: MotivoDeDuplicidade[];
  /** Ordenado: o mais antigo primeiro — é o candidato natural a principal. */
  contatos: ContatoParaDeduplicar[];
}

/** Chave de agrupamento por telefone: a forma canônica de CRM (BR com o nono). */
export function chaveDeTelefone(valor: string | null | undefined): string {
  if (!valor || !valor.trim()) return "";
  const canonico = canonicalPhoneBR(valor);
  return canonico.replace(/\D/g, "");
}

/**
 * Chave de agrupamento por e-mail, para o clone sem índice único. O tipo é o
 * recorte mínimo: a dispensa (`dispensar-par.ts`) lê só estes campos do SQL.
 */
export function chaveDeEmail(contato: Pick<ContatoParaDeduplicar, "email" | "email_normalized">): string {
  const bruto = contato.email_normalized ?? contato.email;
  return (bruto ?? "").trim().toLowerCase();
}

/**
 * Chave de agrupamento por nome: NFD sem diacríticos, minúsculas, espaços
 * colapsados. `null` para nome ausente ou de uma palavra só — "Ana" é comum
 * demais para virar sinal de duplicidade sozinho.
 */
export function chaveDeNome(nome: string | null): string | null {
  if (!nome) return null;
  const normalizado = nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
  if (normalizado.split(" ").filter(Boolean).length < 2) return null;
  return normalizado;
}

/** O telefone que a ingestão parkou por já pertencer a outro contato vivo. */
export function telefoneEmConflito(contato: Pick<ContatoParaDeduplicar, "source_metadata">): string {
  const valor = contato.source_metadata?.["telefone_em_conflito"];
  return typeof valor === "string" ? chaveDeTelefone(valor) : "";
}

/**
 * Chave de agrupamento por CPF: o índice que a gravação calculou. `""` e `null`
 * são a AUSÊNCIA de documento; tratá-los como chave agruparia todas as fichas sem
 * CPF numa só. Quem chama descarta a chave vazia.
 */
export function chaveDeCpf(contato: Pick<ContatoParaDeduplicar, "cpf_hash">): string {
  return (contato.cpf_hash ?? "").trim();
}

/**
 * Um contato só é candidato se está VIVO.
 *
 * `is_merged_into` já resolvido sai porque a fusão dele acabou. Anonimizado sai
 * porque L-04 é irreversível: reencaixar a linha anonimizada num contato ativo
 * a traria de volta ao atendimento pela porta dos fundos.
 */
export function elegivelParaMesclagem(contato: ContatoParaDeduplicar): boolean {
  return contato.is_merged_into === null && !contato.is_anonymized;
}

/**
 * Agrupa os contatos em componentes conexos sobre "é a mesma pessoa".
 *
 * Componente conexo, e não um grupo por critério, porque os critérios se
 * encadeiam: A e B compartilham o telefone, B e C o e-mail — os três são a mesma
 * pessoa e oferecer duas fusões separadas produziria a segunda já inválida (a
 * primeira teria mesclado B). Union-find resolve isso em uma passada.
 */
export function encontrarContatosDuplicados(
  contatos: ContatoParaDeduplicar[],
): GrupoDeDuplicados[] {
  const vivos = contatos.filter(elegivelParaMesclagem);

  const pai = new Map<string, string>();
  const motivosPorAresta = new Map<string, Set<MotivoDeDuplicidade>>();
  for (const contato of vivos) pai.set(contato.id, contato.id);

  const raiz = (id: string): string => {
    let atual = id;
    while (pai.get(atual) !== atual) {
      const acima = pai.get(atual)!;
      pai.set(atual, pai.get(acima)!);
      atual = pai.get(atual)!;
    }
    return atual;
  };
  const unir = (a: string, b: string, motivo: MotivoDeDuplicidade) => {
    const ra = raiz(a);
    const rb = raiz(b);
    const alvo = ra < rb ? ra : rb;
    const outro = ra < rb ? rb : ra;
    if (ra !== rb) pai.set(outro, alvo);
    for (const id of [a, b]) {
      const conjunto = motivosPorAresta.get(id) ?? new Set<MotivoDeDuplicidade>();
      conjunto.add(motivo);
      motivosPorAresta.set(id, conjunto);
    }
  };

  const porTelefone = new Map<string, string[]>();
  const porEmail = new Map<string, string[]>();
  const porCpf = new Map<string, string[]>();
  for (const contato of vivos) {
    const telefone = chaveDeTelefone(contato.phone_number);
    if (telefone) porTelefone.set(telefone, [...(porTelefone.get(telefone) ?? []), contato.id]);
    const email = chaveDeEmail(contato);
    if (email) porEmail.set(email, [...(porEmail.get(email) ?? []), contato.id]);
    // Chave vazia não entra: `null === null` agruparia todas as fichas sem CPF.
    const cpf = chaveDeCpf(contato);
    if (cpf) porCpf.set(cpf, [...(porCpf.get(cpf) ?? []), contato.id]);
  }

  for (const ids of porTelefone.values()) {
    for (let i = 1; i < ids.length; i++) unir(ids[0]!, ids[i]!, "telefone");
  }
  for (const ids of porEmail.values()) {
    for (let i = 1; i < ids.length; i++) unir(ids[0]!, ids[i]!, "email");
  }
  for (const ids of porCpf.values()) {
    for (let i = 1; i < ids.length; i++) unir(ids[0]!, ids[i]!, "cpf");
  }
  for (const contato of vivos) {
    const conflito = telefoneEmConflito(contato);
    if (!conflito) continue;
    for (const outroId of porTelefone.get(conflito) ?? []) {
      if (outroId !== contato.id) unir(contato.id, outroId, "telefone_em_conflito");
    }
  }

  // Instagram × WhatsApp pelo nome: só contatos COM telefone entram no mapa de
  // nomes (regra de hoje — dois com telefone e mesmo nome não agrupam), e só
  // contatos SÓ-Instagram (sem telefone) se anexam a eles — e só quando há
  // EXATAMENTE UM contato de telefone com aquele nome: com dois "Maria Silva"
  // no WhatsApp não dá para dizer qual é a do Instagram. Dois de Instagram
  // com o mesmo nome não agrupam aqui — a junção deles é por @ (Task 4).
  const porNome = new Map<string, string[]>();
  for (const contato of vivos) {
    if (contato.phone_number === null || contato.phone_number === "") continue;
    const nome = chaveDeNome(nomeDoContato(contato));
    if (!nome) continue;
    porNome.set(nome, [...(porNome.get(nome) ?? []), contato.id]);
  }
  for (const contato of vivos) {
    if (!contato.do_instagram || contato.phone_number) continue;
    const nome = chaveDeNome(nomeDoContato(contato));
    if (!nome) continue;
    const comTelefone = porNome.get(nome) ?? [];
    if (comTelefone.length === 1) unir(contato.id, comTelefone[0]!, "mesmo_nome_instagram_whatsapp");
  }

  const grupos = new Map<string, ContatoParaDeduplicar[]>();
  for (const contato of vivos) {
    const r = raiz(contato.id);
    grupos.set(r, [...(grupos.get(r) ?? []), contato]);
  }

  return [...grupos.entries()]
    .filter(([, membros]) => membros.length > 1)
    .map(([chave, membros]) => {
      const ordenados = [...membros].sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
      );
      const motivos = new Set<MotivoDeDuplicidade>();
      for (const membro of ordenados) {
        for (const motivo of motivosPorAresta.get(membro.id) ?? []) motivos.add(motivo);
      }
      return {
        chave,
        motivos: [...motivos].sort(),
        contatos: ordenados,
      };
    })
    .sort((a, b) => a.chave.localeCompare(b.chave));
}

/**
 * Quem o produto sugere manter: o contato com atividade mais recente e, no
 * empate, o mais antigo. Atividade recente é o que o atendente tem aberto na
 * frente; a antiguidade desempata sem sortear.
 *
 * No par Instagram × WhatsApp, o contato COM telefone vem antes de tudo:
 * `fn_mesclar_contatos` descarta CPF, consentimento e `custom_fields` do
 * secundário, e é o registro do WhatsApp que costuma carregá-los.
 *
 * É SUGESTÃO — quem decide é quem opera, na tela. Nunca aplicada sozinha.
 */
export function principalSugerido(grupo: GrupoDeDuplicados): string {
  const telefonePrimeiro = grupo.motivos.includes("mesmo_nome_instagram_whatsapp");
  const ordenado = [...grupo.contatos].sort((a, b) => {
    if (telefonePrimeiro) {
      const temTelefone = Number(Boolean(b.phone_number)) - Number(Boolean(a.phone_number));
      if (temTelefone !== 0) return temTelefone;
    }
    const atividade = (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? "");
    if (atividade !== 0) return atividade;
    return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  });
  return ordenado[0]!.id;
}

/*
 * ─── Nome parecido (porte do #3640) ─────────────────────────────────────────
 *
 * O nome sozinho junta gente diferente: o sobrenome comum casa com meia base.
 * A régua é de RARIDADE — só conta a palavra que aparece em poucas fichas — e
 * cada ficha só se compara com as fichas das palavras raras dela, então não há
 * laço O(n²) sobre a base. Endereço, site e rede não geram sugestão.
 */

/** Rara = aparece em até 3 fichas varridas. Base maior dá menos pares, nunca mais. */
export const TETO_DA_PALAVRA_RARA = 3;

/** Palavras de ligação e títulos: não distinguem uma pessoa de outra. */
const PALAVRAS_DE_LIGACAO = new Set(["de", "da", "do", "das", "dos", "e", "em", "a", "o", "dr", "dra"]);

/** O nome inteiro contido no outro só vale com este tamanho mínimo, em letras. */
const LETRAS_MINIMAS_DO_NOME_CONTIDO = 6;

/**
 * As palavras que comparam dois nomes: minúsculas, sem acento, sem pontuação,
 * sem palavra de ligação, sem repetição e sem palavra de uma letra — uma
 * inicial ("Fernanda B. Tavares") seria rara sem distinguir ninguém.
 */
export function palavrasDoNome(nome: string): string[] {
  const normal = nome.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  const vistas = new Set<string>();
  for (const palavra of normal.split(/[^\p{L}\p{N}]+/u)) {
    if (palavra.length < 2 || PALAVRAS_DE_LIGACAO.has(palavra)) continue;
    vistas.add(palavra);
  }
  return [...vistas];
}

/**
 * A chave de um PAR: os dois ids em ordem crescente, unidos por `:`. A-B e B-A
 * são o mesmo par — a mesma forma em que a dispensa grava
 * `merge_queue.candidates`.
 */
export function parDeContatos(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Os dois já estão ligados por motivo FORTE (mesmo telefone, mesmo e-mail, mesmo
 * CPF, ou o telefone em conflito de um apontando para o outro). Par assim não é
 * sugestão de nome e não se dispensa: junta-se. Quem lê o par do banco tem de
 * trazer `cpf_hash`; a comparação exige chave não vazia, então a coluna ausente
 * nunca liga um par por acidente.
 */
type LadoDoPar = Pick<
  ContatoParaDeduplicar,
  "phone_number" | "email" | "email_normalized" | "cpf_hash" | "source_metadata"
>;
export function ligadosPorMotivoForte(a: LadoDoPar, b: LadoDoPar): boolean {
  const telefoneA = chaveDeTelefone(a.phone_number);
  const telefoneB = chaveDeTelefone(b.phone_number);
  if (telefoneA && telefoneA === telefoneB) return true;
  const emailA = chaveDeEmail(a);
  if (emailA && emailA === chaveDeEmail(b)) return true;
  const cpfA = chaveDeCpf(a);
  if (cpfA && cpfA === chaveDeCpf(b)) return true;
  const conflitoA = telefoneEmConflito(a);
  if (conflitoA && conflitoA === telefoneB) return true;
  const conflitoB = telefoneEmConflito(b);
  return Boolean(conflitoB && conflitoB === telefoneA);
}

/**
 * Pares de fichas que parecem a mesma pessoa pelo NOME. Cada par é uma
 * sugestão separada (não é union-find: A~B e B~C são duas decisões). Quem já
 * está no mesmo grupo forte fica de fora — ele já aparece lá.
 *
 * Um par entra quando:
 *  (a) os dois nomes dividem DUAS OU MAIS palavras raras; ou
 *  (b) um nome inteiro está dentro do outro (igual conta), e o nome contido tem
 *      2 palavras ou mais, 6 letras ou mais e ao menos uma palavra rara. A
 *      busca é pela palavra rara: quem contém o nome contém essa palavra, então
 *      só as fichas dela (no máximo 3) são comparadas. Isso corta o nome de uma
 *      palavra só e o nome composto comum ("Ana Paula" dentro de "Ana Paula X").
 *
 * O nome é o de `nomeDoContato` (`name`, depois `display_name`), que já pula
 * identificador técnico (`…@lid`, `Contato 123`, só dígitos). `dispensados` são
 * as chaves de `parDeContatos` que alguém tirou da lista.
 */
export function encontrarParecidosPorNome(
  contatos: ContatoParaDeduplicar[],
  opcoes: { dispensados?: ReadonlySet<string> } = {},
): GrupoDeDuplicados[] {
  const vivos = contatos.filter(elegivelParaMesclagem);
  const dispensados = opcoes.dispensados ?? new Set<string>();
  const porId = new Map(vivos.map((c) => [c.id, c] as const));

  const grupoForteDe = new Map<string, string>();
  for (const grupo of encontrarContatosDuplicados(vivos)) {
    for (const contato of grupo.contatos) grupoForteDe.set(contato.id, grupo.chave);
  }

  // `push` e não `[...lista, id]`: copiar a lista de uma palavra comum a cada
  // ficha seria O(n²) só na cópia.
  const palavrasDe = new Map<string, string[]>();
  const fichasDaPalavra = new Map<string, string[]>();
  for (const contato of vivos) {
    const palavras = palavrasDoNome(nomeDoContato(contato) ?? "");
    palavrasDe.set(contato.id, palavras);
    for (const palavra of palavras) {
      const lista = fichasDaPalavra.get(palavra);
      if (lista) lista.push(contato.id);
      else fichasDaPalavra.set(palavra, [contato.id]);
    }
  }
  const ehRara = (palavra: string) => (fichasDaPalavra.get(palavra)?.length ?? 0) <= TETO_DA_PALAVRA_RARA;

  const pares = new Map<string, [string, string]>();
  const registrar = (x: string, y: string) => {
    if (x !== y) pares.set(parDeContatos(x, y), x < y ? [x, y] : [y, x]);
  };

  // (a) Conta quantas palavras raras cada par divide.
  const rarasEmComum = new Map<string, number>();
  for (const ids of fichasDaPalavra.values()) {
    if (ids.length > TETO_DA_PALAVRA_RARA) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const chave = parDeContatos(ids[i]!, ids[j]!);
        const n = (rarasEmComum.get(chave) ?? 0) + 1;
        rarasEmComum.set(chave, n);
        if (n === 2) registrar(ids[i]!, ids[j]!);
      }
    }
  }

  // (b) Nome inteiro contido, procurado só entre as fichas da palavra rara.
  for (const contato of vivos) {
    const palavras = palavrasDe.get(contato.id) ?? [];
    if (palavras.length < 2 || palavras.join("").length < LETRAS_MINIMAS_DO_NOME_CONTIDO) continue;
    const rara = palavras.find(ehRara);
    if (!rara) continue;
    // Espaço nas pontas: " ana paula " não casa dentro de " joana paula ".
    const contido = ` ${palavras.join(" ")} `;
    for (const outroId of fichasDaPalavra.get(rara) ?? []) {
      if (outroId === contato.id) continue;
      if (` ${(palavrasDe.get(outroId) ?? []).join(" ")} `.includes(contido)) registrar(contato.id, outroId);
    }
  }

  const grupos: GrupoDeDuplicados[] = [];
  for (const [chavePar, [a, b]] of pares) {
    const forteA = grupoForteDe.get(a);
    if (forteA !== undefined && forteA === grupoForteDe.get(b)) continue;
    if (dispensados.has(chavePar)) continue;
    const ca = porId.get(a);
    const cb = porId.get(b);
    if (!ca || !cb) continue;
    const ordenados = [ca, cb].sort(
      (p, q) => p.created_at.localeCompare(q.created_at) || p.id.localeCompare(q.id),
    );
    grupos.push({ chave: `nome:${chavePar}`, motivos: ["nome_parecido"], contatos: ordenados });
  }
  return grupos.sort((p, q) => p.chave.localeCompare(q.chave));
}
