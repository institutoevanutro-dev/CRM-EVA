# Vocabulário que aprende — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fazer a fila de comentários encolher com o uso, por dois caminhos: marcação de perfil deixa de reprovar o comentário, e o vocabulário seguro cresce com palavras que o dono aprovou uma a uma.

**Architecture:** a trava (`lib/comentarios/seguranca.ts`) continua pura e determinística; ela passa a receber as palavras aprovadas como argumento em vez de ir buscá-las. Quem carrega é o worker, uma vez por rodada. As decisões do dono vivem numa tabela própria por organização, e a lista de candidatos é calculada na hora a partir da fila, sem tabela intermediária.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript estrito, Vitest, Playwright, Postgres/Supabase com RLS.

**Spec:** `docs/superpowers/specs/2026-09-29-vocabulario-que-aprende-design.md`

## Global Constraints

- **Os seis gatilhos rodam ANTES do vocabulário e são soberanos.** Nenhuma palavra aprovada pode liberar preço, medicação, sintoma, agendamento, reclamação ou especialidade. Verbatim da spec §1.
- **Palavra de gatilho NUNCA é oferecida para aprovação.** Verbatim da spec §3.
- **A trava de RQE não é relaxável pelo dono.** `lib/comentarios/especialidade.ts` segue intacta. Verbatim da spec §1.
- **`ehObviamenteSeguro` continua pura:** sem rede, sem banco, sem modelo. As aprovadas entram por argumento.
- **A marcação é removida só na ANÁLISE**, nunca de `instagram_comments.texto` nem da tela. Verbatim da spec §2.
- **Migration sai com a tripla:** arquivo + apêndice idempotente no `baseline.sql` + linha no MANIFEST (CLAUDE.md, Doutrina de Migrations).
- **Texto novo de tela exige espanhol** em `lib/i18n/dicionario.ts` (o guard `tests/unit/i18n-espanhol-cobre-a-tela.test.ts` reprova).
- **Sem travessão (—) em texto que o usuário lê.** Vale para copy de tela e fragmento de release.
- **Papel:** ler é `agent`, escrever é `manager`.

## Review Focus

Cinco classes de entrada que a spec implica e que nenhum teste de tarefa exercitaria por acaso. Cada uma tem seu teste apontado na tarefa que a possui:

1. **Comentário que é SÓ marcação** (`@fulano`): depois de remover, sobra vazio. Tem de continuar `seguro: false` com gatilho `vazio`, nunca virar "todo token é seguro" por vacuidade. (Tarefa 1)
2. **Marcação colada em pontuação** (`@fulano, top!` / `(@fulano)`): a remoção não pode comer a vírgula e emendar palavras. (Tarefa 1)
3. **Palavra aprovada numa organização vazando para outra.** O conjunto é por organização; a trava não pode receber o conjunto errado. (Tarefa 3, pela RLS; Tarefa 6, pelo cache da rodada)
4. **Palavra aprovada que DEPOIS vira gatilho** (alguém acrescenta um radical à lista de gatilhos numa versão futura): o gatilho tem de continuar vencendo, sem precisar limpar a tabela. (Tarefa 2)
5. **Candidato com caixa e acento diferentes** ("Conteúdo", "CONTEUDO", "conteudo"): tem de ser UMA palavra, não três, senão o dono aprova a mesma coisa várias vezes. (Tarefa 4)

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `lib/comentarios/seguranca.ts` (modificar) | remover marcação antes de analisar; aceitar as aprovadas por argumento |
| `lib/comentarios/candidatos.ts` (criar) | dado o texto dos comentários respondidos e o que já foi decidido, quais palavras oferecer |
| `supabase/migrations/<ts>_<NNNN>_vocabulario_de_comentario.sql` (criar) | tabela `instagram_comment_vocabulario` + RLS |
| `app/api/v1/comentarios/vocabulario/route.ts` (criar) | GET candidatos + decididas; POST decide uma palavra |
| `workers/comentarios-worker.ts` (modificar) | ler as aprovadas uma vez por rodada e passar para a trava |
| `components/inbox/comentarios/PalavrasDaIa.tsx` (criar) | o painel |
| `hooks/comentarios/useComentarios.ts` (modificar) | hooks de leitura e decisão |

---

## Task 1: Marcação de perfil sai da análise

**Files:**
- Modify: `lib/comentarios/seguranca.ts`
- Test: `lib/comentarios/seguranca.test.ts`

**Interfaces:**
- Consumes: nada de tarefas anteriores.
- Produces: `ehObviamenteSeguro(texto: string | null): Veredito` — mesma assinatura de hoje, comportamento novo para textos com `@`.

- [ ] **Step 1: Escrever os testes que falham**

Acrescente ao fim de `lib/comentarios/seguranca.test.ts`:

```ts
describe("marcação de perfil sai da análise", () => {
  it("marcação mais emoji passa: o que decide é o resto da frase", () => {
    expect(ehObviamenteSeguro("@dr.andreluisc 💪💪💪")).toEqual({ seguro: true });
  });

  it("marcação mais elogio conhecido passa", () => {
    expect(ehObviamenteSeguro("@fulano @ciclano top demais")).toEqual({ seguro: true });
  });

  it("o gatilho continua vencendo: o resto da frase é que decide", () => {
    const v = ehObviamenteSeguro("@fulano quanto custa?");
    expect(v.seguro).toBe(false);
    if (!v.seguro) expect(v.gatilho).toBe("preço");
  });

  // Review Focus 1: sobrar vazio não é "todos os tokens são seguros".
  it("comentário que é SÓ marcação continua inseguro, com gatilho vazio", () => {
    const v = ehObviamenteSeguro("@fulano");
    expect(v.seguro).toBe(false);
    if (!v.seguro) expect(v.gatilho).toBe("vazio");
  });

  it("só marcação com espaços em volta também", () => {
    const v = ehObviamenteSeguro("  @fulano  @ciclano ");
    expect(v.seguro).toBe(false);
    if (!v.seguro) expect(v.gatilho).toBe("vazio");
  });

  // Review Focus 2: a remoção não pode emendar palavras nem comer pontuação.
  it("marcação colada em pontuação não emenda o resto", () => {
    expect(ehObviamenteSeguro("@fulano, top!")).toEqual({ seguro: true });
    expect(ehObviamenteSeguro("(@fulano) show")).toEqual({ seguro: true });
  });

  it("e-mail não é marcação: o texto continua sendo julgado inteiro", () => {
    const v = ehObviamenteSeguro("fale com joao@clinica.com");
    expect(v.seguro).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run lib/comentarios/seguranca.test.ts`
Expected: FAIL nos casos com `@` (o de e-mail já passa).

- [ ] **Step 3: Implementar**

