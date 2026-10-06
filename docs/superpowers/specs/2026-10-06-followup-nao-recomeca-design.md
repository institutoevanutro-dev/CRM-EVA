# Gatilho de silêncio: a sequência não recomeça sozinha

**Data:** 2026-10-06 · **Branch:** `fix/followup-nao-recomeca` (criada da `origin/main` @ `5b2e640f3`)
**Item:** A da Fase 2, item 1 do funil do Dr. André (`CRM-EVA/docs/superpowers/specs/2026-10-05-funil-comercial-dr-andre-design.md`, §5 e §6).
**Migration reservada:** `0324`. A `0323` é do lembrete; `0320`–`0322` e `0325+` são de outras sessões.

O plano TDD está em `docs/superpowers/plans/2026-10-06-followup-nao-recomeca.md`.

**Revisado depois da revisão do plano (2026-10-06).** Mudaram quatro decisões: a coluna
`active_since` nasce **sem backfill** (§4.2), o trigger só olha **status, `kind` e
`segments`** (§4.2), a paginação para na **página vazia** (§4.4), e a regra 2 do negócio
fica dita como **dependente de "cancelar ao responder"** (§1). Também foram corrigidas a
descrição de `skipped_existing` (§4.1), o argumento do relógio (§4.1), a do rollback
(§2.3) e a janela do §6.1.

---

## 1. O que o negócio pede

Da §5 do funil:

- **Quem recebe:** só quem mandou mensagem **depois** que a cadência foi ligada. Contato antigo não recebe nada.
- **Parada:** qualquer resposta encerra a sequência. Se o paciente sumir de novo, começa uma sequência nova a partir do primeiro toque.
- **Fim:** depois do último toque, a sequência termina e **não recomeça sozinha**.
- **Pessoa da equipe atendendo:** nada sai e a sequência é encerrada.

Hoje o código quebra a primeira e a terceira regras. A quarta, o envio já cumpre, mas o
encerramento vira um laço (defeito 1).

**A regra 2 só vale com "cancelar ao responder" ligado no gatilho.** O encerramento na
resposta é o `cancel_on_reply`, que é opcional e vem **desligado** (`lib/followup/api-schemas.ts:19-24`,
"Default false quando ausente"; o envio só o aplica com `=== true`,
`bloqueios-obrigatorios.ts:287`). Com o padrão, a resposta **acorda** o próximo nó ou a
classificação (`reactivity.ts:214-250`) e a sequência continua. Este trabalho não muda
isso: a dedup por episódio impede o RECOMEÇO, não encerra inscrição viva. A segunda metade
da regra ("se sumir de novo, começa do primeiro toque") passa a valer com este trabalho,
nos dois modos. Fazer a regra 2 valer sem configuração é decisão de produto à parte, fora
deste item; na implantação do Dr. André, o gatilho de silêncio tem de ser salvo com
"cancelar ao responder" ligado.

---

## 2. O problema, medido no código atual

Todas as referências são do worktree na `origin/main` @ `5b2e640f3`.

### 2.1 Como a varredura funciona hoje

- `lib/followup/silence-sweep.ts:94-152`: `runSilenceSweep` passa por cada ponteiro de silêncio ativo. Para cada um, resolve o agente que o arma (`:123`), calcula `cutoff = agora − threshold_minutes` (`:132`), lê os contatos calados (`:133`) e tenta `insertEnrollment` em cada um (`:136-148`).
- `:196-287` (`loadSilentContactIds`): lê as conversas abertas com inbound e embute a mensagem inbound carimbada mais nova (`:208-220`). Reduz por contato, ficando com a mais nova (`:247-271`). Filtra bloqueado (`:276`), gate da IA (`:280`), silêncio (`:281`, `v.at > cutoff` → fora; igualdade conta como silêncio) e segmentos (`:282`).
- `:302-320` (`insertEnrollment`): revalida a fronteira do atendimento e a proteção da agenda e insere. `23505` vira `inserted:false`.
- A única deduplicação é o índice único parcial `idx_followup_enrollments_one_live`, de `(organization_id, contact_id)` com status `active`, `waiting_reply`, `paused_handoff` e `paused_manual` (`supabase/baseline.sql:12049-12052`). Ele só olha inscrições **vivas**.
- Quem chama: `app/api/v1/cron/followup-flow-worker/route.ts:120-139`, a cada minuto, e `lib/relogio/executar.ts:131-141`. Os dois auditam ou marcam `mexeu` só com `enrolled || pointers_gated_out || skipped_existing` (`route.ts:127`, `executar.ts:137`).

