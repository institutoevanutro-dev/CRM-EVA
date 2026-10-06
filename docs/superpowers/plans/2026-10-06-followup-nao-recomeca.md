# Plano TDD: o gatilho de silêncio não recomeça

**Spec:** `docs/superpowers/specs/2026-10-06-followup-nao-recomeca-design.md` (leia antes).

**Revisado depois da revisão (2026-10-06):** paginação para na página vazia (Passo 4);
migration sem backfill e trigger só em status/`kind`/`segments` (Passo 5); caso de vigência
do invariante usa desativar + publicar (Passo 6); ajuste do caso das linhas 334-366 do
invariante e nota no `HANDOFF.md` (Passo 7); `$3 = creds.org_id` (Passo 8).
**Worktree:** `/Users/andreluislopescosta/crm-f2-followup-sweep`, branch `fix/followup-nao-recomeca`.
**Migration:** `0324`, e só ela.

Regras para todo o plano:

- Caminhos absolutos ou `git -C /Users/andreluislopescosta/crm-f2-followup-sweep`.
- `git add` só arquivo por nome, depois de `git status --short`.
- Nunca `.env.local`.
- Um commit por passo verde, em conventional commits e português, terminando com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

`W=/Users/andreluislopescosta/crm-f2-followup-sweep` nos comandos abaixo.

Cada passo tem o mesmo formato:

- **RED:** o teste que falha primeiro, e por quê.
- **GREEN:** a mudança mínima.
- **Verificar:** o comando.
- **Sabotar:** o que se desfaz para ver o teste ficar vermelho de novo, depois restaurar. Sabotagem que não fica vermelha é teste sem lastro, e o passo não fecha.

---

## Passo 0: ponto de partida

1. `git -C $W status --short`. Tem de estar limpo, salvo os dois docs deste trabalho.
2. `git -C $W fetch -q origin main && git -C $W merge --ff-only origin/main`. Se não for fast-forward, use `merge origin/main`, nunca reset.
3. Confirme que a `0324` está livre:

   ```bash
   git -C $W ls-tree --name-only origin/main supabase/migrations/ | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1
   ```

   O resultado tem de ser `< 0324`. Se aparecer `0324`, pare e avise.
4. Linha de base dos arquivos que este trabalho toca:

   ```bash
   cd $W && pnpm vitest run lib/followup/silence-sweep-pre-go-live.test.ts \
     tests/unit/fronteira-exige-procedencia-e-o-backfill-cobre-o-legado.test.ts \
     tests/unit/sweep-nao-cobra-conversa-encerrada.test.ts > /tmp/base.log 2>&1; echo "exit=$?"
   pnpm test:db tests/invariants/followup-silence-sweep.test.ts > /tmp/base-db.log 2>&1; echo "exit=$?"
   ```

   Os dois têm de dar `exit=0`. Se algo falhar já aqui, é pré-existente: registre no PR com o nome do arquivo e o rodapé.

---

## Passo 1: porte de `8e50867db` (não tentar inscrever quem já está vivo)

Porte quase literal. Mantenha nomes, comentário e lote de 100 iguais ao original.

**RED**

- `lib/followup/silence-sweep-inscricao-viva.test.ts`: copie de `git show 8e50867db:lib/followup/silence-sweep-inscricao-viva.test.ts` e adapte o fake à interface DESTE fork:
  - `loadTriggerNodeId` em vez de `loadTriggerNode`;
  - sem `loadContatosComRetornoVivo` e sem `loadContactIdsEmCooldown`;
  - `gateDb` devolvendo um agente que arma `p-1`, porque aqui gate-out é `null` e não há texto-fixo-sem-agente.

  Casos:
  - (a) quem está vivo é pulado SEM chamar `insertEnrollment`, e conta `skipped_existing`;
  - (b) se o insert ainda devolver `inserted:false` (corrida), conta `skipped_existing`.

  Falha porque `loadContatosComInscricaoViva` não existe.