Em `lib/comentarios/seguranca.ts`, logo depois de `const TOKEN_RE = ...`, acrescente:

```ts
/**
 * Marcação de perfil do Instagram: `@` seguido do identificador (letras,
 * dígitos, ponto, sublinhado), e só quando o `@` NÃO vem colado em
 * letra/dígito — senão `joao@clinica.com` viraria "fale com", e um e-mail no
 * comentário passaria a ser invisível para a trava.
 */
const MARCACAO_RE = /(^|[^\p{L}\p{N}])@[\p{L}\p{N}._]+/gu;

/**
 * Tira as marcações ANTES de julgar. O `$1` devolve o separador que a regex
 * consumiu, para `"@fulano, top!"` virar `", top!"` e não `" top!"` colado no
 * que veio antes.
 *
 * O texto guardado em `instagram_comments.texto` e o que a tela mostra NUNCA
 * passam por aqui: quem escreveu escreveu.
 */
function semMarcacoes(texto: string): string {
  return texto.replace(MARCACAO_RE, "$1");
}
```

Em `ehObviamenteSeguro`, troque a linha que apara o texto:

```ts
  const textoAparado = semMarcacoes(texto).trim();
  if (textoAparado === "") {
    return { seguro: false, gatilho: "vazio" };
  }
  const normalizado = normalizarTexto(textoAparado);
```