### 2.2 Defeito 1: a sequência recomeça para sempre

O próprio arquivo diz isso em `silence-sweep.ts:28-30`: *"Um contato que COMPLETOU ou foi cancelado pode ser re-enrollado na varredura seguinte se continuar silencioso — aceitável no MVP, sem cooldown table."*

O que acontece:

- A inscrição sai do conjunto vivo por um destes caminhos:
  - `completed`, num nó End (`lib/followup/engine.ts:457`);
  - `dead` (`engine.ts:295`);
  - `cancelled`, quando o envio é bloqueado: anonimizado, opt-out ou etapa que bloqueia (`lib/followup/bloqueios-obrigatorios.ts:280-286`). Atendimento humano também cancela: o turno volta `skipped` e `turn-bridge.ts:133-135` cancela.
- Nenhum desses caminhos mexe na última mensagem recebida do contato. Se o contato continua calado, o próximo tick (1 min depois) acha o mesmo silêncio, o índice não barra nada (não há inscrição viva) e a sequência recomeça do nó de gatilho.
- Com atendimento humano ou etapa que bloqueia, isso vira um ciclo de criar e cancelar a cada 2–3 min. O original mediu numa instalação real: 32 reinscrições em ~9 h (commit `ee0a911bc`) e ~95 num fluxo de 1 h (commit `132c7d0d1`).

### 2.3 Defeito 2: disparo em massa ao publicar

- Não há limite de idade do silêncio. O `threshold_minutes` é só um mínimo (`lib/followup/api-schemas.ts:38`).
- Ao publicar, ou ao trocar o gatilho de um fluxo já publicado para "silêncio", toda conversa aberta calada há mais que o limiar entra de uma vez, inclusive contatos de meses atrás.

**Onde está registrado "quando o ponteiro passou a valer"?** Medi no schema:

| Candidato | O que registra | Serve? |
|---|---|---|
| `followup_flow_versions.created_at` (`baseline.sql:7313-7319`) | A versão nasce na publicação: `fn_publish_followup_flow_version` insere a versão e liga o ponteiro na mesma transação (`baseline.sql:7437-7474`). | **Só na publicação.** O **PATCH do `trigger_config`** muda o gatilho sem criar versão e vale na hora num ponteiro já ativo. (O **rollback** não ativa nada: só troca `active_version_id` e não mexe em `status`, `app/api/v1/ai/followup-flows/[id]/rollback/route.ts:80-86`. Ativar, neste schema, é só `fn_publish_followup_flow_version`, `baseline.sql:7466-7470`; desativar é `disable/route.ts:50-52`.) A tela salva o gatilho por PATCH, separado do publicar (`TriggerConfigControl.tsx:210` → `app/api/v1/ai/followup-flows/[id]/route.ts:144`). Exemplo: um fluxo publicado em março como "manual" e trocado para "silêncio" em outubro teria como âncora `created_at = março`, e todo silêncio desde março entraria. |
| `followup_flow_pointers.updated_at` | Qualquer escrita no ponteiro, inclusive cada salvamento do rascunho (`draft_graph`) e renomear. | **Não.** Editar o rascunho de um fluxo no ar descartaria em silêncio todo episódio em andamento. |
| `followup_flow_pointers.created_at` | A criação do rascunho. | Não. |

Nenhuma coluna serve. A decisão está na §4.2.

### 2.4 Defeito 3: anonimizado entra e sai a cada tick

