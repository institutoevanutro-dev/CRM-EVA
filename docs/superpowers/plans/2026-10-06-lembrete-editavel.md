# Plano: lembrete da agenda editável (TDD)

Spec: `docs/superpowers/specs/2026-10-06-lembrete-editavel-design.md`. Leia o spec antes de começar.

Worktree: `/Users/andreluislopescosta/crm-f2-lembrete`, branch `feat/lembrete-editavel`.
Abreviação usada abaixo: `W=/Users/andreluislopescosta/crm-f2-lembrete`. Use sempre caminhos
absolutos ou `git -C $W`.

## Regras de todo passo

- **Vermelho primeiro.** Escreva ou porte o teste, rode e veja falhar **pelo motivo certo**.
  Só então mude o código, rode de novo e veja verde.
- **Commit por passo**, em conventional commits em português, com
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` no fim. Adicione os arquivos
  **pelo nome** (nunca `-A` ou `.`) e confira `git -C $W status --short` antes de cada commit.
- **Porte com rastro.** Quando o passo porta um commit do original, a mensagem diz
  `Porte de <sha> do DeskcommCRM original (#issue)` e o que foi adaptado. Para trazer o
  arquivo do original, use `git -C $W show <sha>:<caminho>` e aplique os hunks à mão sobre o
  fonte do fork. O `cherry-pick` conflita, porque o contexto do original tem
  `ehOperante`/`organizations!inner` e `reminder_bodies`, que o fork não tem.
- Saída de teste vai para o scratchpad, nunca para `/tmp` e nunca cortada com `tail`:
  `pnpm --dir $W vitest run <arquivo> > $S/vt.log 2>&1; echo "exit=$?"`, com
  `S=/private/tmp/claude-501/-Users-andreluislopescosta-CRM-EVA/593e1a6a-d6d4-440d-bbe0-937b5ad1210e/scratchpad`.
  Leia o exit code, o rodapé (`Test Files`/`Tests`/`Errors`) e a lista de `FAIL`.
- Não crie `.env.local`. Não toque em `lib/channels/pos-entrada.ts`.

---

## Passo 0: base

```bash
git -C $W fetch -q origin main
git -C $W status --short          # só os docs deste plano
git -C $W merge --ff-only origin/main   # se a main andou e a branch não tem commit próprio além dos docs, use merge normal
git -C $W ls-tree --name-only origin/main supabase/migrations/ | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1
```

O último comando tem que devolver **< 0323** e nenhum arquivo `_0323_` pode existir na
`origin/main`. Se existir, **pare** e escale: o número é reservado.

Linha de base da suíte (para separar falha pré-existente de falha nova):

```bash
pnpm --dir $W test:unit > $S/vt-base.log 2>&1; echo "exit=$?"
grep -aE "^ *(Test Files|Tests|Errors) " $S/vt-base.log
grep -aE "^ *FAIL " $S/vt-base.log | sed 's/ > .*//' | sort | uniq -c
```

Guarde a lista de falhas da base em `$S/falhas-base.txt`.

---

## Passo 1: porte do `6ed38c78c` + `b85d7615d` (degrau vencido na marcação; carimbo antes do envio)

**Teste vermelho.** Crie `lib/agenda/aviso-do-compromisso-lembrete.test.ts` com a versão do
`6ed38c78c` (`git -C $W show 6ed38c78c:lib/agenda/aviso-do-compromisso-lembrete.test.ts`).
Ela importa `degrausPendentes` do `route.ts` e passa `criadoEm`. Rode e veja falhar: o caso
"marcada às 18:30 para as 16h do dia seguinte: NÃO sai" devolve `[1440]`.

Acrescente ao `app/api/v1/cron/agenda-reminder/route.test.ts` um caso estrutural novo,
"o carimbo vem ANTES do envio e o erro dele é tratado":

- `fonte.indexOf("reminder_sent_at: new Date()") < fonte.indexOf("sendMessageHandler(")`;
- a fonte contém `pular("carimbo_falhou")`.

Vermelho hoje: o carimbo está depois do envio, em `route.ts:380-389`.

**Mudança mínima** em `app/api/v1/cron/agenda-reminder/route.ts`, copiando os hunks do
`6ed38c78c` e do `b85d7615d`:

- o parágrafo novo no cabeçalho;
- `created_at` em `CompromissoAVencer` e na consulta;
- `vencidoNaMarcacao` exportada;
- `criadoEm` em `degrausPendentes`;
- o carimbo antes do envio, com `erroCarimbo` → `logger.error` + `pular("carimbo_falhou")`;
- `espacarEnvio` dentro do `try`.

**Não** traga `organizations!inner(status)` nem `ehOperante`.

**Verificar:**

```bash
pnpm --dir $W vitest run lib/agenda/aviso-do-compromisso-lembrete.test.ts app/api/v1/cron/agenda-reminder/route.test.ts > $S/vt.log 2>&1; echo "exit=$?"
```

**Commit:** `fix(agenda-lembrete): degrau vencido na marcação não dispara e o carimbo vem antes do envio`
(porte de 6ed38c78c e b85d7615d).

---

## Passo 2: porte do `9e5027f1f` (régua da remarcação), abrindo a migration 0323

**Testes vermelhos.**

1. `tests/unit/remarcacao-carimba-quando-o-horario-foi-marcado.test.ts`: versão do
   `9e5027f1f`, com duas trocas:
   - `MIGRATION` aponta para `20261006120000_0323_lembrete_editavel.sql`;
   - `BLOCO` = `-- ---- lembrete editável e régua da remarcação (migration 0323) ----`.

   Vermelho: o arquivo não existe.
2. Os casos `describe("remarcação reposiciona a régua (#2230)")` do
   `lib/agenda/aviso-do-compromisso-lembrete.test.ts` na versão do `9e5027f1f` (ou o arquivo
   inteiro dessa versão). Vermelho: `remarcadoEm` é ignorado.
3. O bloco `describe("a rota lê a régua da remarcação (#2230)")` do `route.test.ts` do
   `9e5027f1f`, anexado ao fim do arquivo do fork.

**Mudança mínima:**

- Arquivo novo `supabase/migrations/20261006120000_0323_lembrete_editavel.sql`. Comece com
  o cabeçalho no padrão do repo (`-- 20261006120000_0323_lembrete_editavel.sql` / `-- 0323 — …`)
  e o corpo da `0536` do original, idêntico: coluna `starts_at_marked_at`, `comment`,
  `fn_starts_at_marked_at` com `set search_path = ''`, `revoke … from public, anon, authenticated`,
  `grant … to service_role`, `drop trigger if exists` + `create trigger trg_starts_at_marked_at before update of starts_at`.
  O cabeçalho cita "porte da 0536 do original (9e5027f1f)".
- `supabase/baseline.sql`: o mesmo bloco, rotulado como em `BLOCO`, inserido **depois** de
  `-- ---- fim: travas no banco (migration 0319) ----` e **antes** de
  `-- ---- VARREDURA anon: …` (hoje `baseline.sql:33409-33411`). Confira a posição com `grep -n`.
- `supabase/migrations/MANIFEST.md`: linha nova `20261006120000 | 0323_lembrete_editavel`,
  descrevendo o quê, o porquê e o porte. A linha cresce no passo 5.
- `lib/database.types.ts`: `starts_at_marked_at: string | null` (Row) e `?: string | null`
  (Insert/Update) em `calendar_appointments`, como no `9e5027f1f`.
- `route.ts`: hunks do `9e5027f1f`. Comentários, `starts_at_marked_at` na interface e na
  consulta, `remarcadoEm` em `degrausPendentes` (`input.remarcadoEm ?? input.criadoEm ?? null`)
  e o repasse na chamada.

**Verificar:** os três arquivos de teste acima, mais
`tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts`,
`tests/unit/manifest-x-migrations.test.ts` e `tests/unit/baseline-reaplicavel.test.ts`.

**Commit:** `fix(agenda-lembrete): a remarcação reposiciona a régua do degrau vencido`
(porte de 9e5027f1f; a 0536 do original vira a 0323).

---

## Passo 3: porte do `5c6c8d6f3` + `e174c8484` (remarcar para mais longe rearma, com as duas guardas)

**Testes vermelhos.** Troque `lib/agenda/aviso-do-compromisso-lembrete.test.ts` pela versão do
`e174c8484`, que inclui os blocos #2243 e "os outros lados do rearma". Acrescente ao
`route.test.ts` o bloco `describe("a rota repassa o instante do último carimbo (#2243)")` do
`5c6c8d6f3`. Vermelho: "a véspera sai para a data antiga, a reunião é movida e a data nova
GANHA lembrete" devolve `[]`.

**Mudança mínima** em `route.ts`:

- `reminder_sent_at` na interface e na consulta;
- `enviadoEm` em `degrausPendentes`;
- o laço de rearme na forma final do `e174c8484` (`input.enviadoEm && input.remarcadoEm`, régua
  de meio intervalo);
- `enviadoEm: linha.reminder_sent_at ? … : null` na chamada;
- os parágrafos de cabeçalho dos dois commits.

**Verificar:** os dois arquivos de teste.

**Commit:** `fix(agenda-lembrete): remarcar para mais longe rearma o degrau da data nova`
(porte de 5c6c8d6f3 e e174c8484).

---

## Passo 4: a ferramenta MCP diz a verdade

**Teste vermelho.** Em `app/api/v1/cron/agenda-reminder/route.test.ts` (ou num
`tests/unit/` próximo das tools, se existir um teste de descrições), um caso estrutural.
Ele lê `lib/mcp/tools/agendamento.ts` e exige que a descrição de `crm_reschedule_appointment`:

- **não** contenha `o lembrete é refeito sozinho`;
- contenha `lembrete da data nova`.

Vermelho hoje: `agendamento.ts:826`.

**Mudança mínima.** Troque o trecho por:
`o lembrete da data nova sai sozinho na hora configurada (se a data nova já estiver dentro da antecedência, ele não sai)`.
Isso é verdade depois dos passos 1-3.

**Commit:** `fix(mcp): a remarcação descreve o lembrete como ele funciona`.

---

## Passo 5: `reminder_body` no tipo (porte do `6146539da`, schema e API)

**Testes vermelhos** em `app/api/v1/agenda/tipos/route.test.ts`, no estilo dos casos de
PATCH existentes (`:228-258`) e de isolamento (`:318-358`):

1. PATCH com `reminder_body: "Oi {{primeiro_nome}}, até {{quando}} às {{hora}}."` → 200, e o
   UPDATE recebe o texto aparado.
2. PATCH com `reminder_body: "   "` → o UPDATE recebe `reminder_body: null` (volta ao padrão).
3. PATCH com 1001 caracteres → 422, com a mensagem `A mensagem do lembrete cabe em 1000 caracteres.`
4. PATCH com `{{foo}}` → 422, com a mensagem `A mensagem do lembrete usa uma variável que não existe. Use só as da lista.`
5. PATCH só com `id` + `reminder_body: undefined` → 422 `Nenhum campo para alterar.` (a
   limpeza de `undefined` do original).
6. Isolamento: organização A não grava `reminder_body` em tipo da B (o UPDATE leva
   `.eq("organization_id", <org do cookie>)`).
7. GET publica `reminder_body`.

E em `tests/unit/a-ia-sabe-o-que-a-clinica-atende.test.ts`, `lembreteMensagem: null` no
dublê de tipo, como no `6146539da`. Esse é o vermelho de compilação esperado, até o passo
mudar a interface.

**Mudança mínima:**

- `lib/agenda/texto-do-lembrete.ts` (arquivo novo, ainda só com a constante):
  `export const VARIAVEIS_DO_LEMBRETE = ["primeiro_nome","nome","quando","data","hora","dia_semana","unidade","endereco","profissional","tipo","titulo","dia"] as const;`
  e `export function variaveisDesconhecidas(texto: string): string[]` (regex
  `/\{\{\s*([a-zA-Z_]+)\s*\}\}/g`, em minúsculas).
- `app/api/v1/agenda/tipos/route.ts`: `alterarSchema` ganha `reminder_body`, como no
  `6146539da`, mais `.refine((v) => v == null || variaveisDesconhecidas(v).length === 0, { message: … })`.
  O PATCH filtra `undefined` antes do UPDATE, e o GET publica `reminder_body: t.lembreteMensagem`.
- `lib/agenda/consulta.ts`: `reminder_body` no select (`:872`) e `lembreteMensagem` na
  interface (`:842`) e no mapeamento (`:913`), como no `6146539da`.
- Migration **0323** (mesmo arquivo do passo 2), apêndice do baseline (mesmo bloco) e linha
  do MANIFEST (a mesma, estendida): `alter table public.calendar_event_types add column if not exists reminder_body text;`
  + `comment`, texto da `0265` do original, mais a lista de variáveis daqui.
- `lib/database.types.ts`: `reminder_body` em `calendar_event_types` (Row/Insert/Update).
- `lib/i18n/dicionario.ts`: as duas mensagens de recusa, em espanhol.

**Verificar:** `app/api/v1/agenda/tipos/route.test.ts`,
`tests/unit/a-ia-sabe-o-que-a-clinica-atende.test.ts`, os testes de baseline/manifest do
passo 2 e `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`.

**Commit:** `feat(agenda): o tipo de agendamento aceita texto próprio no lembrete`
(porte de 6146539da: coluna, PATCH, GET; a 0265 do original entra na 0323).

---

## Passo 6: a renderização (variáveis, quando, fuso, nome)

**Testes vermelhos** em `lib/agenda/texto-do-lembrete.test.ts` (novo). Todos com `agora`
explícito:

- **hoje**: `agora` 2026-10-12 08:00 (São Paulo), compromisso 14:30 do mesmo dia →
  `{{quando}}` = `hoje`.
- **amanhã**: compromisso no dia seguinte às 09:00 → `amanhã`.
- **data**: compromisso a 3 dias, numa segunda-feira 12/10 → `segunda-feira, 12/10`;
  `{{data}}` = `12/10`, `{{dia_semana}}` = `segunda-feira`, `{{hora}}` = `14:30`.
- **fuso do compromisso**: o mesmo instante `2026-10-13T02:30:00Z` com `America/Sao_Paulo`
  dá "hoje"/`23:30` (agora = 12/10 08:00 local). Com `America/Manaus` dá `22:30`. Prove que
  a borda do dia é a LOCAL.
- **sem nome**: `nomeDoContato: null` → `{{nome}}` e `{{primeiro_nome}}` somem, e
  `"Oi {{primeiro_nome}}, tudo bem?"` vira `"Oi, tudo bem?"`. A regra de espaço: não sobra
  `"Oi , "`; colapse ` ,` para `,` e espaços duplos para um.
- **primeiro nome**: `"Maria  Silva"` → `{{primeiro_nome}}` = `Maria`.
- **vazia some**: `{{unidade}}` sem unidade nem local → nenhum `{{`/`}}` no resultado.
- **desconhecida**: `{{foo}}` fica literal (defesa do cron, como no original).
- **padrão intacto**: `molde: null` → exatamente a frase de hoje (mesma asserção do teste
  existente em `route.test.ts:66-119`).
- **espanhol**: `idioma: "es"` → `hoy`/`mañana`, e o dia da semana em espanhol.
- **compatibilidade com o original**: `{{titulo}}` = título, `{{dia}}` = `segunda-feira, 12/10`.

**Mudança mínima.** Mova `montarLembrete` de `route.ts:121-173` para
`lib/agenda/texto-do-lembrete.ts`, com estas adições:

- `aplicarMoldeDoLembrete` do `6146539da`;
- os campos novos em `input`: `agora?: Date`, `molde?: string | null`, `tipoNome?: string | null`,
  `unidade?: string | null`, `profissional?: string | null`;
- `quando` relativo calculado com `diaLocalISO` (`lib/agenda/fuso.ts:199`). Amanhã = o dia
  ISO de hoje + 1 dia, somado na data civil e não em 24h de relógio;
- a limpeza de espaços **só** quando há molde.

`route.ts` passa a `export { montarLembrete, aplicarMoldeDoLembrete } from "@/lib/agenda/texto-do-lembrete";`.
O módulo novo **não** importa nada de servidor (`createAdminClient`, `env`, `logger`). Isso é
conferido no passo 9, porque a tela o importa.

Dicionário: `hoje` → `hoy`, `amanhã` → `mañana`.

**Verificar:** `lib/agenda/texto-do-lembrete.test.ts`, `app/api/v1/cron/agenda-reminder/route.test.ts`
e `tests/unit/i18n-a-data-segue-o-idioma.test.ts` (proíbe `"pt-BR"` literal em data).

**Commit:** `feat(agenda): o lembrete fala hoje, amanhã, data, hora, unidade e profissional`.

---

## Passo 7: o cron usa o molde, o fuso, a unidade e o profissional do compromisso

**Testes vermelhos** (estruturais, no estilo de `route.test.ts:121-149`):

- a consulta seleciona `time_zone`, `unit_id`, `owner_user_id` e, no tipo, `reminder_body`;
- a fonte contém `timezone: linha.time_zone ||` (a reserva é a organização);
- a busca em `calendar_units` tem `.eq("organization_id", org)` nos 400 caracteres seguintes;
- `nomesDosAtendentes` só é chamado sob `includes("profissional")`;
- o legado continua cru: a atribuição do `body` de `message_templates` vai para `corpo`, e
  não para `molde`. Prenda isto lendo a fonte: o trecho depois de `.from("message_templates")`
  contém `corpo = modelo.body`.

**Mudança mínima** em `route.ts`:

- a consulta passa a trazer `time_zone, unit_id, owner_user_id` e `reminder_body` no embed do tipo;
- `const molde = tipo.reminder_body?.trim() || null`;
- com `unit_id`: `admin.from("calendar_units").select("name").eq("id", linha.unit_id).eq("organization_id", org).maybeSingle()`;
- com `molde?.includes("profissional") && linha.owner_user_id`: `(await nomesDosAtendentes([linha.owner_user_id])).get(linha.owner_user_id) ?? null`;
- `montarLembrete({ …, timezone: linha.time_zone || organizacao?.timezone || "America/Sao_Paulo", molde, tipoNome: tipo.name, unidade: unidade ?? local, profissional, agora })`;
- se `!molde && tipo.reminder_template_name`, o `body` do modelo substitui `corpo` cru, como hoje.

Atualize o comentário de `_handler.ts:223-224` só se ele deixar de ser verdade. Depois deste
passo ele passa a ser verdade, então o esperado é não mexer.

**Verificar:** `app/api/v1/cron/agenda-reminder/route.test.ts`, `tests/unit/cron-audita-so-quando-ha-efeito.test.ts`
e `pnpm --dir $W typecheck`.

**Commit:** `fix(agenda-lembrete): o lembrete usa o fuso, a unidade e o texto do tipo do compromisso`.

---

## Passo 8: o canal é sempre o WhatsApp da conversa do paciente

**Testes vermelhos** em `route.test.ts`:

- puro, `escolherCanalDoLembrete(sessoes, conversas)`:
  1. conversa mais recente num número elegível → esse número, mesmo que não seja o mais antigo;
  2. conversa mais recente no Instagram (sessão de provider fora de
     `providersDeEnvioAutomatico()`) e uma conversa mais antiga num WhatsApp → o WhatsApp da
     conversa antiga;
  3. sem conversa → a primeira sessão da lista (a ordem é de quem consulta);
  4. só Instagram `WORKING` → `null`;
  5. conversa num número que não está `WORKING` (fora da lista) → cai na primeira sessão.

  Use os providers por `providersDeEnvioAutomatico()` e uma string que não esteja nela. Não
  escreva o nome do provider no teste de feature se o `lint:channels` varrer `app/`
  (confira: `ROOTS` = `app, lib, components, workers`, e os testes estão dentro). Use
  `CHANNEL_PROVIDER_INSTAGRAM` importado de `@/lib/channels/capabilities`, como fazem os
  testes que já estão na lista do lint.
- estrutural: o trecho depois de `.from("channel_sessions")` contém
  `.eq("organization_id", org)`, `.eq("status", "WORKING")`,
  `.in("provider", [...providersDeEnvioAutomatico()])`, `.is("archived_at", null)` e
  `.order("created_at"`; o trecho depois de `.from("conversations")` contém
  `.eq("organization_id", org)`, `.eq("contact_id", contato.id)` e `.order("last_message_at"`.
  O teste existente `route.test.ts:133-137` continua passando.

**Mudança mínima.** Em `route.ts`:

- `escolherCanalDoLembrete`: menos de 15 linhas;
- a consulta de sessões: `select("id, provider")`, filtros acima, `.order("created_at", { ascending: true }).order("id")`;
- a consulta de conversas: `select("channel_session_id")`, `.order("last_message_at", { ascending: false, nullsFirst: false }).limit(20)`;
- `const canalId = escolherCanalDoLembrete(sessoes ?? [], conversas ?? [])`, e
  `canal.id` → `canalId` em `adiarAteAJanelaAbrir`, `espacarEnvio` e `ensureConversation`.

**Verificar:**

```bash
pnpm --dir $W vitest run app/api/v1/cron/agenda-reminder/route.test.ts > $S/vt.log 2>&1; echo "exit=$?"
pnpm --dir $W lint:channels > $S/lc.log 2>&1; echo "exit=$?"
```

**Commit:** `fix(agenda-lembrete): o lembrete sai pelo WhatsApp da conversa do paciente, nunca pelo Instagram`.

---

## Passo 9: a tela (campo, ajuda das variáveis, prévia)

**Testes vermelhos:**

1. `tests/unit/lembrete-texto-da-tela.test.tsx` (novo, jsdom + Testing Library, como os
   demais `.test.tsx`). Renderiza o `LembreteDoCompromisso`, exportado de
   `app/app/settings/tenant/agenda/_client.tsx`, dentro do provider de idioma (veja como
   outro `.test.tsx` de settings monta o `IdiomaProvider`), com um tipo de lembrete ligado.
   - o textarea `editar-lembrete-texto-<id>` existe, tem `maxLength` 1000 e vem com
     `reminder_body` como valor inicial;
   - digitar `Oi {{primeiro_nome}}, até {{quando}}` mostra a prévia
     (`data-testid="previa-lembrete-<id>"`) com `Oi Maria, até amanhã`;
   - com o aviso desligado, o textarea fica `disabled`;
   - a ajuda lista as 10 variáveis do pedido;
   - com `{{foo}}`, a prévia mostra o aviso `Variável que não existe: use só as da lista.`
2. Um teste estrutural (dentro do mesmo arquivo) lê `lib/agenda/texto-do-lembrete.ts` e
   exige que ele não importe `@/lib/supabase`, `@/lib/env` nem `@/lib/logger`. O cliente o importa.
3. `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`: fica vermelho sozinho se algum texto
   novo não estiver no dicionário.

**Mudança mínima:**

- `_client.tsx`: `reminder_body` em `TipoRow`. `LembreteDoCompromisso` exportado e com o
  textarea do `6146539da`, mais um estado controlado, a prévia via `montarLembrete` (paciente
  "Maria Silva", compromisso amanhã às 14:30 no fuso do navegador, `tipoNome` e `local` do
  tipo, `idioma` de `useIdioma()`) e o aviso de variável desconhecida via
  `variaveisDesconhecidas`. O PATCH do formulário manda `reminder_body` só com o aviso ligado.
  O selo `· texto próprio` na lista vem do `6146539da`.
- `page.tsx:51`: `reminder_body` no select.
- `lib/i18n/dicionario.ts`: rótulo, placeholder, ajuda, título da prévia, aviso, selo, todos em espanhol.

**Verificar:** os testes acima, mais `tests/unit/lembrete-degraus-da-tela.test.ts`, `pnpm --dir $W lint`
e `pnpm --dir $W typecheck`.

**Commit:** `feat(agenda): campo do texto do lembrete com variáveis e prévia na tela`.

---

## Passo 10: banco de verdade (`pnpm test:db`)

**Teste vermelho**: `tests/invariants/lembrete-remarcacao-carimba.test.ts` (novo), no padrão
de `tests/invariants/agenda-concorrencia-de-sala.test.ts`, com UUIDs próprios.

- Num compromisso inserido, `starts_at_marked_at` é `null`.
- `update … set notes='x'` → continua `null`.
- `update … set starts_at = starts_at` → continua `null`. A guarda `is distinct from` existe
  porque `fn_appointment_change` sempre nomeia a coluna.
- `update … set starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day'` → não nulo.
- A mesma remarcação por `public.fn_appointment_change(org, id, revision, '{"starts_at": …, "ends_at": …}')`,
  como `service_role`, também grava a coluna. É o caminho real da tela e da MCP.
- `has_function_privilege('anon', 'public.fn_starts_at_marked_at()', 'execute')` = `false`,
  e o mesmo para `public`.
- `calendar_event_types.reminder_body` existe e aceita `null`.

Para ver vermelho de verdade antes do verde, rode o teste com o bloco 0323 removido do
baseline numa cópia temporária, ou registre que ele foi escrito depois do bloco e prove a
sensibilidade por sabotagem: troque `is distinct from` por `true`, veja o caso de `notes` ficar
vermelho e desfaça.

**Verificar:**

```bash
pnpm --dir $W test:db > $S/db.log 2>&1; echo "exit=$?"
grep -aE "^ *(Test Files|Tests|Errors) " $S/db.log
grep -aE "^ *FAIL " $S/db.log | sed 's/ > .*//' | sort | uniq -c
```

`install` (`ON_ERROR_STOP=1`) e `update` (reaplicação) têm que passar. Rode também
`pnpm --dir $W test:db:update` se o script existir.

**Commit:** `test(agenda): o banco carimba a remarcação e só ela`.

---

## Passo 11: e2e, fragmento, suíte inteira

1. `tests/e2e/agenda-tipos-de-agendamento.spec.ts`: o caso do `6146539da` (`editar-lembrete-texto-`,
   `texto próprio`, valor relido depois do reload), mais uma asserção da prévia. Se houver
   ambiente fresco (`baseline.sql` em Supabase local pg15 + `bootstrap-owner.ts` +
   `next build && next start`), rode `pnpm --dir $W test:e2e -- agenda-tipos-de-agendamento`
   e guarde o screenshot em `.superpowers/evidence/`. Se não houver, **não** finja: o PR
   declara `Prova de tela: NÃO MEDIDO`.
2. `.changes/lembrete-editavel.md`: `impacto: capacidade_nova`, `secao: adicionado`, com o
   texto do lembrete editável e as variáveis.
3. `.changes/lembrete-pelo-whatsapp-e-remarcacao.md`: `impacto: nada_mudou`, `secao: corrigido`.
   Diz que o lembrete sai pelo WhatsApp da conversa do paciente, no fuso do compromisso, e
   que a remarcação refaz o lembrete. Diz também que **consulta marcada dentro da antecedência
   não recebe mais aquele degrau na hora**, e que quem quiser aviso para marcação de última
   hora configura um degrau curto. Confira com `pnpm --dir $W release:conferir`.
4. Suíte inteira:

   ```bash
   pnpm --dir $W typecheck > $S/tc.log 2>&1; echo "exit=$?"
   pnpm --dir $W lint > $S/li.log 2>&1; echo "exit=$?"
   pnpm --dir $W lint:channels > $S/lc.log 2>&1; echo "exit=$?"
   pnpm --dir $W test:unit > $S/vt.log 2>&1; echo "exit=$?"
   grep -aE "^ *(Test Files|Tests|Errors) " $S/vt.log
   grep -aE "^ *FAIL " $S/vt.log | sed 's/ > .*//' | sort | uniq -c
   ```

   Compare com `$S/falhas-base.txt`. Toda falha nova é sua. Toda falha que já estava na base
   vai para o PR com o nome do arquivo e a prova (o mesmo arquivo falhando na base).
5. **Commit:** `docs(agenda): fragmentos de release do lembrete editável`. Inclua o e2e se
   ele não entrou antes.

## Pendências para o PR (não são código)

- O documento de negócio (`docs/superpowers/specs/2026-10-05-funil-comercial-dr-andre-design.md`
  na pasta principal) precisa mudar em três pontos:
  - **4.10**: o lembrete não sai mais minutos depois de marcar uma consulta para menos de
    24h. Sugerir um degrau extra de 120 min nos tipos do Dr. André.
  - **4.10**: "o sistema não refaz o lembrete" deixa de ser verdade.
  - **Seção 8**: o lembrete deixa de sair por qualquer conexão.
- Decisão do dono, registrada no spec (3.3): rearmar por régua (portado) ou zerar a lista no gatilho.