(A guarda de `vazio` no topo da função, para `texto` nulo ou em branco, continua onde está: esta segunda é para o que sobra depois da remoção.)

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run lib/comentarios/seguranca.test.ts`
Expected: PASS, todos.

- [ ] **Step 5: Provar que o teste morde**

Troque `semMarcacoes(texto).trim()` de volta por `texto.trim()` e rode de novo.
Expected: os casos com `@` reprovam. Desfaça.

- [ ] **Step 6: Commit**

```bash
git add lib/comentarios/seguranca.ts lib/comentarios/seguranca.test.ts
git commit -m "feat(comentarios): marcacao de perfil sai da analise da trava"
```

---

## Task 2: A trava aceita palavras aprovadas

**Files:**
- Modify: `lib/comentarios/seguranca.ts`
- Test: `lib/comentarios/seguranca.test.ts`

**Interfaces:**
- Consumes: `ehObviamenteSeguro` da Tarefa 1.
- Produces: `ehObviamenteSeguro(texto: string | null, aprovadas?: ReadonlySet<string>): Veredito`. O segundo argumento é **opcional**: todo chamador de hoje continua compilando e se comportando igual.

- [ ] **Step 1: Escrever os testes que falham**

```ts
describe("palavras aprovadas pelo dono", () => {
  it("palavra desconhecida reprova; a mesma palavra aprovada libera", () => {
    expect(ehObviamenteSeguro("conteudo fantastico").seguro).toBe(false);
    expect(ehObviamenteSeguro("conteudo fantastico", new Set(["fantastico"]))).toEqual({
      seguro: true,
    });
  });

  // Review Focus 4: gatilho vence aprovação, hoje e numa versão futura que
  // acrescente radicais à lista de gatilhos.
  it("gatilho vence palavra aprovada, mesmo que o dono a tenha liberado", () => {
    const v = ehObviamenteSeguro("otimo, quanto custa?", new Set(["custa", "quanto"]));
    expect(v.seguro).toBe(false);
    if (!v.seguro) expect(v.gatilho).toBe("preço");
  });

  it("aprovar não desarma o teto de tamanho nem a interrogação final", () => {
    const longo = `${"otimo ".repeat(40)}fantastico`;
    expect(ehObviamenteSeguro(longo, new Set(["fantastico"])).seguro).toBe(false);
    expect(ehObviamenteSeguro("fantastico?", new Set(["fantastico"])).seguro).toBe(false);
  });

  it("conjunto vazio ou ausente se comporta igual ao de hoje", () => {
    expect(ehObviamenteSeguro("top", new Set())).toEqual({ seguro: true });
    expect(ehObviamenteSeguro("fantastico", new Set())).toEqual(
      ehObviamenteSeguro("fantastico"),
    );
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run lib/comentarios/seguranca.test.ts`
Expected: FAIL — `ehObviamenteSeguro` ainda aceita um argumento só.

- [ ] **Step 3: Implementar**

Troque a assinatura de `todosOsTokensSaoSeguros` e de `ehObviamenteSeguro`:

```ts
function todosOsTokensSaoSeguros(
  normalizado: string,
  aprovadas: ReadonlySet<string>,
): boolean {
  const tokens = normalizado.match(TOKEN_RE) ?? [];
  if (tokens.length === 0) return false;
  return tokens.every(
    (token) =>
      SOMENTE_EMOJI_RE.test(token) ||
      SOMENTE_DIGITOS_RE.test(token) ||
      VOCABULARIO_SEGURO.has(token) ||
      aprovadas.has(token),
  );
}
```

```ts
const NENHUMA_APROVADA: ReadonlySet<string> = new Set();

/**
 * `aprovadas` são as palavras que o DONO liberou (tabela
 * `instagram_comment_vocabulario`, por organização). Entram por argumento, e
 * não por consulta aqui dentro, porque esta função é pura de propósito: ela é
 * a régua, e régua que faz I/O não dá para testar com 40 frases num teste de
 * unidade.
 *
 * Elas só participam da ÚLTIMA pergunta ("todo token é conhecido?"). Os
 * gatilhos, o teto de tamanho e a interrogação final rodam antes e não olham
 * para este conjunto.
 */
export function ehObviamenteSeguro(
  texto: string | null,
  aprovadas: ReadonlySet<string> = NENHUMA_APROVADA,
): Veredito {
```

E, no fim da função, passe o conjunto adiante:

```ts
  if (todosOsTokensSaoSeguros(normalizado, aprovadas)) {
    return { seguro: true };
  }
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run lib/comentarios/seguranca.test.ts`
Expected: PASS.

- [ ] **Step 5: Conferir que nenhum chamador quebrou**

Run: `pnpm typecheck`
Expected: 0 erros. O argumento é opcional, então `workers/comentarios-worker.ts` compila sem mudança.

- [ ] **Step 6: Commit**

```bash
git add lib/comentarios/seguranca.ts lib/comentarios/seguranca.test.ts
git commit -m "feat(comentarios): a trava aceita palavras aprovadas pelo dono"
```

---

## Task 3: A tabela das decisões

**Files:**
- Create: `supabase/migrations/<timestamp>_<NNNN>_vocabulario_de_comentario.sql`
- Modify: `supabase/baseline.sql`, `supabase/migrations/MANIFEST.md`
- Test: `tests/invariants/vocabulario-de-comentario.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: tabela `public.instagram_comment_vocabulario` com colunas `id`, `organization_id`, `palavra`, `aprovada`, `decidida_por`, `created_at`; único `(organization_id, palavra)`.

- [ ] **Step 1: Descobrir o número da migration**

Não copie um número deste plano. Em 30/09/2026 houve **três** colisões de `NNNN` entre sessões paralelas num único dia. Rode:

```bash
git fetch origin main && git merge --no-edit origin/main
ls supabase/migrations/ | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1
```

Use o número seguinte, e um timestamp posterior ao maior existente.

- [ ] **Step 2: Escrever o invariante que falha**

Crie `tests/invariants/vocabulario-de-comentario.test.ts`:

```ts
/**
 * A tabela das palavras que o dono liberou. Três coisas que a RLS tem de
 * garantir, e que o CLAUDE.md cobra de toda tabela nova:
 * isolamento entre organizações, piso de papel na escrita, e unicidade da
 * palavra por organização.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { comOBanco } from "../db/banco-limpo-por-arquivo";

const ORG_A = "0aa00000-0000-4000-8000-000000000001";
const ORG_B = "0aa00000-0000-4000-8000-000000000002";
const MANAGER_A = "0aa00000-1111-4000-8000-000000000001";
const VIEWER_A = "0aa00000-1111-4000-8000-000000000002";

describe("instagram_comment_vocabulario", () => {
  it("a mesma palavra pode existir em DUAS organizações, e só uma vez em cada", async () => {
    await comOBanco(async (db) => {
      await db.query(
        `insert into instagram_comment_vocabulario (organization_id, palavra, aprovada)
         values ($1,'corte',true), ($2,'corte',false)`,
        [ORG_A, ORG_B],
      );
      await expect(
        db.query(
          `insert into instagram_comment_vocabulario (organization_id, palavra, aprovada)
           values ($1,'corte',true)`,
          [ORG_A],
        ),
      ).rejects.toThrow(/duplicate key|unique/i);
    });
  });

  it("viewer não escreve; manager escreve", async () => {
    await comOBanco(async (db) => {
      await expect(
        db.comoUsuario(VIEWER_A, ORG_A, (c) =>
          c.query(
            `insert into instagram_comment_vocabulario (organization_id, palavra, aprovada)
             values ($1,'didatico',true)`,
            [ORG_A],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);

      await db.comoUsuario(MANAGER_A, ORG_A, (c) =>
        c.query(
          `insert into instagram_comment_vocabulario (organization_id, palavra, aprovada)
           values ($1,'didatico',true)`,
          [ORG_A],
        ),
      );
    });
  });

  // Review Focus 3: uma organização não enxerga a decisão da outra.
  it("membro de A não lê as palavras de B", async () => {
    await comOBanco(async (db) => {
      await db.query(
        `insert into instagram_comment_vocabulario (organization_id, palavra, aprovada)
         values ($1,'segredo',true)`,
        [ORG_B],
      );
      const { rows } = await db.comoUsuario(MANAGER_A, ORG_A, (c) =>
        c.query(`select palavra from instagram_comment_vocabulario`),
      );
      expect(rows.map((r) => r.palavra)).not.toContain("segredo");
    });
  });
});
```

⚠️ Antes de rodar, abra `tests/invariants/comentarios-do-instagram.test.ts` e copie dali o formato REAL de `comOBanco`/`comoUsuario` e o preâmbulo que cria organização, usuário e papel. Os nomes acima são a intenção; a forma é a daquele arquivo.

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test:db`
Expected: FAIL com `relation "instagram_comment_vocabulario" does not exist`.

- [ ] **Step 4: Escrever a migration**

```sql
-- ── As palavras que o dono liberou para a IA usar ───────────────────────────
--
-- A trava de segurança nega por padrão: só publica quando TODO token está num
-- vocabulário conhecido. Esta tabela é o que o dono acrescentou a esse
-- vocabulário, palavra por palavra, olhando a lista do que apareceu nos
-- comentários que ele mesmo respondeu.
--
-- Guarda a RECUSA também (`aprovada = false`), e isso não é simetria de
-- enfeite: sem ela a mesma palavra volta a ser oferecida toda semana e a tela
-- vira ruído.
--
-- Sem coluna de contagem: quantas vezes a palavra apareceu é derivável de
-- `instagram_comments` (Doutrina DIRC — Calcular, e anti-pattern nº 2).

create table if not exists public.instagram_comment_vocabulario (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Já normalizada (minúscula, sem acento): a MESMA forma que o tokenizador
  -- de `lib/comentarios/seguranca.ts` produz. Guardar "Conteúdo" faria a
  -- comparação falhar em silêncio.
  palavra text not null,
  aprovada boolean not null,
  decidida_por uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists instagram_comment_vocabulario_unica
  on public.instagram_comment_vocabulario(organization_id, palavra);

alter table public.instagram_comment_vocabulario enable row level security;

-- Leitura para todo membro do tenant; escrita com piso de papel. Mesmo
-- formato da 0280, e pelo mesmo motivo: `tests/invariants/rbac-config-ia-canais.test.ts`
-- reprova tabela nova com policy `for all` só de tenancy.
drop policy if exists instagram_comment_vocabulario_select on public.instagram_comment_vocabulario;
create policy instagram_comment_vocabulario_select on public.instagram_comment_vocabulario
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists instagram_comment_vocabulario_write on public.instagram_comment_vocabulario;
create policy instagram_comment_vocabulario_write on public.instagram_comment_vocabulario
  for all using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'manager'))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'manager'))
  );
```

- [ ] **Step 5: Completar a tripla**

Copie o bloco inteiro para o apêndice de `supabase/baseline.sql`, rotulado
`-- ---- vocabulário de comentário (migration NNNN) ----` e
`-- ---- fim: vocabulário de comentário (migration NNNN) ----`,
**antes** do bloco `VARREDURA anon`, que é o último do arquivo de propósito.

Acrescente a linha em `supabase/migrations/MANIFEST.md`, na ordem do número.

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm test:db`
Expected: PASS. É o único gate que aplica o `baseline.sql` de verdade.

- [ ] **Step 7: Commit**

```bash
git add supabase/ tests/invariants/vocabulario-de-comentario.test.ts
git commit -m "feat(comentarios): tabela das palavras que o dono liberou"
```

---

## Task 4: Quais palavras oferecer

**Files:**
- Create: `lib/comentarios/candidatos.ts`
- Test: `lib/comentarios/candidatos.test.ts`

**Interfaces:**
- Consumes: `VOCABULARIO_SEGURO` e os gatilhos de `seguranca.ts` — que hoje NÃO são exportados. Esta tarefa exporta duas coisas novas de lá: `ehTokenConhecido(token: string): boolean` e `ehTokenDeGatilho(token: string): boolean`.
- Produces:

```ts
export interface Candidato { palavra: string; vezes: number }
export function candidatosDoHistorico(
  textosRespondidos: readonly string[],
  jaDecididas: ReadonlySet<string>,
): Candidato[]
```

Ordenado por `vezes` decrescente, e por palavra em ordem alfabética no empate.

- [ ] **Step 1: Escrever os testes que falham**

Crie `lib/comentarios/candidatos.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { candidatosDoHistorico } from "./candidatos";

const nada = new Set<string>();

describe("candidatosDoHistorico", () => {
  it("oferece a palavra desconhecida, com quantos comentários ela apareceu", () => {
    const r = candidatosDoHistorico(["conteudo fantastico", "outro fantastico"], nada);
    expect(r).toEqual([{ palavra: "fantastico", vezes: 2 }]);
  });

  it("não oferece o que a trava já conhece", () => {
    expect(candidatosDoHistorico(["top demais", "muito bom"], nada)).toEqual([]);
  });

  // Global Constraint: palavra de gatilho NUNCA é oferecida.
  it("NUNCA oferece palavra de gatilho, nem preço nem especialidade", () => {
    const r = candidatosDoHistorico(
      ["quanto custa isso", "voce e nutrologo", "tomei mounjaro"],
      nada,
    );
    expect(r.map((c) => c.palavra)).not.toContain("custa");
    expect(r.map((c) => c.palavra)).not.toContain("nutrologo");
    expect(r.map((c) => c.palavra)).not.toContain("mounjaro");
  });

  it("não oferece o que já foi decidido, aprovado ou recusado", () => {
    expect(candidatosDoHistorico(["fantastico show"], new Set(["fantastico"]))).toEqual([]);
  });

  it("emoji e número não viram candidato: a trava já os aceita", () => {
    expect(candidatosDoHistorico(["🔥🔥 10"], nada)).toEqual([]);
  });

  // Review Focus 5: caixa e acento diferentes são UMA palavra.
  it("Conteúdo, CONTEUDO e conteudo contam como a mesma palavra", () => {
    const r = candidatosDoHistorico(["Didático demais", "DIDATICO", "didatico"], nada);
    expect(r).toEqual([{ palavra: "didatico", vezes: 3 }]);
  });

  it("conta COMENTÁRIOS, não ocorrências: repetir na mesma frase conta uma vez", () => {
    expect(candidatosDoHistorico(["didatico didatico didatico"], nada)).toEqual([
      { palavra: "didatico", vezes: 1 },
    ]);
  });

  it("marcação não vira candidato: ela sai da análise", () => {
    expect(candidatosDoHistorico(["@dr.andreluisc top"], nada)).toEqual([]);
  });

  it("ordena pelo que mais encolhe a fila, e alfabético no empate", () => {
    const r = candidatosDoHistorico(["aula didatica", "didatica", "zebra"], nada);
    expect(r.map((c) => c.palavra)).toEqual(["didatica", "zebra"]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run lib/comentarios/candidatos.test.ts`
Expected: FAIL — o módulo não existe.

- [ ] **Step 3: Exportar as duas perguntas de `seguranca.ts`**

```ts
/** O token já é conhecido pela trava (vocabulário fixo, emoji ou dígito)? */
export function ehTokenConhecido(token: string): boolean {
  return (
    SOMENTE_EMOJI_RE.test(token) ||
    SOMENTE_DIGITOS_RE.test(token) ||
    VOCABULARIO_SEGURO.has(token)
  );
}

/**
 * O token, sozinho, casa algum dos seis gatilhos? Usado para NUNCA oferecer
 * palavra de gatilho ao dono: pedir que ele libere "custa" enquanto limpa a
 * fila é pedir que desarme a própria proteção sem perceber.
 */
export function ehTokenDeGatilho(token: string): boolean {
  return GATILHOS.some(([, padrao]) => {
    padrao.lastIndex = 0;
    return padrao.test(token);
  });
}
```

⚠️ `GATILHOS` usa regex sem flag `g`, então `lastIndex` não deveria importar; o reset está ali por segurança caso alguém acrescente `g` no futuro. Confirme lendo a constante antes de simplificar.

Exporte também o tokenizador e o normalizador que os candidatos precisam:

```ts
/** Tokens do texto, já sem marcação e normalizados — a MESMA régua da trava. */
export function tokensParaAnalise(texto: string): string[] {
  return normalizarTexto(semMarcacoes(texto).trim()).match(TOKEN_RE) ?? [];
}
```

- [ ] **Step 4: Escrever `lib/comentarios/candidatos.ts`**

```ts
/**
 * Quais palavras oferecer ao dono para ele liberar.
 *
 * A fonte é a fila: os comentários que ELE respondeu com o próprio dedo
 * (`situacao = 'respondido_manualmente'`). Descartados não entram, e é essa
 * diferença que dá o sinal.
 *
 * Puro: recebe os textos e o que já foi decidido, devolve a lista. Quem
 * consulta o banco é a rota.
 */
import { ehTokenConhecido, ehTokenDeGatilho, tokensParaAnalise } from "./seguranca";

export interface Candidato {
  palavra: string;
  /** Em quantos COMENTÁRIOS a palavra apareceu, não quantas vezes ao todo. */
  vezes: number;
}

export function candidatosDoHistorico(
  textosRespondidos: readonly string[],
  jaDecididas: ReadonlySet<string>,
): Candidato[] {
  const contagem = new Map<string, number>();

  for (const texto of textosRespondidos) {
    // Set por comentário: "didatico didatico" conta UM comentário, não dois.
    const noComentario = new Set(tokensParaAnalise(texto));
    for (const token of noComentario) {
      if (ehTokenConhecido(token)) continue;
      if (ehTokenDeGatilho(token)) continue;
      if (jaDecididas.has(token)) continue;
      contagem.set(token, (contagem.get(token) ?? 0) + 1);
    }
  }

  return [...contagem.entries()]
    .map(([palavra, vezes]) => ({ palavra, vezes }))
    .sort((a, b) => b.vezes - a.vezes || a.palavra.localeCompare(b.palavra));
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run lib/comentarios/candidatos.test.ts lib/comentarios/seguranca.test.ts`
Expected: PASS nos dois arquivos.

- [ ] **Step 6: Provar que o teste de gatilho morde**

Comente a linha `if (ehTokenDeGatilho(token)) continue;` e rode de novo.
Expected: o teste "NUNCA oferece palavra de gatilho" reprova. Descomente.

- [ ] **Step 7: Commit**

```bash
git add lib/comentarios/candidatos.ts lib/comentarios/candidatos.test.ts lib/comentarios/seguranca.ts
git commit -m "feat(comentarios): quais palavras oferecer ao dono"
```

---

## Task 5: A rota

**Files:**
- Create: `app/api/v1/comentarios/vocabulario/route.ts`
- Modify: `lib/audit/actions.ts`
- Test: `tests/unit/comentarios-vocabulario-rota.test.ts`

**Interfaces:**
- Consumes: `candidatosDoHistorico` (Tarefa 4), a tabela (Tarefa 3).
- Produces:
  - `GET` → `{ data: { candidatos: Candidato[], decididas: { palavra: string, aprovada: boolean }[] } }`, papel `agent`.
  - `POST` body `{ palavra: string, aprovada: boolean }` → `{ data: { palavra, aprovada } }`, papel `manager`.

- [ ] **Step 1: Registrar a ação de auditoria**

Em `lib/audit/actions.ts`, ao lado de `"comment.frases_updated"`:

```ts
  // O dono liberou ou recusou uma palavra para a IA usar sozinha. Régua de
  // segurança que afrouxa precisa dizer quem afrouxou. `resourceId` é a
  // organização; a palavra e a decisão vão no metadata.
  "comment.vocabulary_decided",
```

- [ ] **Step 2: Escrever os testes que falham**

Crie `tests/unit/comentarios-vocabulario-rota.test.ts`, copiando o preâmbulo de mocks de `tests/unit/comentarios-frases-rota.test.ts` (`requireRole`, `createClient`, `requireSupportWrite`, `audit`, `logger`), e acrescente:

```ts
describe("GET", () => {
  it("devolve candidatos calculados da fila e o que já foi decidido", async () => {
    comentariosRespondidos = ["conteudo fantastico", "outro fantastico"];
    decididasNoBanco = [{ palavra: "didatico", aprovada: true }];

    const corpo = await (await GET()).json();

    expect(corpo.data.candidatos).toEqual([{ palavra: "fantastico", vezes: 2 }]);
    expect(corpo.data.decididas).toEqual([{ palavra: "didatico", aprovada: true }]);
  });

  it("palavra já decidida não volta como candidato", async () => {
    comentariosRespondidos = ["fantastico demais"];
    decididasNoBanco = [{ palavra: "fantastico", aprovada: false }];

    const corpo = await (await GET()).json();

    expect(corpo.data.candidatos).toEqual([]);
  });

  it("ler exige agent", async () => {
    await GET();
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("agent");
  });
});

describe("POST", () => {
  it("grava a decisão com a palavra normalizada", async () => {
    const res = await POST(pedido({ palavra: "  Didático  ", aprovada: true }));

    expect(res.status).toBe(200);
    expect(upserts[0]).toMatchObject({ palavra: "didatico", aprovada: true });
  });

  it("escrever exige manager", async () => {
    await POST(pedido({ palavra: "didatico", aprovada: true }));
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("manager");
  });

  // Global Constraint: o dono não pode liberar gatilho nem pela rota.
  it("RECUSA palavra de gatilho, mesmo vinda direto na rota", async () => {
    const res = await POST(pedido({ palavra: "custa", aprovada: true }));

    expect(res.status).toBe(422);
    expect(upserts).toEqual([]);
  });

  it("recusa palavra vazia e palavra com espaço no meio", async () => {
    expect((await POST(pedido({ palavra: "  ", aprovada: true }))).status).toBe(422);
    expect((await POST(pedido({ palavra: "duas palavras", aprovada: true }))).status).toBe(422);
  });

  it("a trilha registra quem decidiu, a palavra e a decisão", async () => {
    await POST(pedido({ palavra: "didatico", aprovada: true }));

    const e = auditSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(e.action).toBe("comment.vocabulary_decided");
    expect(e.metadata).toMatchObject({ palavra: "didatico", aprovada: true });
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run tests/unit/comentarios-vocabulario-rota.test.ts`
Expected: FAIL — a rota não existe.

- [ ] **Step 4: Escrever a rota**

```ts
/**
 * `GET`/`POST /api/v1/comentarios/vocabulario` — as palavras que o dono
 * liberou para a IA responder sozinha.
 *
 * Ler é `agent`; decidir é `manager`, o mesmo piso de
 * `instagram_comment_rules_write`: as duas coisas afrouxam o que sai sem
 * toque humano.
 *
 * A rota RECONFERE que a palavra não é de gatilho. A tela já não oferece
 * essas palavras, mas a tela não é a régua: um POST à mão não pode liberar
 * "custa" nem "nutrologo".
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { candidatosDoHistorico } from "@/lib/comentarios/candidatos";
import { ehTokenDeGatilho } from "@/lib/comentarios/seguranca";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { normalizarTexto } from "@/lib/opt-out/deteccao";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Teto de comentários lidos para montar a lista. A fila é a fonte, não o histórico inteiro. */
const TETO_DE_COMENTARIOS = 500;

const corpoSchema = z.object({
  palavra: z.string().trim().min(1).max(60),
  aprovada: z.boolean(),
});

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "instagram_comment_vocabulario" });
  if (!authz.ok) return authz.response;
  const { org } = authz;
  const supabase = await createClient();

  const [{ data: decididas, error: erroV }, { data: respondidos, error: erroC }] = await Promise.all([
    supabase
      .from("instagram_comment_vocabulario")
      .select("palavra, aprovada")
      .eq("organization_id", org.orgId)
      .order("palavra"),
    supabase
      .from("instagram_comments")
      .select("texto")
      .eq("organization_id", org.orgId)
      .eq("situacao", "respondido_manualmente")
      .order("comentado_em", { ascending: false })
      .limit(TETO_DE_COMENTARIOS),
  ]);

  if (erroV || erroC) {
    logger.error("[comentarios.vocabulario] leitura falhou", {
      erro: (erroV ?? erroC)?.message,
      requestId,
    });
    return fail("db_error", traduzir("Não foi possível ler as palavras.", authz.user.idioma), 500, {
      requestId,
    });
  }

  const lista = (decididas ?? []) as Array<{ palavra: string; aprovada: boolean }>;
  const textos = ((respondidos ?? []) as Array<{ texto: string | null }>)
    .map((r) => r.texto)
    .filter((t): t is string => typeof t === "string");

  return ok(
    {
      candidatos: candidatosDoHistorico(textos, new Set(lista.map((d) => d.palavra))),
      decididas: lista,
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "instagram_comment_vocabulario" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org, user } = authz;

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  }

  const palavra = normalizarTexto(parsed.data.palavra.trim());

  // Uma palavra é UM token. "duas palavras" viraria uma chave que o
  // tokenizador nunca produz, e ficaria guardada sem nunca liberar nada.
  if (!/^[\p{L}\p{N}]+$/u.test(palavra)) {
    return fail("validation_failed", t("Isso precisa ser uma palavra só."), 422, { requestId });
  }

  if (ehTokenDeGatilho(palavra)) {
    return fail(
      "validation_failed",
      t("Essa palavra toca um assunto que sempre passa por você."),
      422,
      { requestId },
    );
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("instagram_comment_vocabulario")
    .upsert(
      {
        organization_id: org.orgId,
        palavra,
        aprovada: parsed.data.aprovada,
        decidida_por: user.id,
      },
      { onConflict: "organization_id,palavra" },
    );

  if (error) {
    logger.error("[comentarios.vocabulario] gravação falhou", { erro: error.message, requestId });
    return fail("db_error", t("Não foi possível salvar."), 500, { requestId });
  }

  await audit({
    action: "comment.vocabulary_decided",
    organizationId: org.orgId,
    actorUserId: user.id,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: { palavra, aprovada: parsed.data.aprovada },
  });

  return ok({ palavra, aprovada: parsed.data.aprovada }, { requestId });
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run tests/unit/comentarios-vocabulario-rota.test.ts`
Expected: PASS.

- [ ] **Step 6: Provar que o teste de gatilho morde**

Comente o bloco `if (ehTokenDeGatilho(palavra))` e rode de novo.
Expected: "RECUSA palavra de gatilho" reprova. Descomente.

- [ ] **Step 7: Commit**

```bash
git add app/api/v1/comentarios/vocabulario/ lib/audit/actions.ts tests/unit/comentarios-vocabulario-rota.test.ts
git commit -m "feat(comentarios): rota que oferece e decide as palavras"
```

---

## Task 6: O worker usa as palavras aprovadas

**Files:**
- Modify: `workers/comentarios-worker.ts`
- Test: `tests/unit/comentarios-worker.test.ts`

**Interfaces:**
- Consumes: `ehObviamenteSeguro(texto, aprovadas)` (Tarefa 2), a tabela (Tarefa 3).
- Produces: `AdminDoWorker` ganha `palavrasAprovadas(organizationId: string): Promise<ReadonlySet<string>>`.

- [ ] **Step 1: Escrever os testes que falham**

No `beforeEach` do fake, acrescente `aprovadas: new Set<string>()` ao campo e
`async palavrasAprovadas() { return fake.aprovadas; }` ao dublê. Depois:

```ts
it("palavra aprovada pela organização faz a IA responder sozinha", async () => {
  fake.comentarios = [{ ...comentario, texto: "conteudo fantastico" }];
  fake.aprovadas = new Set(["fantastico"]);

  const r = await processarComentariosNovos(fake, agora);

  expect(r.atendidos).toBe(1);
  expect(fake.publicacoes).toHaveLength(1);
});

it("sem a palavra aprovada, o mesmo comentário continua esperando você", async () => {
  fake.comentarios = [{ ...comentario, texto: "conteudo fantastico" }];

  const r = await processarComentariosNovos(fake, agora);

  expect(r.esperando).toBe(1);
  expect(fake.publicacoes).toEqual([]);
});

// Review Focus 3: o conjunto é POR organização.
it("lê as aprovadas uma vez por organização, não uma por comentário", async () => {
  const pedidos: string[] = [];
  fake.palavrasAprovadas = async (org: string) => {
    pedidos.push(org);
    return new Set(["fantastico"]);
  };
  fake.comentarios = [
    { ...comentario, id: "IC-1", texto: "conteudo fantastico" },
    { ...comentario, id: "IC-2", externalId: "C-2", texto: "video fantastico" },
  ];

  await processarComentariosNovos(fake, agora);

  expect(pedidos).toEqual(["org"]);
});

it("preço com leitura falha ainda manda o Direct: o sufixo não pode matar o gatilho", async () => {
  fake.comentarios = [{ ...comentario, texto: "quanto custa?" }];
  fake.palavrasAprovadas = async () => {
    throw new Error("banco fora do ar");
  };
  const enviados: string[] = [];
  fake.enviarPrivada = async (i) => {
    enviados.push(i.commentId);
    return { messageId: "MID-1" };
  };

  await processarComentariosNovos(fake, agora);

  expect(enviados).toEqual(["C-1"]);
});

it("leitura das aprovadas que falha não publica nada, e diz o motivo", async () => {
  fake.comentarios = [{ ...comentario, texto: "conteudo fantastico" }];
  fake.palavrasAprovadas = async () => {
    throw new Error("banco fora do ar");
  };

  const r = await processarComentariosNovos(fake, agora);

  expect(r.esperando).toBe(1);
  expect(fake.publicacoes).toEqual([]);
  expect(linha().motivo_do_toque).toContain("palavras liberadas");
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/comentarios-worker.test.ts`
Expected: FAIL — o worker ainda chama `ehObviamenteSeguro(c.texto)` com um argumento.

- [ ] **Step 3: Implementar**

Na interface `AdminDoWorker`:

```ts
  /** As palavras que o dono liberou nesta organização. Lida UMA vez por rodada. */
  palavrasAprovadas(organizationId: string): Promise<ReadonlySet<string>>;
```

Em `processarComentariosNovos`, ao lado do cache de perfil de voz, crie o cache de aprovadas por organização (a fila já é por organização — ver `organizacoesComComentariosNovos`), e passe adiante para `processarUmComentario`.

Em `processarUmComentario`, troque:

```ts
  const veredito = ehObviamenteSeguro(c.texto, aprovadas);
```

E, no ponto onde a rodada carrega as aprovadas:

```ts
/**
 * O conjunto da rodada, mais o aviso de que ele pode estar incompleto.
 *
 * Falha de leitura NÃO vira conjunto vazio em silêncio: isso faria a fila
 * inchar sem ninguém entender por quê, num dia em que o banco tossiu. Vira
 * conjunto vazio COM aviso, e o aviso é escrito na linha de cada comentário
 * que cair na fila por causa disso.
 */
async function aprovadasDaRodada(
  admin: AdminDoWorker,
  organizationId: string,
): Promise<{ palavras: ReadonlySet<string>; leituraFalhou: boolean }> {
  try {
    return { palavras: await admin.palavrasAprovadas(organizationId), leituraFalhou: false };
  } catch (err) {
    logger.error("[comentarios-worker] não deu para ler as palavras liberadas", {
      organizationId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return { palavras: new Set(), leituraFalhou: true };
  }
}
```

E, no ramo em que a trava reprova (`processarUmComentario`), acrescente o
sufixo quando a leitura tiver falhado:

```ts
  const veredito = ehObviamenteSeguro(c.texto, aprovadas);
  if (!veredito.seguro) {
    const motivoBase = leituraFalhou
      ? `${veredito.gatilho} (não deu para ler as palavras liberadas desta organização)`
      : veredito.gatilho;
    const { motivo, privadaId } = await abrirConversaSeForIntencaoDeCompra(
      admin, c, motivoBase, agora,
    );
    await marcarEsperandoAuditado(admin, c, motivo, null, privadaId);
    return "esperando";
  }
```

⚠️ `abrirConversaSeForIntencaoDeCompra` decide se abre conversa comparando o
rótulo com `abreConversa(gatilho)`. Com o sufixo, `"preço (não deu...)"` não
casa mais e o Direct deixaria de sair. **Passe `veredito.gatilho` puro para
ela e componha o sufixo só no motivo gravado** — o teste "leitura das
aprovadas que falha não publica nada, e diz o motivo" não pega isso sozinho,
então acrescente também: `"preço com leitura falha ainda manda o Direct"`.

No admin real:

```ts
    async palavrasAprovadas(organizationId) {
      const { data, error } = await admin
        .from("instagram_comment_vocabulario")
        .select("palavra")
        .eq("organization_id", organizationId)
        .eq("aprovada", true);
      if (error) throw new Error(error.message);
      return new Set((data ?? []).map((r) => (r as { palavra: string }).palavra));
    },
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/unit/comentarios-worker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/comentarios-worker.ts tests/unit/comentarios-worker.test.ts
git commit -m "feat(comentarios): o worker usa as palavras que o dono liberou"
```

---

## Task 7: A tela

**Files:**
- Create: `components/inbox/comentarios/PalavrasDaIa.tsx`
- Modify: `hooks/comentarios/useComentarios.ts`, `components/inbox/comentarios/ComentariosPainel.tsx`, `lib/i18n/dicionario.ts`
- Test: `tests/unit/comentarios-palavras-tela.test.tsx`

**Interfaces:**
- Consumes: a rota da Tarefa 5.
- Produces: `<PalavrasDaIa />`, aberto por um botão "Palavras da IA" no cabeçalho do painel, ao lado de "Frases do Direct".

- [ ] **Step 1: Escrever os testes que falham**

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PalavrasDaIa } from "@/components/inbox/comentarios/PalavrasDaIa";