- `loadSilentContactIds` não lê `contacts.is_anonymized`. O embed só traz `tags, is_blocked, ai_authorized_at, phone_number` (`silence-sweep.ts:211`).
- A anonimização apaga o telefone e as tags, mas mantém as mensagens inbound carimbadas e a conversa aberta.
- Com o gate aberto e sem segmentos, o contato é inscrito, o envio cancela (`bloqueios-obrigatorios.ts:280`, `contato_anonimizado`) e o próximo tick inscreve de novo. É o defeito 1 com garantia de repetição.

### 2.5 Defeito 4: mais de 1000 conversas, recorte arbitrário

- A consulta de `silence-sweep.ts:208-220` não tem `order` nem paginação no nível das conversas.
- O PostgREST corta em `max_rows = 1000` (`supabase/config.toml:12`, que também é o padrão do Supabase hospedado). Acima disso, cada tick vê um subconjunto que o banco escolhe.
- O repositório já resolveu isso em outro lugar com keyset: `lib/agenda/protecao-followup.ts:81-97`.

### 2.6 Desperdício: tentar inscrever quem já está vivo

Não é defeito de comportamento: o índice barra. Mas cada contato parado numa espera longa
passa pela fronteira, pela agenda e por um INSERT recusado a cada minuto, em cada fluxo
de silêncio da organização. O original mediu ~124 mil recusas por dia (`8e50867db`).

---

## 3. O que o original já consertou, e o que falta

Li os três commits indicados. Também li os três vizinhos do mesmo arquivo, para não reinventar.

| Commit do original | O que faz | Cobre aqui? |
|---|---|---|
| `ee0a911bc` | `loadContactIdsEmCooldown`: não reinscreve se uma inscrição **deste ponteiro** começou depois de `agora − threshold`. Contador `skipped_cooldown`. | **Parcial.** Apenas espaça o laço, de 1 min para `threshold`. Com 2 h de limiar, ainda são 12 sequências por dia para um contato que nunca responde. |
| `2240b215e` | Ancora o cooldown no `updated_at` de inscrição **terminal**, tira `skipped_cooldown` da auditoria e cria o índice `idx_followup_enrollments_pointer_contact_cooldown` (`0411` lá). | **Parcial.** Sozinho, continua sendo "uma sequência a cada `threshold` desde o fim", não "uma por episódio". **Portado inteiro** (índice, auditoria e a regra `loadContactIdsEmCooldown`, com o teste da consulta), como segunda regra ao lado do episódio — ver o parágrafo abaixo. |
| `8e50867db` | `loadContatosComInscricaoViva`: lê, em lotes de 100, quem já está vivo em qualquer fluxo da org e pula sem tentar o INSERT. | **Sim**, para o desperdício da §2.6. **Portado quase literal.** |
| `132c7d0d1` (vizinho) | `reentry_pause_minutes`, campo de tela, e pula conversa com pessoa no comando. | Fora (§6). O commit diz que o cooldown "no segundo caso só espaça o laço, sem encerrá-lo"; a dedup por episódio encerra. |
| `1eec26679` (vizinho) | `max_silence_minutes`: teto de idade do silêncio, configurável na tela. | Fora (§6). Resolve o defeito 2 por **idade**; o negócio pede por **ativação** ("quem mandou depois que a cadência foi ligada"). |
| `7bbc36805` (vizinho) | Base da pausa (`ultimo_envio`). | Fora (§6), depende do `132c7d0d1`. |

**O que nenhum deles cobre:** dedup por episódio (defeito 1 de verdade), âncora de ativação
(defeito 2 pelo critério do negócio), anonimizado (defeito 3) e paginação (defeito 4).

**Por que a regra de cooldown do original também é portada (revisão de 2026-10-06).** A
primeira versão deste spec dizia que a dedup por episódio a continha, porque "a resposta que
abre o episódio é a mesma que cancela a inscrição anterior". Isso só vale com
`cancel_on_reply` ligado. No padrão (desligado), a resposta durante a inscrição **acorda** o
nó e o fluxo segue até o End, às vezes dias depois (o `wait` aceita até 90 dias). Essa
resposta é posterior ao `started_at`, então abre episódio novo; já passou do limiar; e o tick
seguinte à conclusão reinscrevia, com a mensagem 1 encostada na última da sequência anterior.
É o mesmo defeito que o `2240b215e` registrou ao trocar o início pela conclusão. Com as duas
regras, o limiar conta a partir de `max(última entrada, fim da última inscrição deste
ponteiro)`; com `cancel_on_reply` ligado o fim é o instante da resposta e nada muda.
**Adaptado:** a consulta do original vai inteira numa chamada; aqui ela vai em lotes de 100
contatos, como as outras do arquivo, e só para quem passou do episódio.