- `lib/followup/silence-sweep-inscricao-viva-query.test.ts`: copie de `git show 8e50867db:lib/followup/silence-sweep-inscricao-viva-query.test.ts`. Ele prova:
  - `from("followup_enrollments")`;
  - `eq organization_id`;
  - `in status` com os quatro vivos;
  - sem filtro de `pointer_id`;
  - lotes de 100 (250 contatos viram 3 consultas).

**GREEN** em `lib/followup/silence-sweep.ts`, como no original:

- `const STATUS_VIVOS = ["active","waiting_reply","paused_handoff","paused_manual"] as const;`
- `const LOTE_DE_CONTATOS = 100;`
- Método na interface `SilenceSweepDb`, com o JSDoc do original.
- Implementação no adaptador.
- No laço de `runSilenceSweep`, antes do `insertEnrollment`:
  - `const comInscricaoViva = await db.loadContatosComInscricaoViva(pointer.organization_id, contactIds);`
  - `if (comInscricaoViva.has(contactId)) { summary.skipped_existing++; continue; }`

**Invariante** (`tests/invariants/followup-silence-sweep.test.ts`):

- O espelho SQL ganha o método, igual ao do original:

  ```sql
  select distinct contact_id from followup_enrollments
  where organization_id=$1 and contact_id=any($2::uuid[])
    and status in (...4 vivos...)
  ```

- O teste `RED→GREEN … índice ANTIGO (pointer,contact)` (linha ~661) passa a usar `db: { ...silenceSweepDb(), loadContatosComInscricaoViva: async () => new Set<string>() }`, com o comentário do original. Ele mede o índice, não o pré-filtro.
- Caso novo, portado: "com o pré-filtro, o 2º fluxo nem TENTA inscrever quem já está vivo". Três varreduras, uma única tentativa de insert.

**Verificar**

```bash
cd $W && pnpm vitest run lib/followup/silence-sweep-inscricao-viva*.test.ts > /tmp/p1.log 2>&1; echo "exit=$?"
pnpm test:db tests/invariants/followup-silence-sweep.test.ts > /tmp/p1-db.log 2>&1; echo "exit=$?"
```

**Sabotar:** apague o `if (comInscricaoViva.has…)`. O unit (a) e o caso novo do invariante ficam vermelhos.

**Commit:** `fix(followup): a varredura de silêncio não tenta inscrever quem já tem follow-up vivo (porte de 8e50867db)`.

---

## Passo 2: refatoração sem mudança de comportamento (`loadSilentContacts` devolve fatos)

As regras dos passos 5 e 6 precisam de três fatos por contato:

- `sent_at` da mensagem qualificante, para o limiar e a vigência;
- `created_at` dela, para o episódio;
- o id.

**RED:** atualize os consumidores para a forma nova. O typecheck quebra até o GREEN.

- `lib/followup/silence-sweep-pre-go-live.test.ts:67`.
- `tests/unit/fronteira-exige-procedencia-e-o-backfill-cobre-o-legado.test.ts:93,99`.
- `tests/unit/sweep-nao-cobra-conversa-encerrada.test.ts:75,86`.
- `tests/e2e/encerramento-atendimento.spec.ts:294-305`.

O método passa a se chamar `loadSilentContacts`. Onde o teste compara ids, compare `(await …).map((c) => c.contact_id)`. No `pre-go-live`, o fake da mensagem ganha `created_at`.

**GREEN** em `silence-sweep.ts`:

- `export interface ContatoEmSilencio { contact_id: string; ultima_entrada_em: string; ultima_entrada_gravada_em: string }`.
- `loadSilentContacts(orgId, cutoffIso, segments): Promise<ContatoEmSilencio[]>`.
- O embed de `messages` passa a selecionar também `created_at`.
- O `latest` guarda `sentAt` e `createdAt`.
- `runSilenceSweep` itera `contatos` e usa `c.contact_id`. Sem regra nova.
- O espelho SQL do invariante devolve `{ contact_id, ultima_entrada_em: last_inbound_at, ultima_entrada_gravada_em: last_inbound_at }`. O seed do invariante não cria mensagens, então as duas datas são iguais; isso está comentado no espelho.