const decidirMock = vi.fn();
let dados: { candidatos: Array<{ palavra: string; vezes: number }>; decididas: Array<{ palavra: string; aprovada: boolean }> } | undefined;

vi.mock("@/hooks/comentarios/useComentarios", () => ({
  usePalavrasDaIa: () => ({ data: dados, isLoading: false }),
  useDecidirPalavra: () => ({ mutate: decidirMock, isPending: false }),
}));

beforeEach(() => {
  decidirMock.mockClear();
  dados = { candidatos: [{ palavra: "didatico", vezes: 4 }], decididas: [] };
});

describe("Palavras da IA", () => {
  it("mostra a palavra e em quantos comentários ela apareceu", () => {
    render(<PalavrasDaIa />);
    expect(screen.getByText("didatico")).toBeTruthy();
    expect(screen.getByText(/4/)).toBeTruthy();
  });

  it("NÃO mostra o comentário de origem: o dono escolheu julgar a palavra sozinha", () => {
    dados = { candidatos: [{ palavra: "didatico", vezes: 1 }], decididas: [] };
    const { container } = render(<PalavrasDaIa />);
    expect(container.textContent).not.toMatch(/coment[áa]rio de origem|exemplo/i);
  });

  it("Pode usar manda aprovada true; Nunca manda false", async () => {
    render(<PalavrasDaIa />);

    fireEvent.click(screen.getByRole("button", { name: /Pode usar/i }));
    await waitFor(() => expect(decidirMock).toHaveBeenCalledWith({ palavra: "didatico", aprovada: true }));

    decidirMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Nunca/i }));
    await waitFor(() => expect(decidirMock).toHaveBeenCalledWith({ palavra: "didatico", aprovada: false }));
  });

  it("sem candidatos, explica por que a lista está vazia", () => {
    dados = { candidatos: [], decididas: [] };
    render(<PalavrasDaIa />);
    expect(screen.getByText(/conforme você responde/i)).toBeTruthy();
  });

  it("dá para voltar atrás numa decisão já tomada", async () => {
    dados = { candidatos: [], decididas: [{ palavra: "didatico", aprovada: true }] };
    render(<PalavrasDaIa />);

    fireEvent.click(screen.getByText(/1 liberadas/i));
    fireEvent.click(screen.getByRole("button", { name: /Nunca/i }));

    await waitFor(() =>
      expect(decidirMock).toHaveBeenCalledWith({ palavra: "didatico", aprovada: false }),
    );
  });

  it("mostra quantas já foram liberadas e quantas recusadas", () => {
    dados = {
      candidatos: [],
      decididas: [
        { palavra: "a", aprovada: true },
        { palavra: "b", aprovada: true },
        { palavra: "c", aprovada: false },
      ],
    };
    render(<PalavrasDaIa />);
    expect(screen.getByText(/2 liberadas/i)).toBeTruthy();
    expect(screen.getByText(/1 recusada/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/comentarios-palavras-tela.test.tsx`
Expected: FAIL — o componente não existe.

- [ ] **Step 3: Escrever os hooks**

Em `hooks/comentarios/useComentarios.ts`, no mesmo formato de `useFrasesDeAbertura`:

```ts
export interface PalavrasDaIaResposta {
  candidatos: Array<{ palavra: string; vezes: number }>;
  decididas: Array<{ palavra: string; aprovada: boolean }>;
}

const CHAVE_PALAVRAS = ["instagram-comment-vocabulario"] as const;

export function usePalavrasDaIa() {
  return useQuery({
    queryKey: CHAVE_PALAVRAS,
    queryFn: () =>
      apiClient
        .get<{ data: PalavrasDaIaResposta }>("/api/v1/comentarios/vocabulario")
        .then((r) => r.data),
  });
}

export function useDecidirPalavra() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (corpo: { palavra: string; aprovada: boolean }) =>
      apiClient.post<{ data: { palavra: string } }>("/api/v1/comentarios/vocabulario", corpo),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE_PALAVRAS }),
    onError: showApiError,
  });
}
```

- [ ] **Step 4: Escrever o componente**

```tsx
"use client";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { usePalavrasDaIa, useDecidirPalavra } from "@/hooks/comentarios/useComentarios";