---

## 4. Comportamento exigido e decisões

### 4.1 Dedup por episódio

**Regra:** um contato entra num ponteiro de silêncio **no máximo uma vez por episódio**. Um
episódio começa na última mensagem recebida qualificante. Se já existe inscrição desse
ponteiro para o contato, **em qualquer status**, com `started_at >=` essa mensagem, o contato
é pulado.

- **Resposta abre episódio novo.** A nova mensagem é posterior ao `started_at` da inscrição anterior, então ela deixa de contar como "deste episódio". O `cancel_on_reply` continua como está (`lib/followup/reactivity.ts:214-250` e `bloqueios-obrigatorios.ts:287-292`), e só depois de `threshold` sem resposta o contato entra de novo.
- **Que relógio compara.** A comparação é entre `followup_enrollments.started_at` (`default now()` do banco) e `messages.created_at` da mensagem qualificante (também `now()` do banco, na ingestão). Não uso `sent_at`, que vem do relógio do WhatsApp.
  - **Por quê:** o `created_at` é o relógio do banco, o mesmo do `started_at`. É também a coluna que o `cancel_on_reply` lê, mas **a regra dele não é a mesma**: o envio compara `max(created_at)` de **toda** entrada do contato (sem filtro de carimbo nem de conversa, `bloqueios-obrigatorios.ts:439-440`) com o **último envio da inscrição**, e só sem envio com `started_at` (`:288`). A varredura usa o `created_at` da mensagem mais nova **por `sent_at`**, entre as carimbadas de conversas abertas (`silence-sweep.ts`, embed ordenado por `sent_at desc limit 1`).
  - **O caso que isso evita:** uma mensagem enviada às 10:00, entregue às 10:02, depois de uma inscrição criada às 10:01. O `cancel_on_reply` trata como resposta (`created_at` 10:02 > 10:01) e cancela. Com `sent_at`, a varredura acharia que é o mesmo episódio (10:00 < 10:01) e o contato perderia a sequência daquele silêncio.
  - **O caso de borda que sobra:** duas mensagens A e B, com A de `sent_at` mais antigo e `created_at` mais novo que B (entrega fora de ordem). A varredura escolhe B (mais nova por `sent_at`) e compara o `created_at` de B; o `cancel_on_reply` vê o `created_at` de A. Uma resposta pode, então, cancelar pelo `cancel_on_reply` sem abrir episódio novo na varredura. O erro vai para o lado de **não** mandar e se corrige na próxima mensagem do contato.
  - O **limiar** do silêncio continua medido por `sent_at`, como hoje (`silence-sweep.ts:247`).
- **Onde mora a regra.** Em `runSilenceSweep` (TypeScript puro). O adaptador só devolve fatos: `Map<contact_id, maior started_at deste ponteiro>`.
  - **Por quê:** o invariante com Postgres real injeta um adaptador em SQL próprio, porque o `test:db` não sobe PostgREST. O que mora no adaptador, o invariante não vigia; quem mediu isso foi `tests/unit/sweep-nao-cobra-conversa-encerrada.test.ts:12-25`. Com a regra em `runSilenceSweep`, o invariante executa o código de produção contra linhas reais.