**Verificar:** `pnpm typecheck`, os três unitários acima e `pnpm test:db tests/invariants/followup-silence-sweep.test.ts`. Tudo tem de ficar verde sem mudar nenhuma asserção de comportamento.

**Commit:** `refactor(followup): a varredura de silêncio lê os fatos da última mensagem, não só o id`.

---

## Passo 3: anonimizado fica fora da inscrição

**RED** em `lib/followup/silence-sweep-consultas.test.ts` (novo). O dublê de cliente é o do `pre-go-live`, que devolve as linhas dadas. Casos:

- (a) Duas conversas abertas e caladas: contato `anon`, com `contacts.is_anonymized: true`, e contato `vivo`. Só `vivo` volta.
- (b) A consulta pede `is_anonymized` no embed de `contacts`. Registre a cadeia do `.select` e procure a string.

Falha porque o embed não pede a coluna e o filtro não existe.

**GREEN** em `silence-sweep.ts`:

- `ContactEmbed` ganha `is_anonymized: boolean | null`.
- O `.select` embute `contacts:contact_id(tags, is_blocked, is_anonymized, ai_authorized_at, phone_number)`.
- O `latest` guarda `anonymized`.
- No laço final: `if (v.blocked || v.anonymized) continue;`.

**Invariante:**

- `seedContact` ganha a opção `isAnonymized`. Grava `is_anonymized=true, anonymized_at=now()`, por causa do CHECK `contacts_anonymized_locked`.
- O espelho SQL filtra `c.is_anonymized`.
- Caso: um contato anonimizado calado há 90 min, com o fluxo armado, fica com 0 inscrições depois de 3 varreduras.

O caso do invariante prova o espelho. A prova da produção é o unitário. Escreva essa ressalva no caso, no molde de `sweep-nao-cobra-conversa-encerrada.test.ts:12-25`.

**Verificar:** `pnpm vitest run lib/followup/silence-sweep-consultas.test.ts` e `pnpm test:db tests/invariants/followup-silence-sweep.test.ts`.

**Sabotar:** tire `|| v.anonymized`. O unit (a) fica vermelho.

**Commit:** `fix(followup): contato anonimizado não entra no gatilho de silêncio`.

---

## Passo 4: paginação determinística das conversas

**RED** em `lib/followup/silence-sweep-consultas.test.ts`. O dublê, com estado, honra a consulta:

- guarda `limit(n)` (o sem `referencedTable`), `gt("id", x)` e `order("id")`;
- devolve as linhas com `id > x`, ordenadas, e no máximo `n` delas.

Casos:

- (a) 1200 conversas de 1200 contatos distintos, todas caladas: voltam os **1200** ids.
- (b) A consulta pede `order("id", { ascending: true })` e `limit(500)` no nível das conversas.
- (c) Um dublê que devolve sempre a mesma página cheia de 500 faz o método **lançar** `silence_page_did_not_advance`, em vez de laço infinito.

Falha porque hoje há uma chamada só, sem `order` nem `limit`. O dublê sem `limit` devolve tudo, então (a) passaria por acaso. Por isso o dublê de (a) também aplica um `max_rows` de 1000 quando não há `limit`, imitando o PostgREST. Assim o código atual devolve 1000 e falha.

**GREEN** em `loadSilentContacts`:

```ts
// Keyset; só página VAZIA prova o fim (o max_rows é ajustável no painel do
// Supabase — mesma regra de lib/agenda/protecao-followup.ts).
const LIMITE_DE_CONVERSAS = 500;
let depois: string | undefined;
for (;;) {
  let q = admin.from("conversations").select(/* igual */)/* filtros iguais */
    .order("id", { ascending: true }).limit(LIMITE_DE_CONVERSAS);
  if (depois) q = q.gt("id", depois);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const pagina = (data ?? []) as unknown as Row[];
  if (pagina.length === 0) break;
  rows.push(...pagina); // o corpo atual do laço roda depois, sobre `rows`
  const ultimo = pagina[pagina.length - 1]!.id;
  if (depois && ultimo <= depois) throw new Error("silence_page_did_not_advance");
  depois = ultimo;
}
```

