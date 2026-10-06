# Lembrete da agenda editável, pelo WhatsApp, refeito ao remarcar

Data: 2026-10-06 · Branch: `feat/lembrete-editavel` (criada da `origin/main` 5b2e640f3)
Origem: Fase 2, item 4 de `docs/superpowers/specs/2026-10-05-funil-comercial-dr-andre-design.md`
("Lembrete da véspera editável, com 'amanhã', data, hora e unidade, saindo sempre pelo WhatsApp").

Todas as referências `arquivo:linha` abaixo foram lidas neste worktree, na base 5b2e640f3.

---

## 1. O problema, medido

### 1.1 O texto é fixo e não diz "amanhã"

- `app/api/v1/cron/agenda-reminder/route.ts:121-173` (`montarLembrete`) monta sempre
  "Oi, {nome}! Passando pra lembrar do seu compromisso: {título}, {dia da semana, dd/MM} às {HH:mm}. Endereço: {local}."
  A data é sempre absoluta (`:146-157`). Nada na tela nem na API muda essa frase.
- A única troca possível é por SQL: `calendar_event_types.reminder_template_name` aponta
  para um `message_templates` (`:345-354`), e o `body` sai cru, sem variável nenhuma.
  A busca também não exclui modelo pessoal (`owner_user_id`).
- A tela (`app/app/settings/tenant/agenda/_client.tsx:112-160`) só liga o aviso e escolhe
  os minutos. O PATCH (`app/api/v1/agenda/tipos/route.ts:154`, `:268-311`) não tem campo de texto.

### 1.2 O endereço ignora a unidade

- `{local}` = `linha.location_details ?? tipo.location_details` (`route.ts:341`). A linha
  recebe uma cópia do tipo na marcação (`app/api/v1/agenda/agendamentos/_handler.ts:232`).
- `calendar_appointments.unit_id` (`_handler.ts:222`) não está na consulta do cron
  (`route.ts:234-236`). `calendar_units` tem `name` e `timezone` e **não tem endereço**
  (`supabase/baseline.sql:27164-27169`).

### 1.3 O canal pode ser o Instagram

- `route.ts:311-317`: `channel_sessions` com `status = 'WORKING'`, `.limit(1)`, sem ordem
  e sem filtro de provider. Numa organização com Instagram e WhatsApp conectados, o
  lembrete cai em qualquer um, e a escolha pode mudar entre uma rodada e outra.
- A abstração certa já existe: `providersDeEnvioAutomatico()` (`lib/channels/index.ts:60`)
  exclui o Instagram (`iaResponde: false`) e a voz, sem nomear provider. É a que
  `sessaoProntaParaEnvio` usa (`lib/automation/start-conversation.ts:34`).
- O cron também não prefere a conversa em que o paciente já fala: escolhe um número da
  organização, e `ensureConversation` (`start-conversation.ts:47-54`) abre ou reabre a
  conversa naquele número.

### 1.4 Remarcar não refaz o lembrete, e marcar perto demais manda lembrete na hora

- Nada zera nem reinterpreta `reminder_sent_offsets_minutes` quando `starts_at` muda. A
  remarcação (`_handler.ts:331-362`) grava `starts_at`/`ends_at`/`time_zone` por
  `fn_appointment_change` (`_handler.ts:921`) e não toca no lembrete. O baseline não tem
  gatilho que o faça. A véspera que saiu para a data antiga suprime para sempre a véspera
  da data nova.
- A ferramenta MCP promete o contrário: "o lembrete é refeito sozinho"
  (`lib/mcp/tools/agendamento.ts:826`).
- `degrausPendentes` (`route.ts:202-214`) não sabe quando o compromisso foi marcado. Consulta
  marcada às 18h30 para as 16h do dia seguinte tem a véspera (1440 min) vencida desde as
  16h de hoje, e o lembrete sai na primeira varredura, minutos depois da marcação. É o defeito
  #2223 do projeto original, medido lá.