- **A leitura** filtra `organization_id`, `pointer_id`, `contact_id in (lote de 100)` e `started_at >= menor âncora do lote`, com keyset por `id`. O filtro de data limita o volume ao episódio corrente, mesmo em contatos com centenas de linhas deixadas pelo laço antigo.
- **Contador novo `skipped_same_episode`.** Fica **fora** da condição de auditoria e do `mexeu`, porque é "nada aconteceu" (doutrina do CLAUDE.md, "Audit log").
- **Ordem no laço:** episódio primeiro, depois "vivo em qualquer fluxo". Um contato parado numa espera longa **deste** fluxo cai em `skipped_same_episode`, que não audita. Assim ele não gera uma linha de auditoria por minuto. O `skipped_existing` passa a contar: vivo em **outro** fluxo; corrida no 23505; e as recusas de `insertEnrollment` que devolvem `inserted:false` sem 23505 — origem ausente, `StaleServiceBoundaryError` e a agenda mandando adiar (`protection.adiar`). Essas recusas continuam auditando a cada minuto (dívida no §6.4).
- **Inscrição manual ou por automação** (`lib/followup/enroll.ts`, chamada pela rota de inscrições e por `lib/automation/actions/start-message-flow.ts`) no mesmo ponteiro, depois da última mensagem, também conta como do episódio. A varredura não cria uma segunda. É o comportamento certo.

### 4.2 Sem passado: coluna `followup_flow_pointers.active_since`

Como nenhuma coluna existente serve (§2.3), decidi criar uma.

- **Coluna:** `active_since timestamptz not null default now()`. Significa: desde quando o ponteiro vale com o **status e o gatilho (`kind` e `segments`) atuais**.
- **Quem grava:** um trigger `BEFORE UPDATE` (`fn_followup_ponteiro_marca_vigencia`), com `WHEN` comparando valores (o mesmo molde da `0319`, `trg_contato_bloqueio_so_o_servidor_update`). Ele faz `new.active_since := now()` quando muda `status`, `trigger_config->>'kind'` ou `trigger_config->'params'->'segments'` (com `[]` e ausente tratados como iguais).
  - **Por que trigger e não código:** são vários escritores (publicar, PATCH, desativar). Uma regra no banco cobre todos e o próximo. O trigger não faz HTTP, então não fere o anti-pattern 9.
  - **O que NÃO dispara:** versão nova num fluxo já ativo (republicar ou rollback), limiar, `cancel_on_reply`, salvar rascunho, renomear e mudar `handoff_policy`. Isso é testado nos dois sentidos.
  - **Por que não a versão, o limiar nem o `cancel_on_reply`:** a tela salva esses campos juntos com o gatilho (`TriggerConfigControl.tsx:202-210`), e o publicar de um fluxo já ativo só troca a versão. Zerar ali descartaria todos os episódios em andamento a cada ajuste de texto ou de limiar, sem que nada de novo tivesse sido configurado.
  - O `INSERT` é coberto pelo `default now()`.
- **Regra na varredura**, em `runSilenceSweep`: só conta silêncio cuja mensagem qualificante tenha `sent_at > active_since`. Aqui `sent_at` é o certo, porque a pergunta é "quando o paciente falou". Assim, uma importação tardia de histórico velho não conta como mensagem nova. Os pulados entram no contador `skipped_before_activation`, que também não audita.
- **Sem backfill.** A coluna nasce com `add column if not exists active_since timestamptz not null default now()`, num comando só; todo ponteiro existente fica com o instante da atualização.
  - **Por quê:** a versão com backfill (`coalesce(versão ativa.created_at, updated_at)`, depois `set default`, depois `set not null`) tinha dois defeitos. (1) Corrida no `update.sh`, que aplica o banco antes de trocar a imagem (`hostgator-setup-kit/update.sh:154` e `:258-279`), em autocommit e sem `ON_ERROR_STOP`: um ponteiro inserido pelo app antigo entre o backfill e o `set default` ficava NULL, o `set not null` falhava calado, e `Date.parse(null)` deixava esse ponteiro sem inscrever ninguém para sempre. (2) Fluxo publicado há meses e nunca armado por agente receberia `active_since` = data da versão; ao armar o agente, todo silêncio desde então entraria de uma vez, que é o defeito 2.
  - **O custo:** na atualização, os episódios em andamento (silêncio ainda menor que o limiar) não recebem a sequência; só silêncios que começarem depois. Erra para o lado de não mandar. O laço de quem já estava preso para pela dedup da §4.1.
  - Sem backfill, não há código de backfill a testar: o `test:db:update` não o exercitaria (aplica o baseline atual e reaplica, sem semear ponteiros).