Os dublês de `silence-sweep-pre-go-live.test.ts` e `fronteira-exige-procedencia-…test.ts` passam a devolver `[]` a partir da 2ª chamada de `then` (o de `sweep-nao-cobra-…` já devolve `[]` sempre). Caso a mais no RED: (d) com `max_rows` 200 no dublê e 450 conversas, voltam as 450 em 4 consultas (200 + 200 + 50 + vazia). Sabotagem extra: parar na página curta deixa (d) vermelho.

**Verificar:**

```bash
cd $W && pnpm vitest run lib/followup/silence-sweep-consultas.test.ts lib/followup/silence-sweep-pre-go-live.test.ts \
  tests/unit/fronteira-exige-procedencia-e-o-backfill-cobre-o-legado.test.ts tests/unit/sweep-nao-cobra-conversa-encerrada.test.ts \
  > /tmp/p4.log 2>&1; echo "exit=$?"
```

**Sabotar:** troque o `for (;;)` por uma única volta. O caso (a) fica vermelho, com 1000 em vez de 1200.

**Commit:** `fix(followup): a varredura de silêncio lê todas as conversas, não as primeiras 1000`.

---

## Passo 5: migration 0324 (índice, `active_since` e trigger de vigência)

**RED.** No invariante, um `describe` novo, "vigência do ponteiro (active_since)". O banco vem do `baseline.sql`, então falha enquanto o apêndice não existe. Casos:

- (a) `insert` de ponteiro ativo: `active_since` fica perto de `now()` (±5 s).
- (b) `update … set active_version_id = <outra versão>` num fluxo já ativo (republicar, rollback): `active_since` **não** muda.
- (c) `update … set status='disabled'` e depois `'active'`: avança nas duas vezes.
- (d) `update … set trigger_config` trocando o `kind`, ou os `segments`: avança.
- (e) `update … set draft_graph = …, name = …, handoff_policy = …`: **não** muda (compare igual).
- (f) `update … set trigger_config = <o mesmo jsonb>`, e depois mudando só o limiar e o `cancel_on_reply` (com `segments` ausente no lugar de `[]`): **não** muda.
- (g) O índice `idx_followup_enrollments_pointer_contact_cooldown` existe, com as colunas `(organization_id, pointer_id, contact_id, updated_at)`.
- (h) `has_function_privilege('anon', 'public.fn_followup_ponteiro_marca_vigencia()', 'execute')` é `false`, e o mesmo para `public`.

Para medir o avanço em (c) e (d), e o não-avanço em (b), (e) e (f), primeiro recue `active_since` para `now() - interval '1 day'` com um update que só mexe nessa coluna. O trigger não dispara nesse update, e isso também fica provado.

**GREEN.** Antes de criar o arquivo, confira a numeração com o comando do Passo 0, item 3. Crie `supabase/migrations/20261006120000_0324_silencio_nao_recomeca.sql`:

```sql
-- 0324: o gatilho de silêncio não recomeça (spec docs/superpowers/specs/2026-10-06-followup-nao-recomeca-design.md)
-- (1) índice: porte idêntico do 0411 do DeskcommCRM original (2240b215e) — mesmo nome e
--     colunas para que um merge futuro do 0411 seja no-op; a consulta de episódio usa o prefixo.
create index if not exists idx_followup_enrollments_pointer_contact_cooldown
  on public.followup_enrollments (organization_id, pointer_id, contact_id, updated_at);

-- (2) vigência: desde quando o ponteiro vale com o status e o gatilho (kind, segments) atuais.
--     Sem backfill: not null default now() num comando só (spec §4.2).
alter table public.followup_flow_pointers
  add column if not exists active_since timestamptz not null default now();
comment on column public.followup_flow_pointers.active_since is '...';  -- texto da spec §4.2

create or replace function public.fn_followup_ponteiro_marca_vigencia()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.active_since := now();
  return new;
end $$;
revoke execute on function public.fn_followup_ponteiro_marca_vigencia() from public, anon, authenticated;

drop trigger if exists trg_followup_ponteiro_marca_vigencia on public.followup_flow_pointers;
create trigger trg_followup_ponteiro_marca_vigencia
  before update on public.followup_flow_pointers
  for each row
  when (old.status is distinct from new.status
     or old.trigger_config ->> 'kind' is distinct from new.trigger_config ->> 'kind'
     or coalesce(old.trigger_config -> 'params' -> 'segments', '[]'::jsonb)
        is distinct from coalesce(new.trigger_config -> 'params' -> 'segments', '[]'::jsonb))
  execute function public.fn_followup_ponteiro_marca_vigencia();
```