/**
 * As palavras que a IA pode usar sozinha.
 *
 * Mostra a palavra e em quantos comentários SEUS ela apareceu, e nada mais.
 * O comentário de origem foi oferecido ao dono e recusado em favor da tela
 * menor (spec §5 e §8); se aprovação distraída virar problema, é o primeiro
 * ajuste a fazer.
 *
 * Palavra de assunto sensível nunca chega aqui: a lista já vem sem elas, e a
 * rota recusa de novo.
 */
export function PalavrasDaIa() {
  const t = useT();
  const { data, isLoading } = usePalavrasDaIa();
  const decidir = useDecidirPalavra();

  if (isLoading || !data) {
    return <p className="px-3 py-4 text-sm text-text-muted">{t("Carregando…")}</p>;
  }

  const liberadas = data.decididas.filter((d) => d.aprovada).length;
  const recusadas = data.decididas.length - liberadas;

  return (
    <div className="flex flex-col gap-3 px-3 py-4">
      <p className="text-sm text-text-muted">
        {t(
          "Estas palavras apareceram em comentários que você respondeu. Liberando uma, a IA passa a responder sozinha os elogios que a usem. Assunto de saúde, preço e agendamento nunca aparecem aqui.",
        )}
      </p>

      {data.candidatos.length === 0 ? (
        <p className="text-sm text-text-muted">
          {t("Nada novo para decidir. As palavras aparecem aqui conforme você responde comentários.")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {data.candidatos.map((c) => (
            <li key={c.palavra} className="flex items-center justify-between gap-2 py-1">
              <span className="text-sm text-text">
                {c.palavra}{" "}
                <span className="text-xs text-text-muted">
                  {t("em")} {c.vezes}
                </span>
              </span>
              <span className="flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={decidir.isPending}
                  onClick={() => decidir.mutate({ palavra: c.palavra, aprovada: true })}
                >
                  {t("Pode usar")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={decidir.isPending}
                  onClick={() => decidir.mutate({ palavra: c.palavra, aprovada: false })}
                >
                  {t("Nunca")}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {data.decididas.length > 0 && (
        <details className="text-xs text-text-muted">
          <summary className="cursor-pointer">
            {liberadas} {t("liberadas")}, {recusadas} {t("recusada(s)")}
          </summary>
          {/* Voltar atrás é requisito da spec §5: decisão que não se desfaz
              vira medo de decidir. A rota faz upsert, então decidir de novo
              só atualiza a linha. */}
          <ul className="mt-2 flex flex-col gap-1">
            {data.decididas.map((d) => (
              <li key={d.palavra} className="flex items-center justify-between gap-2">
                <span>
                  {d.palavra} {d.aprovada ? t("(liberada)") : t("(recusada)")}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={decidir.isPending}
                  onClick={() => decidir.mutate({ palavra: d.palavra, aprovada: !d.aprovada })}
                >
                  {d.aprovada ? t("Nunca") : t("Pode usar")}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Ligar no painel**

Em `ComentariosPainel.tsx`, acrescente um estado `mostrarPalavras` e um botão
`{t("Palavras da IA")}` ao lado de "Frases do Direct", no mesmo formato.

- [ ] **Step 6: Traduzir**

Acrescente ao `lib/i18n/dicionario.ts` todas as chaves novas. Rode:

Run: `npx vitest run tests/unit/i18n-espanhol-cobre-a-tela.test.ts`
Expected: PASS. Este guard já pegou texto sem espanhol duas vezes no mesmo dia.

- [ ] **Step 7: Rodar e ver passar**

Run: `npx vitest run tests/unit/comentarios-palavras-tela.test.tsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add components/inbox/comentarios/ hooks/comentarios/ lib/i18n/dicionario.ts tests/unit/comentarios-palavras-tela.test.tsx
git commit -m "feat(comentarios): a tela onde o dono libera palavra por palavra"
```

---

## Task 8: Prova pela tela, mapa vivo e fragmento

**Files:**
- Modify: `tests/e2e/comentarios-do-instagram.spec.ts`, `docs/architecture/instagram-direct.architecture.json`, `docs/testing/user-journey-map.md`
- Create: `.changes/vocabulario-que-aprende.md`

**Interfaces:**
- Consumes: tudo das tarefas anteriores.
- Produces: nada que outra tarefa use.

- [ ] **Step 1: Acrescentar o caso ao e2e**

No teste de preço, que já loga como `manager`, depois das asserções atuais:

```ts
  // A marcação deixou de derrubar o comentário: o mesmo texto que ontem caía
  // na fila agora é julgado pelo resto da frase.
  await page.getByRole("button", { name: /Palavras da IA/i }).click();
  await expect(page.getByText(/conforme você responde/i).or(page.getByRole("button", { name: /Pode usar/i }).first())).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCIA, "04-palavras-da-ia.png"), fullPage: true });
```

- [ ] **Step 2: Rodar o guard de cobertura de e2e**

Run: `npx vitest run tests/unit/e2e-cobertura-completa.test.ts`
Expected: PASS (a spec já está em `SPECS_PARTE_2`; nenhuma spec nova entrou).

- [ ] **Step 3: Atualizar o mapa vivo**

Em `docs/architecture/instagram-direct.architecture.json`, acrescente o nó
`vocabulario_da_ia` na raia `humano`, e duas arestas: de `aba_comentarios`
para ele ("o dono libera palavra por palavra") e dele para
`comentario_worker` ("o worker lê as aprovadas uma vez por rodada").
Atualize o rótulo de `comentario_worker` para dizer que a trava consulta o
vocabulário do dono.

Run: `npx vitest run tests/unit/mapas-de-arquitetura.test.ts`
Expected: PASS.

- [ ] **Step 4: Atualizar a jornada**

Em `docs/testing/user-journey-map.md`, na J25.4, acrescente a linha do caso
novo: marcação deixa de derrubar; palavra liberada faz a IA responder.

- [ ] **Step 5: Escrever o fragmento**

⚠️ **Mire em 300 bytes de corpo.** O CHANGELOG que a VPS recebe tem teto de
30 KB por seção, e em 28/09/2026 a folga era de ~1,4 KB para todos os PRs
seguintes. Confira com `pnpm release:conferir` e com
`npx vitest run tests/unit/changelog-cabe-na-tela-da-vps.test.ts`.

Sem `##` no corpo, exceto `## Requer atenção`, que é o único cabeçalho que o
montador aceita.

```markdown
---
impacto: capacidade_nova
secao: adicionado
titulo: A IA aprende quais palavras pode usar, com o seu aval
---

Marcar alguém num comentário não manda mais ele para a fila. E em Inbox ›
Comentários › "Palavras da IA" você libera, uma a uma, as palavras que
apareceram nos comentários que você respondeu. Preço, saúde e agendamento
nunca aparecem lá.
```

- [ ] **Step 6: Rodar tudo**

```bash
pnpm typecheck
pnpm lint
pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
grep -aE "^ *(Test Files|Tests|Errors) " /tmp/vt.log | tail -3
pnpm test:db
```

Expected: typecheck 0, lint 0 erros, `test:unit` exit 0 **sem linha `Errors`**, `test:db` exit 0.

⚠️ O exit code é a autoridade. Rodapé `0 failed` com `exit=1` significa erro não tratado, e a explicação está na linha `Errors`.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/ docs/ .changes/
git commit -m "docs(comentarios): o mapa, a jornada e a prova de tela do vocabulario"
```