- **Efeito colateral aceito:** desativar e ativar de novo, ou mudar o `kind` ou os segmentos, zera a vigência. Os episódios já em andamento naquele instante não recebem a sequência; só silêncios que começarem depois. Erra para o lado de **não** mandar, que é o lado certo para anti-banimento. Está escrito no comentário da coluna.
- **Por que não o teto `max_silence_minutes` do original:** o negócio pede "quem falou depois que ligamos", não "silêncio de no máximo N". O teto do original pode entrar depois, junto com a tela dele (§6). As duas regras convivem.

### 4.3 Anonimizado fora na inscrição

- O embed de contato passa a trazer `is_anonymized`, e o contato é pulado no mesmo ponto que `is_blocked` (`silence-sweep.ts:276`).
- Fica no adaptador, como o bloqueado, porque é filtro de contato e não de ponteiro.
- **Prova:** só o teste unitário da consulta de produção (`silence-sweep-consultas.test.ts`), com sabotagem. O invariante **não** conta como cobertura: o filtro mora no adaptador, e o adaptador do invariante é dublê; o caso que havia lá provava o espelho e foi retirado na revisão. O que roda em `runSilenceSweep` e protege o anonimizado é o episódio (inscrição cancelada no mesmo silêncio não volta), coberto pelo caso `cancelled` do invariante.

### 4.4 Paginação determinística das conversas

- Keyset por `conversations.id`: `.order("id")` + `.gt("id", último)` + `.limit(500)`.
  - **Por que 500:** fica abaixo do `max_rows` de 1000, então o PostgREST nunca corta a página.
- **Parada:** a primeira página **vazia**, como em `lib/agenda/protecao-followup.ts:79-80`.
  - **Por que vazia e não curta:** o `max_rows` do PostgREST é ajustável no painel do Supabase hospedado, que é o banco do self-host. Com ele abaixo de 500, uma página curta não prova que acabou, e parar nela devolveria o defeito 4 em silêncio. Custa uma consulta a mais por ponteiro por tick.
  - Os dublês de `silence-sweep-pre-go-live.test.ts` e `fronteira-exige-procedencia-e-o-backfill-cobre-o-legado.test.ts` devolvem `[]` a partir da 2ª chamada; o de `sweep-nao-cobra-conversa-encerrada.test.ts` já devolvia `[]` sempre.
- **Trava contra não avançar** (o último id de uma página não maior que o da anterior): lança, como em `protecao-followup.ts:95`.
- **O `.limit(1)` do embed de `messages`** continua por conversa, com `referencedTable`.
- **Piso da vigência no servidor (revisão de 2026-10-06).** Sem teto, cada tick lia todas as conversas abertas da org, por ponteiro. A consulta passa a pedir `last_inbound_at > active_since`. É seguro porque `fn_mark_conversation_message` grava `last_inbound_at = greatest(last_inbound_at, p_at)`, então ele é `>=` o `sent_at` de toda entrada marcada, e conversa abaixo do piso só traria entrada que a regra "sem passado" recusa. A regra continua em `runSilenceSweep` (o piso só corta leitura). Não há memoização por organização entre ponteiros dentro do tick; fica para quando 2+ ponteiros de silêncio na mesma org pesarem.

### 4.5 Porte de `8e50867db` (não tentar quem já está vivo)

- `loadContatosComInscricaoViva(orgId, contactIds)`, com `STATUS_VIVOS` (os quatro do índice) e lotes de 100.
- O código fica igual ao original, para facilitar merge.
- Ajuste no invariante RED→GREEN do índice `0062`, como no original: o pré-filtro fica desligado nesse caso, senão ele esconderia o RED que mede o índice.

### 4.6 Porte de `2240b215e`: índice e auditoria