Sem backfill (spec §4.2): o backfill com `set default`/`set not null` depois abria uma corrida no `update.sh` (app antigo grava NULL entre os comandos, e o `set not null` falha calado sem `ON_ERROR_STOP`) e reabria o passado de fluxo publicado há meses e armado agora. Na reaplicação, `add column if not exists` vira no-op. Use o **mesmo** texto nos dois artefatos.

Os outros artefatos:

- **`supabase/baseline.sql`:** bloco `-- ---- o gatilho de silêncio não recomeça (migration 0324) ----` com o mesmo SQL, logo **antes** de `-- ---- VARREDURA anon` (hoje na linha 33411). O corpo da função tem de ser idêntico ao da migration, porque `apendice-do-baseline-nao-diverge-da-cadeia.test.ts` compara.
- **`supabase/migrations/MANIFEST.md`:** uma linha na tabela, no formato das vizinhas. Diga o quê (índice portado, `active_since` com trigger, sem backfill e por quê), o porquê (defeitos 2 e da §2.3), "nenhum dado reescrito" e "função de trigger sem EXECUTE para ninguém".
- **`lib/database.types.ts`:** `active_since: string` em Row, e `active_since?: string` em Insert e Update de `followup_flow_pointers`.

**Verificar:**

```bash
cd $W && pnpm test:db tests/invariants/followup-silence-sweep.test.ts > /tmp/p5-db.log 2>&1; echo "exit=$?"
pnpm vitest run tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts tests/unit/manifest-x-migrations.test.ts \
  tests/unit/baseline-reaplicavel.test.ts tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts > /tmp/p5.log 2>&1; echo "exit=$?"
```

O `test:db` aplica o baseline em modo install (`ON_ERROR_STOP=1`) e reaplica (update). Os dois têm de passar. (O `pnpm test:db:update` não exercitaria backfill nenhum — aplica o baseline atual e reaplica, sem semear ponteiros —, e por isso a decisão foi não ter backfill.)

**Sabotar:**

- Tire os `segments` do `WHEN`: (d) fica vermelho.
- Troque o `WHEN` por `true`: (b), (e) e (f) ficam vermelhos.
- Tire o `revoke`: (h) fica vermelho.

**Commit:** `feat(followup): ponteiro registra desde quando vale (active_since) e índice da consulta de episódio — migration 0324`.

---

## Passo 6: sem passado (silêncio anterior à vigência não conta)

**RED**

- Unit em `lib/followup/silence-sweep-episodio.test.ts` (novo), com fake de `SilenceSweepDb`:
  - (a) Ponteiro com `active_since = 12:00`. Contato com `ultima_entrada_em = 11:59`, calado: **sem** insert, e `skipped_before_activation = 1`.
  - (b) Igual, com `ultima_entrada_em = 12:01`: insert. Também `ultima_entrada_em = 12:00` exato: **sem** insert, porque a regra é "posterior".
- Invariante:
  - `seedSilenceFlow` passa a semear `active_since = now() - interval '30 days'` por padrão, com a opção `activeSince`. Sem isso, todos os casos antigos quebrariam, porque semeiam silêncio no passado.
  - Caso: o fluxo é semeado com `activeSince: now()` e o contato está calado há 90 min. Resultado: 0 inscrições.
  - Caso: o fluxo tem vigência de 30 dias atrás, o contato está calado há 90 min e ele é inscrito. Depois disso, o fluxo é desativado e publicado de novo (`status` disabled → active; o trigger avança a vigência) e um segundo contato, calado há 90 min, **não** é inscrito.