- O carimbo é gravado **depois** do envio (`route.ts:375-389`) e o `error` do update é
  ignorado. Uma exceção entre o envio e o carimbo reenvia a mesma mensagem 5 min depois
  (medido no original: 18:35:01 e 18:40:01, idênticas).

### 1.5 O fuso é o da organização, não o do compromisso

- `route.ts:330-342` formata a hora com `organizations.timezone`.
- O compromisso tem fuso próprio: `calendar_appointments.time_zone` = `fusoDaRegra`, o fuso da
  jornada (que segue a unidade) em que o horário foi decidido (`_handler.ts:223-225` na
  marcação, `:361` na remarcação). O comentário em `_handler.ts:223-224` diz que esse fuso
  "viaja até o lembrete". Hoje não viaja. Numa unidade em outro fuso, o lembrete diz a hora errada.

---

## 2. Comportamento exigido

1. **Texto editável por tipo**, em Configurações › Agenda, num campo de texto com a lista de
   variáveis e uma prévia ao vivo. Em branco = a frase padrão de hoje, byte a byte.
2. **Variáveis**: `{{primeiro_nome}}`, `{{nome}}`, `{{quando}}`, `{{data}}`, `{{hora}}`,
   `{{dia_semana}}`, `{{unidade}}`, `{{endereco}}`, `{{profissional}}`, `{{tipo}}`. Também
   `{{titulo}}` e `{{dia}}`, por compatibilidade com o original (ver 3.2).
   - `{{quando}}`: "hoje", "amanhã" ou "segunda-feira, 12/10", no dia LOCAL do fuso do compromisso.
   - Nome: `nomeDoContato()` (`lib/contacts/rotulo-do-contato.ts:106`), que já tenta
     `name` e depois `display_name` e recusa identificador técnico.
   - Variável conhecida sem valor vira texto vazio, sem chaves. Na limpeza, só `[ \t]{2,}` vira um
     espaço e ` ,`/` .`/` !`/` ?` perde o espaço; **quebra de linha nunca é tocada** (lembrete de
     WhatsApp costuma ter várias linhas).
   - Variável desconhecida é **recusada no PATCH** (422). Desconhecida = qualquer `{{…}}` cujo
     conteúdo (aparado, em minúsculas) não seja exatamente uma variável da lista, o que pega
     `{{primeiro nome}}` e `{{primeiro-nome}}`, e também `{` ou `}` soltos que sobrem depois de
     tirar as variáveis válidas, o que pega `{nome}` (a forma que o documento de negócio usa).
     No cron fica literal, como no original.
3. **Legado**: com `reminder_body` nulo e `reminder_template_name` resolvendo para um modelo,
   sai o `body` do modelo **cru**, como hoje.
4. **Validação**: Zod no PATCH do tipo, até 1000 caracteres; em branco grava `null`.
5. **Endereço e unidade**: `{{unidade}}` = nome da unidade do compromisso (`unit_id` →
   `calendar_units.name`, embutido na consulta da varredura pela FK composta
   `calendar_appointments_unit_fk`, que já garante a mesma organização). **Sem unidade,
   `{{unidade}}` fica vazio** e some pela regra do item 2: cair no endereço repetiria o endereço
   num molde com as duas variáveis, e é justamente o caso do Dr. André (endereço no tipo, sem
   unidade). A ajuda da tela diz isso. `{{endereco}}` = `location_details` da linha e, na falta
   dele, o do tipo, porque a unidade não tem endereço.
6. **Canal**: sempre um canal de envio automático (WhatsApp, nunca Instagram). A ordem:
   1. o número da conversa mais recente do contato, se esse número estiver `WORKING`,
      não arquivado e for de envio automático;
   2. senão, o número `WORKING` mais antigo da organização (`created_at`, depois `id`).
   3. Sem nenhum, `pular("sem_canal")`, como hoje.
7. **Remarcar refaz o lembrete** da data nova, por qualquer caminho de remarcação. Marcar
   ou remarcar para dentro da antecedência de um degrau **não** dispara esse degrau. A
   descrição da ferramenta MCP fica verdadeira.