- **O índice entra na `0324`, idêntico ao do original:** nome `idx_followup_enrollments_pointer_contact_cooldown`, colunas `(organization_id, pointer_id, contact_id, updated_at)`.
  - A consulta de episódio daqui usa o prefixo `(organization_id, pointer_id, contact_id)`. Por contato e ponteiro, sobram poucas linhas para filtrar `started_at`.
  - **Por que idêntico e não com `started_at` no lugar de `updated_at`:** se o `0411` do original vier num merge futuro, o `create index if not exists` vira no-op. Com outro nome, seriam dois índices quase iguais na tabela mais quente do follow-up.
- **Auditoria:** os contadores novos (`skipped_same_episode`, `skipped_before_activation`, `skipped_cooldown`) **não** entram em `route.ts:127` nem em `executar.ts:137`. É a mesma decisão do item 3 do `2240b215e`.

### 4.7 O que não muda

- **O índice `idx_followup_enrollments_one_live`:** nem o contrato nem a forma.
- **Os outros gatilhos** (`stage_change`, `case_opened`, reserva, retorno): a coluna existe em todo ponteiro, mas só a varredura de silêncio a lê.
- **O `cancel_on_reply`, a janela, os bloqueios de envio e a política de handoff.**
- **O limiar e a regra `<=`** (`silence-sweep.ts:281`).
- **`lib/channels/pos-entrada.ts`:** nada.
- **O dead-man de ~11 h do envio que espera horário** (`a1c6c4d1e`, `092081b61` do original): é da outra sessão.

---

## 5. Superfície de código afetada

| Arquivo | Mudança |
|---|---|
| `lib/followup/silence-sweep.ts` | `SilencePointer.active_since`. `loadSilentContactIds` vira `loadSilentContacts` e devolve `{contact_id, ultima_entrada_em, ultima_entrada_gravada_em}`, com paginação, `is_anonymized` e `created_at` no embed. Métodos novos `loadUltimaInscricaoNoPonteiro` e `loadContatosComInscricaoViva` (porte). Regras de episódio e de vigência em `runSilenceSweep`. Dois contadores. O cabeçalho deixa de dizer "aceitável no MVP". |
| `supabase/migrations/20261006120000_0324_silencio_nao_recomeca.sql` | Índice (porte do `0411`), coluna `active_since not null default now()` sem backfill, função de trigger com `revoke` das duas origens, e o trigger. |
| `supabase/baseline.sql` | Apêndice idempotente com o **mesmo corpo de função** da migration (`apendice-do-baseline-nao-diverge-da-cadeia.test.ts`), antes da `VARREDURA anon` (`baseline.sql:33411`). |
| `supabase/migrations/MANIFEST.md` | Uma linha. |
| `lib/database.types.ts` | `active_since` em `followup_flow_pointers` (Row, Insert e Update). |
| `tests/invariants/followup-silence-sweep.test.ts` | O espelho SQL ganha os métodos novos. `seedSilenceFlow` passa a semear `active_since` 30 dias atrás por padrão. Casos novos. Ajuste do RED→GREEN. |
| Testes que chamam `loadSilentContactIds` (os três unitários e `tests/e2e/encerramento-atendimento.spec.ts`) | Renome e `.map((c) => c.contact_id)`. |
| `scripts/e2e-followup-journey-helpers.ts`, `scripts/e2e-elegibilidade-helpers.ts` | Subcomando `recuar-vigencia <pointerId> <minutos>`; a organização vem de `creds.org_id`, como nos outros subcomandos, sem argumento novo. As specs `followup-journey` e `j20-elegibilidade-followup` semeiam silêncio **anterior** à publicação e, sem isso, passariam a ser recusadas pela regra nova. As duas estão no CI. |
| `.changes/silencio-nao-recomeca.md` | `impacto: nada_mudou`, `secao: corrigido`. |
| `HANDOFF.md:186-187` | A frase "pode re-enrollar … aceitável no MVP" ganha nota de que deixou de valer. |
| `tests/invariants/followup-reenrollment-apos-conclusao.test.ts` | O cabeçalho cita o cabeçalho antigo do `silence-sweep.ts`; ganha nota de que o silêncio passou a deduplicar por episódio e o gatilho de etapa segue sem carência. |