- Espelho SQL: `loadActiveSilencePointers` seleciona `active_since::text`.

**GREEN**

- `SilencePointer` ganha `active_since: string`.
- O adaptador seleciona `active_since` em `loadActiveSilencePointers`. O unit de consulta prova que a coluna está no `select`.
- Em `runSilenceSweep`, depois de `loadSilentContacts`:

  ```ts
  const vigencia = Date.parse(pointer.active_since);
  const candidatos = contatos.filter((c) => {
    if (Date.parse(c.ultima_entrada_em) > vigencia) return true;
    summary.skipped_before_activation++;
    return false;
  });
  if (candidatos.length === 0) continue;
  ```

- `SilenceSweepSummary` ganha `skipped_before_activation: number`. Ele **não** entra em `route.ts:127` nem em `executar.ts:137`.

**Verificar:** `pnpm vitest run lib/followup/silence-sweep-episodio.test.ts` e `pnpm test:db tests/invariants/followup-silence-sweep.test.ts`.

**Sabotar:** troque `>` por `>=`; o unit (b) exato fica vermelho. Tire o filtro; (a) e o caso do invariante ficam vermelhos.

**Commit:** `fix(followup): o gatilho de silêncio não pega quem calou antes de o fluxo valer`.

---

## Passo 7: dedup por episódio

**RED**

- Unit, em `silence-sweep-episodio.test.ts`:
  - (c) `loadUltimaInscricaoNoPonteiro` devolve `{A: "12:30"}` e A tem `ultima_entrada_gravada_em = "12:00"`: **sem** insert, e `skipped_same_episode = 1`. A regra **não olha status**: o fake nem informa.
  - (d) `{A: "11:00"}` com entrada gravada às 12:00, ou seja, respondeu depois: insert.
  - (e) Igualdade, `started_at` igual à entrada: **sem** insert (`>=`).
  - (f) O `desdeIso` passado ao adaptador é o **menor** `ultima_entrada_gravada_em` dos candidatos.
  - (g) Ordem: contato do mesmo episódio **e** vivo conta `skipped_same_episode`, não `skipped_existing`.
- Unit de consulta, em `silence-sweep-consultas.test.ts`:
  - `loadUltimaInscricaoNoPonteiro` pede `followup_enrollments`, `eq organization_id`, `eq pointer_id`, `in contact_id` (lotes de 100), `gte started_at desde`, `order id` e `limit 500`, com keyset;
  - reduz várias linhas do mesmo contato ao **maior** `started_at`.
- Invariante, caso existente das linhas 334-366 ("pointer silence habilitado … 2ª varredura não duplica"): o contato vivo DESTE ponteiro passa a contar `skipped_same_episode`, não `skipped_existing`. Troque as asserções da 2ª varredura por `summary2.skipped_same_episode >= 1` e `summary2.skipped_existing === 0`, e o comentário ("mesmo episódio — nem tenta, nem audita"). O caso vira também a prova de que vivo do mesmo ponteiro não gera auditoria.
- Invariante, `describe("episódio de silêncio — a sequência não recomeça")`:
  - Para cada status `completed`, `dead` e `cancelled` (este com `cancel_reason='atendimento_humano'`):
    - o contato está calado há 90 min;
    - uma inscrição desse status começou há 60 min, depois da última entrada;
    - três varreduras;
    - `countEnrollments` continua 1.
  - **Reabre com resposta:**
    - a inscrição `completed` começou há 60 min;
    - a conversa recebe `last_inbound_at = now() - 40 min` (o contato respondeu depois);
    - o limiar é 30;
    - uma varredura inscreve, e `countEnrollments` vai a 2.
  - **Laço real fechado ponta a ponta:**
    - a varredura inscreve;
    - `update` para `completed` (como o End faria);
    - mais duas varreduras;
    - continua 1.

    Este é o RED que reproduz o defeito 1 sem fixture de inscrição.