8. **Fuso**: `calendar_appointments.time_zone`, direto. A coluna é `not null default
   'America/Sao_Paulo'` (DDL da tabela no `baseline.sql`) e toda marcação grava `fusoDaRegra`, então
   não há reserva: `organizations.timezone` deixa de ser lido para isso. Quem prova o fuso é o
   teste puro de `texto-do-lembrete` com Manaus.
9. **Schema**: uma migration só, **0323** (`20261006120323_0323_lembrete_editavel.sql`: o timestamp
   termina no número para não colidir com as sessões paralelas), com a tripla completa (arquivo + apêndice
   idempotente no `baseline.sql` antes da VARREDURA anon + linha no MANIFEST), mais
   `lib/database.types.ts` (mantido à mão neste repo, como os portes fazem).
10. **i18n**: todo texto novo de tela e de mensagem tem a versão em espanhol em `lib/i18n/dicionario.ts`.

---

## 3. Decisões e por quê

### 3.1 O que é PORTADO do original (`upstream`) e o que é adaptado

| Commit do original | O que traz | Como entra aqui |
|---|---|---|
| `6ed38c78c` degrau vencido na marcação não dispara (#2223) | `vencidoNaMarcacao`, `criadoEm` em `degrausPendentes`, `created_at` na consulta, **carimbo antes do envio** com o erro do update tratado (`pular("carimbo_falhou")`), `espacarEnvio` dentro do `try` | **Portado.** Adaptações: (a) a consulta do fork não ganha o embed `organizations!inner(status)` nem a guarda `ehOperante` (o fork tem um `ehOperante` local das campanhas, mas o `agenda-reminder` não o usa; adotá-lo aqui é escopo de outro item); (b) o UPDATE do carimbo ganha uma condição que o original não tem (ver 3.9). Teste `lib/agenda/aviso-do-compromisso-lembrete.test.ts` portado. |
| `b85d7615d` dois erros de digitação | só comentário | Portado junto, pela proximidade. |
| `9e5027f1f` remarcação reposiciona a régua (#2230) | coluna `calendar_appointments.starts_at_marked_at`, função `fn_starts_at_marked_at`, gatilho `trg_starts_at_marked_at` (`before update of starts_at`, guarda `is distinct from`), `remarcadoEm` em `degrausPendentes` | **Portado, com o número trocado**: a migration `0536` do original vira parte da **0323** daqui (`20261006120323_0323_lembrete_editavel.sql`). O corpo SQL da coluna, da função e do gatilho fica idêntico. O teste estrutural `tests/unit/remarcacao-carimba-quando-o-horario-foi-marcado.test.ts` é **adaptado**, não só portado, em quatro pontos: o caminho da MIGRATION, o rótulo do BLOCO, a guarda de vacuidade da primeira linha (o original exige `-- manifest:`, convenção que nenhuma migration do fork usa; aqui ela exige `-- 20261006120323_0323_`) e o carimbo e o número do último caso (`20261006120323_` e `_0323_`). |
| `5c6c8d6f3` remarcar para mais longe rearma o degrau (#2243) | `enviadoEm` (`reminder_sent_at`) na consulta e o rearme em memória dentro de `degrausPendentes` | **Portado** como está. |
| `e174c8484` o rearme exige a régua e meio intervalo (#2249) | só rearma com `remarcadoEm` e com o alvo novo a ≥ metade do degrau depois do último envio | **Portado** como está. |
| `6146539da` texto próprio do lembrete no tipo | coluna `calendar_event_types.reminder_body` (0265 no original), `aplicarMoldeDoLembrete`, `reminder_body` só no PATCH (em branco → `null`), limpeza de `undefined` antes do UPDATE, campo na tela, `lembreteMensagem` em `listaTiposDeAtendimento`, e2e | **Portado e estendido**, com o mesmo nome de coluna para facilitar merges futuros. Adaptações em 3.2. |
| `22c9a1dbd` lembrete por degrau + endereços salvos da org | `reminder_bodies` por degrau, teto de 3 extras → 20, tabela de endereços, tela redesenhada | **Não portado.** É outra funcionalidade (texto por degrau, catálogo de endereços), com tela nova inteira. Nada no pedido exige isso. Ver 4. |

### 3.2 Adaptações sobre o `6146539da`

- **Nome da coluna: `reminder_body`, não `reminder_text`.** O pedido sugeria `reminder_text`
  só como exemplo. Usar o nome do original deixa um merge futuro do `upstream` sem conflito de schema.
- **`{{quando}}` muda de sentido.** No original é "segunda-feira, 12/10 às 14:00". Aqui é
  "hoje"/"amanhã"/"segunda-feira, 12/10", sem hora, como pede a Fase 2. `{{dia}}` (data com
  dia da semana) e `{{titulo}}` continuam com o sentido do original. É uma divergência
  consciente, e um merge futuro precisa preservá-la.
- **Variáveis novas**: `data` (dd/MM), `dia_semana`, `unidade`, `profissional`. A tabela de
  variáveis vira uma constante exportada (`VARIAVEIS_DO_LEMBRETE`), lida pela validação do
  PATCH, pela ajuda da tela e pela renderização. Uma lista só, para as três nunca divergirem.
- **A renderização sai do `route.ts` para `lib/agenda/texto-do-lembrete.ts`** (pura, sem
  import de servidor), porque a prévia da tela precisa dela no cliente. O `route.ts`
  reexporta `montarLembrete` e `aplicarMoldeDoLembrete`, então o teste existente e a forma
  do original continuam valendo.
- **Legado cru.** O original passa o `body` de `message_templates` pelo molde. Aqui o legado
  sai cru, como hoje (exigência 3). Molde só se aplica a `reminder_body`.
- **Variável desconhecida recusada no PATCH.** O original deixava `{{foo}}` chegar ao paciente
  "para quem digitou ver o erro". Com a prévia na tela, o erro aparece antes de salvar, e a
  rota recusa com uma mensagem fixa e traduzível.
- **Prévia** (não existe no original): renderiza o próprio texto digitado com um paciente de
  exemplo ("Maria Silva"), o tipo e o local do formulário, e um compromisso amanhã às 14:30
  no fuso do navegador.

### 3.3 "Remarcar zera `reminder_sent_offsets_minutes`": cumprido pelo efeito, sem zerar

O pedido diz "zerar ao mudar `starts_at`". O original resolveu o mesmo defeito **sem zerar**,
e o porte segue o original, porque zerar na escrita tem dois defeitos medidos lá:

- empurrar a consulta 30 min depois de a véspera sair zeraria a lista, e a véspera da data
  nova sairia 30 min depois da primeira: duas mensagens quase iguais em sequência, o que leva
  a denúncia do número (o guarda 2 do `e174c8484` existe por isso);
- linhas remarcadas antes da migration não têm régua (`starts_at_marked_at` nulo). Zerar
  soltaria, na primeira rodada após o update, uma véspera já vencida.

O efeito exigido é a data nova ganhar o lembrete dela, por qualquer caminho. Isso vale
porque a **régua é gravada por gatilho** em todo UPDATE que muda `starts_at` (tela, MCP,
reconciliação do Google por `fn_appointment_change_core`), e a decisão de rearmar fica em
`degrausPendentes`, na leitura. A lista gravada continua sendo a autoridade do que saiu, e o
carimbo da rodada a regrava.

**O preço da guarda 2, medido na revisão.** O pedido de zerar NÃO foi cumprido ao pé da
letra, e há dois casos em que a data nova fica sem o aviso de um degrau:

- remarcar para MAIS TARDE a menos de meio intervalo do último envio (véspera saiu qui
  16:05, consulta vai de sex 16:00 para sex 23:00: a véspera nova, qui 23:00, fica 6h55
  depois do envio, abaixo de 12h, e não sai);
- multidegrau: a régua é o último carimbo de QUALQUER degrau, então o aviso de 60 min que
  acabou de sair suprime a véspera da data nova remarcada para o dia seguinte.

Os dois estão presos em `lib/agenda/aviso-do-compromisso-lembrete.test.ts` como
comportamento escolhido, e a descrição de `crm_reschedule_appointment` diz as duas
exceções e manda a IA confirmar o novo horário na própria conversa. Antes ela prometia o
envio nesses casos (achado da revisão).

**Fica para decisão do dono:** se ele quiser literalmente a lista zerada, é uma linha no
gatilho (`new.reminder_sent_offsets_minutes := '{}'`), aceitando o segundo aviso em
sequência; os dois testes acima são os que devem virar. O plano não a escreve.

### 3.4 Efeito colateral do `6ed38c78c` sobre o Dr. André (ATENÇÃO)

A seção 4.10 do documento de negócio diz: "Consulta marcada para o dia seguinte, com menos
de 24h: o lembrete sai minutos depois do resumo." **Depois deste porte, não sai mais**: a
véspera venceu antes da marcação e é descartada. Aquela frase **descreve um efeito**, não pede
um lembrete para marcação de última hora (a decisão 20 do documento quer justamente evitar dois
avisos na véspera). A correção mínima do documento é **apagar a linha da 4.10**.

Um degrau extra mais curto (120 a 180 min) faria quem marca na véspera receber algum aviso,
mas tem custo: `degrausPendentes` aplica os extras a **todo** compromisso do tipo, então todo
paciente marcado com mais de 24h passaria a receber dois avisos (a véspera e mais um no dia).
A escolha fica com o dono, como configuração, sem recomendação deste spec. O documento de
negócio fica na pasta principal, que esta sessão não pode tocar; a correção vai como pendência no PR.

### 3.5 Canal: a regra pura fica separada da consulta

`escolherCanalDoLembrete(sessoes, conversas)` é pura e exportada do `route.ts` (como
`degrausPendentes`):

- recebe as sessões `WORKING`, não arquivadas e de envio automático, em ordem determinística;
- recebe as conversas do contato, da mais recente para a mais antiga (`last_message_at desc nulls last`);
- devolve o número da primeira conversa cujo número está na lista, ou o primeiro da lista;
- a regra repete o filtro `providersDeEnvioAutomatico()`, para o Instagram nunca ganhar mesmo
  que a consulta mude.

As consultas ficam no `route.ts`, filtradas por `organization_id` da linha. É isso que os
testes estruturais de isolamento (`route.test.ts:121-149`) leem. Nenhum provider é nomeado
(`pnpm lint:channels`).

Não se reutiliza `sessaoProntaParaEnvio`: ela cai para sessão **não** `WORKING`. Com o
carimbo antes do envio, mandar por número desconectado perderia o lembrete em silêncio.
Hoje o cron pula (`sem_canal`) e tenta na próxima rodada, e isso se mantém.

### 3.6 `{{profissional}}`

`owner_user_id` → `nomesDosAtendentes()` (`lib/users/nome-do-atendente.ts:52`), que lê
`user_metadata.full_name` pelo admin e devolve `null` sem service role. O GoTrue só é
consultado quando o molde contém `profissional`, para não gastar uma chamada HTTP por
lembrete. A pergunta usa a MESMA extração da validação e da renderização
(`variaveisDoMolde(molde).includes("profissional")`, sem diferenciar maiúsculas): com um
`includes` cru, `{{Profissional}}` passaria no PATCH, seria renderizado e sairia vazio em
silêncio. O e-mail **nunca** entra no lugar do nome, porque iria para o WhatsApp de um paciente.

### 3.7 Multi-tenancy

Toda leitura nova usa o cliente admin e filtra `organization_id` vindo da linha do
compromisso (`const org = linha.organization_id`): `conversations`, `channel_sessions`. O
nome da unidade vem embutido na consulta da varredura pela FK composta
`(organization_id, unit_id) → calendar_units(organization_id, id)`, que só casa unidade da
mesma organização. A tela grava pelo PATCH existente (`requireRole("manager")`, admin com
`.eq("organization_id", autorizado.org.orgId)`). A migration não cria tabela, então não há RLS nova.

### 3.8 Auditoria

Nenhuma ação nova. O PATCH já audita `agenda.tipo_alterado` com a lista de campos, e
`reminder_body` entra nela. O cron continua auditando só com `enviados > 0`. `carimbo_falhou`
é motivo de pulo, não mutação.

---

### 3.9 O carimbo é condicional (divergência do original)

O carimbo foi para antes do envio (porte do `6ed38c78c`), mas no original ele é um UPDATE
sem condição: filtra só `id` e `organization_id` e não lê quantas linhas afetou. A rodada lê
até 200 linhas no começo e espaça cada envio em 1,2 s + jitter; o `scheduler` dispara a cada
5 min com `curl -m45` (`docker/scheduler/entrypoint.sh:83`) e o handler segue depois do timeout
do curl. Uma linha lida no começo pode ser cancelada ou remarcada antes de a rodada chegar nela,
e duas rodadas sobrepostas mandariam em dobro.

Aqui o mesmo UPDATE leva também `status = 'confirmed'`, `starts_at` = o lido, a lista
`reminder_sent_offsets_minutes` = a lida e, quando havia, `reminder_sent_at` = o lido, mais
`.select("id")`. Sem linha devolvida, `pular("mudou_na_rodada")` e não envia.

A condição sobre o instante usa `.eq` só quando ele existe, e nunca `.is("reminder_sent_at", null)`:
o teste "o cron NÃO pode filtrar por reminder_sent_at" (e o do `5c6c8d6f3`) proíbe esse filtro na
fonte, porque ele já foi o filtro errado de quem recebe. A lista cobre o caso do instante nulo:
sem carimbo anterior não há rearme, então os pendentes nunca estão na lista e ela sempre cresce.
O instante cobre o caso do rearme, em que a lista regravada fica igual.

### 3.10 Comentários de estado que o porte torna falsos

- `comment on column calendar_appointments.reminder_sent_at` dizia "informativo". Desde o rearme
  ele decide, e é gravado antes do envio. A 0323 regrava o comentário (migration e apêndice).
- O cabeçalho do `route.ts` dizia que "ninguém consegue LIGAR o lembrete pela tela". A tela liga
  (`_client.tsx`), e o parágrafo é reescrito.

## 4. O que fica de fora

- Texto por degrau (`reminder_bodies`), teto de extras e catálogo de endereços da org (`22c9a1dbd`).
- Endereço na unidade (`calendar_units.address`): a tabela não tem a coluna e o Dr. André usa
  um tipo por unidade, com o endereço no tipo (seção 4.7 do documento de negócio). Se for
  preciso, entra numa migration futura e `{{endereco}}` passa a preferir a unidade.
- Correções de "organização parada" do original (`53302e236`, `8b3cd60ee`, `7b8ac558b`) e
  `autorizaCron()` (`f917b3b7b`): o fork tem `autorizaCron` (`lib/auth/cron-auth.ts:25`, usado por
  dois crons) e um `ehOperante` local das campanhas (`lib/campanhas/organizacao.ts:19`), mas o
  `agenda-reminder` não os usa. Adotar os dois aqui fica fora deste item, por escopo.
- Lembrete para compromisso `pending`, lembrete "às 9h" fixo, `force_human`/bot silenciado.
- Janela de 24h do WhatsApp oficial (texto livre fora da janela falha no provedor). O
  `reminder_template_name` é o caminho para isso e segue como está.
- Filtro de modelo pessoal (`owner_user_id`) na busca do legado: mudaria o comportamento do
  legado, que deve ficar igual.
- Ocupação do Google, marcação além de 30 dias e o "dead-man" do follow-up: são de outras sessões.
- `lib/channels/pos-entrada.ts`: não é tocado.

---

## 5. Como se prova

- Unit: `lib/agenda/aviso-do-compromisso-lembrete.test.ts` (portado), `lib/agenda/texto-do-lembrete.test.ts`
  (hoje, amanhã, data, fuso, sem nome, vazia some, desconhecida, legado),
  `app/api/v1/cron/agenda-reminder/route.test.ts` (escolha do canal, fuso da linha, unidade,
  régua da remarcação, carimbo antes do envio), `app/api/v1/agenda/tipos/route.test.ts`
  (PATCH com `reminder_body`: grava, limpa para `null`, recusa 1001 caracteres, recusa
  variável desconhecida, isolamento entre organizações), `tests/unit/remarcacao-carimba-quando-o-horario-foi-marcado.test.ts`
  (portado, apontando para a 0323).
- Banco: `tests/invariants/lembrete-remarcacao-carimba.test.ts` (novo). UPDATE de `notes`
  ou `status` não mexe em `starts_at_marked_at`; UPDATE de `starts_at` o grava; a função não
  é executável por `anon`. Mais `pnpm test:db` inteiro (install com `ON_ERROR_STOP=1` + update).
- Suíte: `pnpm test:unit` sem caminho, `pnpm typecheck`, `pnpm lint`, `pnpm lint:channels`.
- Tela: caso novo em `tests/e2e/agenda-tipos-de-agendamento.spec.ts` (portado do `6146539da`,
  mais a prévia). Se não der para rodar Playwright em ambiente fresco, o PR declara
  **NÃO MEDIDO** para a prova de tela.

---

## 6. Living System Checklist (DoD 13) e registro de jornada

```
Living System Checklist — lembrete editável, pelo WhatsApp, refeito ao remarcar
[x] Quem me alimenta?  calendar_event_types.reminder_body, gravado pelo PATCH de
    app/api/v1/agenda/tipos/route.ts; calendar_appointments (starts_at, time_zone,
    unit_id → calendar_units.name, owner_user_id, starts_at_marked_at gravado pelo
    gatilho trg_starts_at_marked_at); conversations e channel_sessions do contato.
[x] Quem eu alimento?  sendMessageHandler (a mensagem no inbox da conversa do
    paciente, com o desfecho da entrega) e o carimbo reminder_sent_offsets_minutes /
    reminder_sent_at que a próxima rodada lê.
[x] Que atividade/log eu emito?  audit agenda.tipo_alterado com `reminder_body` na
    lista de campos; audit agenda.lembrete_enviado com `motivos`, que agora inclui
    `carimbo_falhou` e `mudou_na_rodada` (só quando a rodada enviou algo: rodada sem
    envio não audita); `logger.error` em `carimbo_falhou` e `logger.warn` em
    `mudou_na_rodada`, que valem em toda rodada; a própria mensagem na conversa.
[x] Onde eu apareço na tela?  Configurações › Agenda (campo, ajuda, prévia e o selo
    "· texto próprio" na lista); a mensagem enviada na conversa do Inbox.
[x] Por qual porta se chega até mim?  a tela já existente /app/settings/tenant/agenda,
    que está no NAV_CATALOG; nenhuma tela nova.
[x] Qual meu mecanismo anti-morte?  N/A: o lembrete não abre demanda. Sem canal ou
    fora da janela, a rodada pula sem carimbar e tenta na seguinte.
[x] Onde se CONFIGURA o que eu uso?  a mesma tela (ver e mudar). Falta de canal vira
    o motivo `sem_canal` no audit; não vira aviso na Central (dívida antiga, não
    desta mudança).
[x] Qual a continuidade IA↔humano?  N/A: envio de sistema; a descrição de
    crm_reschedule_appointment passa a dizer à IA o que o lembrete faz de verdade.
[x] Qual meu LAÇO DE RETORNO?  (1) a prévia: quem escreve vê o texto que o paciente
    recebe antes de salvar, e variável errada vira aviso e 422; (2) os `motivos` da
    resposta do cron, que entram no audit agenda.lembrete_enviado quando a rodada
    enviou algo; na rodada sem envio, o rastro de `carimbo_falhou` e
    `mudou_na_rodada` é o log (error/warn), porque cron sem efeito não audita;
    (3) a resposta do paciente volta à mesma conversa, porque o canal é o dela.
[x] Atualizei o mapa vivo?  N/A: nenhuma peça nova; o cron, a tela e as tabelas já
    existiam. `docs/architecture/` não modela o agenda-reminder hoje.
```

Registro de jornada: `docs/testing/user-journey-map.md`, J13.14, com status
**NÃO MEDIDO** para a prova de tela em ambiente fresco.