**Sem tela nova e sem texto novo de tela**, então não há i18n. A rota de cron não muda,
porque os contadores novos ficam fora da condição de auditoria só por não estarem nela.

---

## 6. O que fica de fora, e por quê

1. **Armar o fluxo no agente depois de publicar.** O gate (`agent-followup-gate.ts`) libera o ponteiro quando um agente publicado o lista, e essa publicação não mexe em `active_since`.
   - **O risco:** silêncios que começaram entre a vigência do fluxo e a publicação do agente entram juntos quando o agente é publicado. Para fluxo publicado **depois** desta atualização, a janela é o intervalo entre publicar o fluxo e armar o agente. Para ponteiro que já existia, a vigência é o instante da atualização (sem backfill, §4.2), então a janela vai da atualização até armar o agente — nunca antes da atualização.
   - **Por que não tratar:** ligar a vigência à publicação do agente zeraria os episódios em andamento a cada ajuste de prompt.
   - **O que fazer na implantação:** depois de armar o agente, **desativar e publicar de novo** o fluxo zera a vigência (republicar um fluxo já ativo só troca a versão e não zera). Isso vai para a nota de implantação do Dr. André.
2. **`max_silence_minutes`, `reentry_pause_minutes` e `reentry_pause_basis`** do original (`1eec26679`, `132c7d0d1`, `7bbc36805`). São capacidades novas com tela e i18n, e a dedup por episódio já cumpre o que o negócio pede. Ficam para um porte próprio; a coluna `active_since` não conflita com elas.
3. **Pular a conversa com pessoa no comando antes de inscrever** (`132c7d0d1`). O churn que ela evitava acaba com a dedup: o contato é inscrito uma vez, o envio cancela por atendimento humano e ele não volta no mesmo episódio. "Quem escreveu sem Assumir" é o item de atendimento humano da Fase 2, de outra frente.
4. **Auditoria por minuto de `skipped_existing` e `pointers_gated_out`** (`route.ts:127`, `executar.ts:137`). Já existia antes deste trabalho, e o original mantém. Tirar mudaria o que a trilha registra para uma condição que não é deste item. Registro como dívida: os dois são "nada aconteceu" pela régua do CLAUDE.md. Isso inclui as recusas de `insertEnrollment` sem 23505 que caem em `skipped_existing` (origem ausente, `StaleServiceBoundaryError`, agenda mandando adiar — `silence-sweep.ts`, `insertEnrollment`): um contato com reserva protegida continua gerando uma linha de auditoria por minuto. O conserto é separar essas recusas num contador próprio fora da condição de auditoria; fica para um item próprio.
5. **Ordem dos ponteiros** (`loadActiveSilencePointers` sem `order`). Quando dois fluxos de silêncio disputam o mesmo contato no mesmo tick, o vencedor segue arbitrário. O índice já garante um só vivo.
6. **`paused_handoff` que nunca volta** quando a conversa é encerrada em vez de devolvida. É outro item.
7. **O dead-man de ~11 h** (`a1c6c4d1e`, `092081b61`). É da outra sessão.

---

## 7. Laço de retorno (Living System Checklist)

| Item | Resposta |
|---|---|
| **Entrada** | Ponteiro `kind='silence'` publicado e armado, e mensagem inbound carimbada. |
| **Saída** | Uma linha em `followup_enrollments` por episódio. |
| **Rastro** | `followup.silence_sweep_run`, quando há efeito. Os contadores `skipped_same_episode` e `skipped_before_activation` vão no `metadata` desse evento. |
| **Tela** | A fila de follow-up (`/app/ai/followups`) mostra a inscrição, que agora aparece **uma** vez por silêncio. |
| **Laço de retorno: o que muda no sistema quando erra** | Erro para o lado de **não** inscrever (vigência zerada, por exemplo) deixa o contato calado sem toque. Ele é corrigido pela próxima resposta do contato, que abre episódio novo. Erro para o lado de inscrever é barrado pelo índice único e pelos bloqueios de envio, que continuam iguais. |