- Espelho SQL:

  ```sql
  select contact_id, max(started_at)::text as ultima from followup_enrollments
  where organization_id=$1 and pointer_id=$2 and contact_id=any($3::uuid[])
    and started_at >= $4
  group by contact_id
  ```

**GREEN**

- Interface: `loadUltimaInscricaoNoPonteiro(orgId, pointerId, contactIds, desdeIso): Promise<Map<string, string>>`.
- Adaptador: lotes de 100 por `in`; dentro de cada lote, keyset por `id` (página de 500, parada na página VAZIA, trava contra não avançar). Reduz ao maior `started_at`.
- Em `runSilenceSweep`, depois do filtro de vigência:

  ```ts
  const desde = candidatos.reduce((m, c) => (c.ultima_entrada_gravada_em < m ? c.ultima_entrada_gravada_em : m), candidatos[0]!.ultima_entrada_gravada_em);
  const ultimaInscricao = await db.loadUltimaInscricaoNoPonteiro(pointer.organization_id, pointer.id, candidatos.map((c) => c.contact_id), desde);
  const comInscricaoViva = await db.loadContatosComInscricaoViva(pointer.organization_id, candidatos.map((c) => c.contact_id));
  for (const c of candidatos) {
    const inscrita = ultimaInscricao.get(c.contact_id);
    if (inscrita && Date.parse(inscrita) >= Date.parse(c.ultima_entrada_gravada_em)) { summary.skipped_same_episode++; continue; }
    if (comInscricaoViva.has(c.contact_id)) { summary.skipped_existing++; continue; }
    // insertEnrollment como hoje
  }
  ```

  Compare por `Date.parse`, não por string: o Postgres e o JS formatam o ISO de jeitos diferentes. O `reduce` acima também tem de comparar por `Date.parse`; troque ao implementar.
- `SilenceSweepSummary` ganha `skipped_same_episode`, fora da auditoria.
- Reescreva o cabeçalho de `silence-sweep.ts:24-30`: tire "aceitável no MVP, sem cooldown table" e descreva o episódio, a vigência e o porte do original. Afirmação de estado desatualizada é o item 16 da DoD. No mesmo commit, anote `HANDOFF.md:186-187` ("pode re-enrollar … aceitável no MVP") e o cabeçalho de `tests/invariants/followup-reenrollment-apos-conclusao.test.ts`, que cita a frase antiga.

**Verificar:** `pnpm vitest run lib/followup/silence-sweep-episodio.test.ts lib/followup/silence-sweep-consultas.test.ts` e `pnpm test:db tests/invariants/followup-silence-sweep.test.ts`.

**Sabotar:**

- Tire o `if (inscrita …)`: os três casos de status e o "laço real" ficam vermelhos no invariante, e (c) no unit.
- Troque `>=` por `>`: (e) fica vermelho.
- Na consulta, troque `gte` por `gt`, ou tire o `pointer_id`: o unit de consulta fica vermelho.

**Commit:** `fix(followup): o gatilho de silêncio inscreve uma vez por episódio — a sequência não recomeça sozinha`.

---

## Passo 8: as specs E2E que semeiam silêncio anterior à publicação

`followup-journey.spec.ts` e `j20-elegibilidade-followup.spec.ts` (as duas no CI) publicam o fluxo e **depois** semeiam um inbound de `threshold + 5` min atrás. Pela regra do passo 6, ele é anterior à vigência. Sem ajuste, as duas falham.

**RED:** rode as duas specs. Ambiente: banco do baseline, `next build` + `next start`, como na receita de ambiente fresco do CLAUDE.md. Elas falham em "varredura de silêncio não enrollou o contato a tempo".

**GREEN:**

- Subcomando `recuar-vigencia <pointerId> <minutos>` em `scripts/e2e-followup-journey-helpers.ts` e em `scripts/e2e-elegibilidade-helpers.ts`:

  ```sql
  update followup_flow_pointers set active_since = now() - ($2 || ' minutes')::interval
  where id = $1 and organization_id = $3
  ```

  `$3 = creds.org_id`, sem argumento novo, como os outros subcomandos fazem (`scripts/e2e-followup-journey-helpers.ts:107`, `scripts/e2e-elegibilidade-helpers.ts:208`).

  O trigger não dispara porque só `active_since` muda.
- Cada spec chama o subcomando logo depois de publicar, com `threshold + 60`.
- Comentário na spec: "recua a vigência porque o contato semeado calou antes da publicação; a regra 'sem passado' (migration 0324) recusaria".

**Verificar:** as duas specs verdes, com screenshot em `.superpowers/evidence/`. Se o ambiente local não subir, diga isso no PR e deixe o `e2e` do CI como prova. Não declare verde sem ter rodado.

**Commit:** `test(e2e): specs de silêncio recuam a vigência do fluxo que semeiam`.

---

## Passo 9: fragmento, mapa e DoD

- **`.changes/silencio-nao-recomeca.md`:**
  - `impacto: nada_mudou`, `secao: corrigido`;
  - título: "A sequência de retomada não recomeça sozinha";
  - corpo para leigo: uma vez por silêncio, recomeça só depois de uma resposta, contato antigo não recebe nada ao ligar o fluxo, anonimizado fica fora;
  - a dica de desativar e publicar de novo o fluxo depois de armar o agente (republicar um fluxo já ativo não zera a vigência);
  - que "qualquer resposta encerra a sequência" exige "cancelar ao responder" ligado no gatilho (vem desligado);
  - "Nenhuma ação é necessária".

  Confira com `pnpm release:conferir`.
- **`docs/testing/user-journey-map.md`:** acrescente os casos novos na jornada de follow-up por silêncio, como achado com o conserto.
- **`docs/architecture/`:** se houver mapa do follow-up, acrescente `active_since` e o trigger, com pelo menos duas arestas: o ponteiro grava, e a varredura lê.

---

## Passo 10: verificação final (a suíte, não os gates de que você lembra)

```bash
cd $W
pnpm typecheck > /tmp/tc.log 2>&1; echo "typecheck exit=$?"
pnpm lint > /tmp/lint.log 2>&1; echo "lint exit=$?"
pnpm test:unit > /tmp/vt.log 2>&1; echo "unit exit=$?"
grep -aE "Test Files|Tests |Errors " /tmp/vt.log | tail -3
grep -aE "^ *FAIL " /tmp/vt.log | sed 's/ > .*//' | sort | uniq -c
pnpm test:db > /tmp/db.log 2>&1; echo "db exit=$?"
pnpm test:db:update > /tmp/dbu.log 2>&1; echo "db:update exit=$?"
```

Leia as saídas assim:

- **O exit code é a autoridade.** Compare o rodapé com o `grep FAIL`. Se divergirem, rode de novo com `--reporter=verbose`.
- **Falha que não é sua:** prove rodando o arquivo isolado e lendo o mesmo trecho na `origin/main`. Registre no PR o nome do arquivo e o motivo.
- **`rate-limit.test.ts`:** só falha com `.env.local`, que este worktree não tem.

**Tabela de sabotagens para o PR.** Cada linha leva o teste que ficou vermelho e o rodapé:

| Conserto | Sabotagem | Teste que fica vermelho |
|---|---|---|
| Pré-filtro de vivos (porte) | tirar o `has` | `silence-sweep-inscricao-viva.test.ts` (a); invariante "nem TENTA" |
| Anonimizado | tirar `\|\| v.anonymized` | `silence-sweep-consultas.test.ts` anonimizado |
| Paginação | uma volta só | `silence-sweep-consultas.test.ts` 1200 |
| Trigger de vigência | `trigger_config` fora do `WHEN` / `WHEN true` | invariante vigência (d) / (e) |
| Revogação | tirar o `revoke` | invariante vigência (h) |
| Sem passado | tirar o filtro / `>=` | `silence-sweep-episodio.test.ts` (a)/(b); invariante |
| Episódio | tirar o `if` / `>` | `silence-sweep-episodio.test.ts` (c)/(e); invariante três status + laço real |

Antes do PR, siga a skill `deskcomm-contribuir`: branch atualizada, tripla de migration, fragmento e prova.
