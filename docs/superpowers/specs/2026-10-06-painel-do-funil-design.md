# Painel do funil — desenho

> Item D da Fase 2 (`docs/superpowers/specs/2026-10-05-funil-comercial-dr-andre-design.md`, §6 item 5),
> escrito como produto GENÉRICO: nada de nome de cliente, preço, modalidade ou
> etapa fixa no código. Tudo que é de um nicho vem do funil, dos campos e das
> etiquetas que a organização já cadastrou.
>
> Base: `origin/main` em `5b2e640f3`. Todo `path:linha` abaixo foi lido nesse commit.

---

## 1. Problema medido

### 1.1 O que existe hoje em Análise

| Tela | O que mostra | Por que não responde à pergunta do funil |
|---|---|---|
| `/app/metrics` (Desempenho) | Leads **abertos agora** por etapa + ganho/perdido por atendente | O "funil" é `fn_attendant_metrics` (`supabase/baseline.sql:24044-24064`): `count(*)` de `crm_leads` com `status = 'open'`, **sem filtro de período e sem filtro de funil** — as etapas de todos os funis da organização saem misturadas. Não diz quantos chegaram a cada etapa, só onde estão parados agora (`app/app/metrics/_components/MetricsClient.tsx:92-117`). |
| `/app/ads/meta` (Meta Ads) | Gasto, resultados por campanha e, sob clique, contatos e vendas do Financeiro externo por campanha | Gasto vem da plataforma (`app/api/v1/ads/meta/campaigns/route.ts:95-106`); o cruzamento com o CRM conta **contatos** criados no período e **vendas do Financeiro externo** (`lib/plataformas-de-anuncio/meta/relatorio-servidor.ts:30-64`), não cards, não etapas, não agenda. Sem Financeiro configurado, vendas = `null`. |
| `/app/activities`, `/app/tag-report` | Trabalho feito; volume por etiqueta de conversa | Outras perguntas. |

Não há, em lugar nenhum, junto e no mesmo período: taxa de interação, quantos
chegaram a cada etapa, comparecimento, custo por venda e ROAS, nem recorte por
origem/criativo/campanha.

### 1.2 Fatos do código que o desenho usa (conferidos)

1. **Etapa "Interagiu" = passo `contacted` do agente.** `crm_stages.agent_stage_hint`
   (`supabase/baseline.sql:9038-9068`, migration 0084) liga uma etapa do funil a um
   dos sete passos do agente. O rótulo de tela do passo é "Primeiro contato"
   (`lib/leads/agent-mapping.ts:51`). O motor procura a etapa NÃO arquivada com o
   hint (`lib/leads/agent-stage-sync.ts:97`). `null` é estado legítimo — funil sem
   mapeamento existe.
2. **Mudança de etapa tem DUAS gramáticas de payload** em `crm_lead_activities`
   (`type = 'stage_changed'`):
   - `{ from_stage_id, to_stage_id }` — humano e API: `app/api/v1/leads/[id]/move/route.ts:176-177`,
     `app/api/v1/leads/_handler.ts:861-862` (o `moveLeadHandler`, usado também por
     automação e MCP), `lib/leads/stage-operations.ts` (arquivar etapa) e
     `app/api/v1/leads/bulk/route.ts`.
   - `{ de, para }` — máquina: `lib/leads/agent-stage-sync.ts:345`,
     `lib/leads/appointment-stage-move.ts:147`, `lib/leads/handoff-stage-move.ts:152`,
     `lib/supervisao/db-pg.ts:365`.
   A leitura da timeline existente só conhece a primeira
   (`app/api/v1/leads/_handler.ts:887-895`). O painel lê as duas.
3. **Criação de card não grava `stage_changed`.** A etapa de nascimento só aparece
   como `from_stage_id`/`de` do primeiro movimento, ou como `stage_id` atual se o
   card nunca andou.
4. **Ganho:** `fn_crm_lead_close_on_stage` (`supabase/baseline.sql:144-174`) põe
   `status = 'won'` e `closed_at` quando o card entra em etapa `is_won`, e zera
   `closed_at` se o card sai dela. `value_cents bigint` e `currency text` (nullable)
   em `crm_leads`. **Limitação:** o ramo `is_won` faz `coalesce(new.closed_at, now())`
   (`supabase/baseline.sql:159-165`) num trigger `BEFORE UPDATE OF stage_id`
   (`baseline.sql:2990`). Um card que vai de uma etapa de PERDA direto para uma de
   ganho herda o `closed_at` da perda (não nulo), então esse ganho cai no mês em
   que o card foi perdido. Só passar por uma etapa aberta zera a data. O painel
   usa `closed_at` e diz isso na régua; o conserto é do trigger, fora deste PR.
5. **Agenda:** `calendar_appointments.status` ∈ `pending, confirmed, cancelled,
   completed, no_show` (`supabase/baseline.sql:15323-15325`). Não há `lead_id`: o
   vínculo com o card é `crm_lead_links` com `target_kind = 'appointment'`
   (`lib/agenda/consulta.ts:522-525`), gravado só quando o contato tem card aberto
   no momento (`app/api/v1/agenda/agendamentos/_handler.ts:823,862-869`). Índice
   `(organization_id, starts_at)` existe (`supabase/baseline.sql:15347-15348`).
6. **Campos de escolha:** as definições moram em `crm_pipelines.settings.fields[]`
   (`lib/schemas/settings.ts:134-158`, tipo `select` com `options`). O VALOR do
   contato mora em `contacts.custom_fields` e usa as definições do **funil padrão**
   (`app/app/contacts/[id]/_client.tsx:56-58`); o leitor pronto é
   `camposDeListaDoFunilPadrao` (`lib/leads/campos-do-funil.ts:42-57`). O valor do
   card mora em `crm_leads.custom_fields` com as definições do funil do card
   (`camposDoFunil`, `lib/leads/campos-do-funil.ts:6-16`).
7. **Atribuição de campanha** de um contato já é função pura:
   `campanhaDoContato(source_metadata, campanhaPorAnuncio)`
   (`lib/plataformas-de-anuncio/meta/resultado-crm.ts:39-57`), que precisa do mapa
   anúncio → campanha (`lerAnunciosDaConta`, `lib/plataformas-de-anuncio/meta/insights.ts:343-353`).
8. **Investimento:** `lerInsights(token, conta, de, ate)` devolve `spend` por campanha
   (`lib/plataformas-de-anuncio/meta/insights.ts:376-390`); a moeda da conta vem de
   `listarContas` (`insights.ts:294-325`). A credencial é por organização com
   `default_account_id` (`lib/plataformas-de-anuncio/credenciais-de-leitura.ts:41-84`).
   Falhas de leitura são tipadas (`FalhaDeLeitura`) e já têm tradução
   (`app/api/v1/ads/meta/_falha.ts`).
9. **Fuso:** `organizations.timezone` sem validação de escritor; o leitor seguro é
   `fusoUtilizavel` (`lib/tempo/fusos.ts:99-105`). O valor já chega pela
   `requireRole` (`ActiveOrg.timezone`, preenchido em `lib/auth/server.ts`), como
   em `app/app/agenda/page.tsx:111` — não se relê `organizations`. O início do dia civil num fuso já
   existe exportado: `inicioDoDiaNoFuso` (`resultado-crm.ts:16-36`).
10. **Precedente de relatório sem migration:** `/api/v1/reports/tags`
    (`app/api/v1/reports/tags/route.ts:62-95, 222-251`) — client de sessão +
    `organization_id` explícito, paginação com `range` + `count: 'exact'` porque
    `max_rows = 1000` corta calado, `truncado: true` quando não coube, janela máxima
    de 90 dias.
11. **Navegação:** grupo Análise em `lib/navigation/catalogo.ts:527-597`. A barra
    lateral está no limite (comentário em `catalogo.ts:568-571` e
    `app/app/analise/page.tsx:12-24`): tela nova entra **só no hub**, sem `sidebar`.
12. **Papel:** Meta Ads é `manager` (`app/app/ads/meta/page.tsx:38-40`) porque
    orçamento é da empresa inteira; a ficha do contato só mostra financeiro a
    `manager+` (`app/app/contacts/[id]/_client.tsx:54`).

---

## 2. Comportamento exigido

### 2.1 Tela

- **Rota:** `/app/painel-do-funil`, rótulo "Painel do funil", grupo `analise`,
  seção "Os números do período", `minRole: "manager"`, sem `sidebar` (porta = hub
  `/app/analise` e ⌘K). Declarada em `lib/navigation/catalogo.ts`.
- **Filtros:** período (`de`/`ate`, datas civis no fuso da organização; padrão =
  30 dias terminando ONTEM, como a tela Meta Ads, porque o dia corrente está
  incompleto e a plataforma ainda reprocessa a atribuição dele —
  `app/api/v1/ads/meta/campaigns/route.ts:52-63`), funil (padrão = funil `is_default`), dimensão
  de recorte (opcional).
- **Cada número tem uma linha curta de régua** visível abaixo dele (não só tooltip).
- Estado "não conectado"/"sem conta padrão"/"indisponível" do investimento é
  texto, nunca `0`.
- pt-BR e espanhol em todo texto novo.

### 2.2 Números do período (o funil filtrado)

Janela semiaberta `[início do dia de, início do dia seguinte a ate)` no fuso da org.
"Grupo do período" = cards do funil com `created_at` na janela.

| Número | Régua (o texto que vai para a tela) |
|---|---|
| **Investimento** | Gasto da conta de anúncios **inteira** no período (não só deste funil), lido da plataforma agora, com o nome da conta usada. Datas no fuso da conta de anúncios. A conta é escolhida pela MESMA regra da tela Meta Ads (`MetaAdsClient.tsx:119-124`): a padrão, senão a primeira ativa, senão a primeira. Estados: `ok` / `nao_conectado` / `sem_conta` (o token não alcança conta nenhuma) / `indisponivel` (com o motivo; inclui `conta_fora_do_alcance` quando a padrão gravada não está entre as contas do token — nunca se presume moeda). |
| **Leads** | Cards criados neste funil no período. |
| **Interagiram** | Cards do grupo que chegaram à etapa ligada ao passo "Primeiro contato" do agente, ou a uma etapa depois dela. Vale a etapa NÃO arquivada com o passo (`uniq_crm_stages_pipeline_hint` impede duas ativas). `null` + aviso "ligue uma etapa ao passo Primeiro contato em CRM › Etapas do funil" quando o funil não tem o mapeamento ativo. |
| **Taxa de interação** | Interagiram ÷ Leads. `null` quando Leads = 0 ou Interagiram = `null`. |
| **Funil por etapa** | Para cada etapa não arquivada e não-perdida, em ordem de posição: quantos cards do grupo chegaram a ela ou além, até agora. Mais: perdidos do grupo. |
| **Ganhos** | Cards deste funil marcados como ganhos com data de fechamento no período (inclui cards criados antes do período). Um card que foi de perdido direto para ganho mantém a data da perda (fato 4). |
| **Receita** | Soma do valor dos ganhos, por moeda. Ganho sem valor conta em Ganhos e aparece como "N sem valor". |
| **Ganhos de anúncio** | Ganhos cujo contato veio de uma campanha da conta conectada (mesma atribuição da tela Meta Ads). Só existe com investimento `ok`. |
| **Custo por venda** | Investimento ÷ Ganhos de anúncio. `null` sem investimento `ok` ou com 0 ganhos de anúncio. O gasto é da conta inteira: com dois funis, o custo de cada um sai inflado — a régua diz isso. |
| **ROAS** | Receita dos Ganhos de anúncio na moeda da conta ÷ Investimento. `null` sem investimento `ok`, investimento 0 ou sem receita nessa moeda. Mesma ressalva da conta inteira. |
| **Agendamentos** | Compromissos com início no período, ligados a um card deste funil (pelo vínculo do card; sem vínculo, pelo contato que tem card neste funil). Não conta cancelados. |
| **Realizados / Faltas** | Desses, os marcados como realizado / falta. |
| **Sem baixa** | Desses, os que já terminaram e seguem pendentes ou confirmados — ninguém marcou se a pessoa veio. |
| **Taxa de comparecimento** | Realizados ÷ (Realizados + Faltas). `null` quando o denominador é 0. |
| **Cancelados** | Compromissos com início no período que foram cancelados (informativo). |

**"Chegou à etapa X"** = a maior posição entre: etapa atual do card, e todas as
etapas `de/from` e `para/to` dos seus `stage_changed`, ignorando etapas
`is_lost`, etapas **arquivadas** e etapas de outro funil, é ≥ posição de X. Um
card que foi a "Negociação" e voltou continua contando em "Negociação".
Etapa arquivada não conta pela posição: depois de reorganizar o funil, a posição
de uma etapa antiga não diz mais nada sobre avanço (uma "Compareceu" arquivada
na posição 60 faria todo card que passou por ela contar como "Ganho").

### 2.3 Recorte por dimensão

O usuário escolhe uma (ou nenhuma):

| `dimensao` | Valor de cada card | Linhas |
|---|---|---|
| `campo_contato` + `campo` | `contacts.custom_fields[campo]` do contato do card | Todas as opções do campo `select` do funil padrão (com zero), + "(sem valor)", + "(fora da lista)" |
| `campo_card` + `campo` | `crm_leads.custom_fields[campo]` do card | Todas as opções do campo `select` do funil escolhido, + as mesmas duas |
| `etiqueta` + `prefixo` | Etiquetas do contato, cada uma passada por `normalizarTag` (a de contato é gravada como foi digitada), sem repetição, que começam com o prefixo normalizado | Etiquetas encontradas, + "(sem etiqueta com o prefixo)". Contato com duas etiquetas conta nas duas (declarado); "Criativo-A" e "criativo-a" no mesmo contato contam uma vez. |
| `campanha` | `campanhaDoContato` do contato | Campanhas com gasto ou com contato atribuído, + "(sem campanha)". Rótulo = nome da campanha vindo dos insights; campanha atribuída SEM gasto no período não tem nome nessa leitura e aparece pelo id (número da plataforma, não é dado pessoal). Exige investimento `ok`; senão a linha de dimensão volta vazia com o mesmo estado do investimento. |

Contato **anonimizado** não tem campanha nem valor de dimensão: cai no balde
"(sem valor)" — mesma exclusão da tela Meta Ads (`resultado-crm.ts:81`).

Para cada valor: **leads, interagiram, ganhos, receita (por moeda), agendados,
realizados** — e, só em `campanha`, **investimento** da campanha.
Agendamento herda o valor do card vinculado; sem vínculo, do card mais recente do
contato neste funil (campo do card) ou do contato (demais dimensões). Um
compromisso pode ter vínculo com mais de um card (o vínculo é gravado a cada
transição para o card ativo daquele momento, `_handler.ts:823,862-869`): conta
UMA vez, pelo vínculo mais recente (`created_at`) a um card deste funil.

### 2.4 API

`GET /api/v1/metrics/funil`

- `requireRole("manager", { resource: "metrics" })`. Read-only ⇒ sem audit.
- Query Zod: `de`, `ate` (`z.iso.date()`, opcionais), `pipeline_id` (uuid,
  opcional), `dimensao` (`enum`), `campo` (`/^[a-z][a-z0-9_]*$/i`, ≤40), `prefixo`
  (1..40). `campo` obrigatório para `campo_*`; `prefixo` para `etiqueta`. Janela
  invertida ou > 90 dias ⇒ 422. Campo que não é `select` do funil certo ⇒ 422.
  Funil de outra org / arquivado ⇒ 404.
- Toda leitura de CRM pelo **client de sessão** com `.eq("organization_id", org)`
  explícito (org de `requireRole`, nunca da query). A credencial de anúncios pelo
  admin client via `lerCredencialDeLeitura` (já filtra org).
- Resposta `ok({...})`: só contagens, somas, rótulos de etapa/opção/etiqueta/
  campanha, ids de etapa, de funil e de campanha. **Nenhum** nome, telefone, e-mail, id de
  contato ou de card, nem valor de campo de texto livre. `truncado: true` quando
  alguma leitura paginada não coube.
- Mensagens de erro passam por `traduzir` com o idioma de quem chamou, e cada
  uma tem entrada `es` no dicionário (cobrado no teste da rota — o guard de
  i18n ignora `app/api`).
- Inclui as opções dos filtros (funis ativos; campos `select` do contato e do card)
  para a tela montar os seletores com uma chamada só.
- Nada é enviado para fora do CRM: a única saída de rede são LEITURAS da
  plataforma de anúncios, iguais às que `/app/ads/meta` já faz.

---

## 3. Decisões e por quê

1. **Sem migration.** O precedente (`reports/tags`) agrega na aplicação com
   paginação e teto; o volume de uma PME em 90 dias cabe. Função SQL fica para
   quando `truncado` aparecer em instalação real — aí entra com a tripla completa e
   `revoke execute ... from public, anon`. `ponytail:` teto de 10×1000 linhas por
   leitura; subir para RPC quando medir truncamento.
2. **Coorte para Leads/Interagiram/etapas; evento para Ganhos e Agenda.** A taxa
   de interação só faz sentido sobre quem entrou no período; ganho e consulta são
   desfechos que o gestor procura "no mês". Misturar é o que o pedido descreve
   ("ganhos no período"), e cada régua diz qual é qual.
3. **"Chegou a" por posição, a partir das duas gramáticas.** Ler só uma deixaria
   de fora todo movimento feito pelo agente, pela agenda, pelo handoff e pela
   supervisão — exatamente os que contam "Interagiu".
4. **Custo por venda e ROAS só sobre ganhos atribuídos a campanha.** Dividir o gasto
   pelos ganhos totais atribui ao anúncio as vendas de indicação, e o pedido de
   origem (§6 item 5) é separar pago de indicação. O pedido dizia "só quando houver
   investimento e receita na mesma moeda": vale literalmente para ROAS; o custo por
   venda não usa receita, então exige só investimento `ok` e ganhos de anúncio > 0.
   Ganhos totais e receita total continuam na tela, ao lado.
5. **Conta de anúncios = a mesma regra da tela Meta Ads.** A conta padrão é
   opcional na configuração ("Em branco, ela abre a primeira conta ativa",
   `app/app/settings/meta-ads/_form.tsx:114-123`); exigir a padrão aqui faria
   quem não preencheu ver gasto lá e "escolha a conta" aqui. Ordem: padrão,
   senão primeira ativa, senão primeira; o nome da conta usada vai para a régua.
   Padrão gravada que o token não alcança vira `indisponivel`
   (`conta_fora_do_alcance`), nunca troca de conta em silêncio. Não aceita
   `account_id` na query (YAGNI). Os avisos seguem `podeConectar`
   (`app/app/ads/meta/page.tsx:50-53`): admin lê "Configurações › Meta Ads",
   manager lê "peça a quem administra".
6. **`manager`.** Investimento, receita e ROAS são da empresa inteira (mesma razão
   de `app/app/ads/meta/page.tsx:5-11`). Client de sessão mesmo assim, para herdar
   a RLS se o piso descer um dia.
7. **Dimensão só de campo `select`.** Garante que o que sai na resposta é rótulo de
   opção cadastrada, não texto livre digitado (que pode conter dado de saúde ou
   PII). Valor fora das opções vira o balde "(fora da lista)", sem o texto.
8. **Fuso:** CRM no fuso da organização (`fusoUtilizavel(authz.org.timezone)`);
   gasto no fuso da conta de anúncios (é como a plataforma fecha o dia). As mesmas
   datas civis vão para os dois; a régua do Investimento diz isso, e as do Custo
   por venda e do ROAS também, porque dividem números de janelas que podem não
   coincidir (achado da revisão de 2026-10-06; a tela Meta Ads alinha o CRM ao
   fuso da conta, mas o pedido aqui fixa o fuso da organização).
9. **Leituras da plataforma por carregamento:** contas, depois insights +
   anúncios em paralelo (3 chamadas; as contas vêm antes porque escolhem a conta). A tela usa `staleTime` de 5 min e não recarrega ao focar a janela; o
   cliente não re-tenta (`retry: false`), porque cada tentativa gasta cota.
10. **Tela fora da barra lateral**, porta no hub — a barra está medida no limite.
11. **Investimento é da CONTA, o painel é do FUNIL.** `lerInsights` não tem filtro
    de funil. Com dois funis, Custo por venda e ROAS de cada um dividem o gasto
    inteiro pelos ganhos de anúncio só daquele funil. Não escondemos os números:
    a régua do Investimento, do Custo por venda e do ROAS diz "gasto da conta
    inteira, não só deste funil".
12. **Paginação dentro de cada lote.** Movimentos são lidos com `.in("lead_id",
    lote)`, e um lote passa de 1000 linhas fácil (100 cards × 11 movimentos);
    `max_rows` cortaria calado. Cada lote pagina com `range` + `count: "exact"`
    na ordem `lead_id, performed_at, id`, e o que não coube vira `truncado`.

---

## 4. O que fica de fora

- Funil do agente "escolheu opção A/B", "aguardando pagamento", "pagou" como
  números próprios: saem do **recorte por campo do card** e do **funil por etapa**
  quando a organização tiver esses campos/etapas. Nada fixo no código.
- "Entrou em acompanhamento": no caso real é OUTRO funil (o de acompanhamento),
  então não aparece no funil comercial. Sai como o número **Leads** com esse
  funil escolhido no filtro.
- **Recorte por anúncio/criativo** com gasto: o gasto por anúncio exige insights
  `level=ad`, uma 4ª chamada à plataforma por carregamento. Fica de fora. O
  pedido "por criativo" hoje só é atendido pela etiqueta com prefixo (ex.:
  `criativo-`), digitada à mão — dito aqui para não parecer coberto.
- Data do ganho pelo último movimento para etapa `is_won` (contornaria o fato 4):
  exigiria ler os movimentos de todo ganho. Fica a limitação declarada; o
  conserto certo é o trigger, numa issue própria.
- Google Ads e outras plataformas (`google_ads` não tem leitor; ver
  `lib/plataformas-de-anuncio/registry.ts`).
- Financeiro externo (`configFinanceiro`) como fonte de receita — o painel usa o
  valor do card ganho. A tela Meta Ads continua sendo o lugar desse cruzamento.
- Comparação com período anterior, gráfico diário, exportar CSV.
- Recorte por atendente (Desempenho já faz).
- Função SQL / índice novo (ver decisão 1).
- Cache servidor dos números da plataforma.

---

## 5. Laço de retorno e mapa vivo (DoD 13)

- **Entrada:** cards, movimentos, agenda e gasto já existentes. **Saída:** a tela.
- **Quando erra:** `truncado: true` e os estados do investimento aparecem na tela;
  mapeamento ausente vira aviso com o caminho para consertar
  (CRM › Etapas do funil). Leitura com erro sobe como 500, nunca como zero.
- Mapa: `docs/architecture/painel-do-funil.architecture.json` com arestas para
  `crm_leads`/`crm_lead_activities`, `calendar_appointments`/`crm_lead_links` e a
  leitura de anúncios. Linha nova em `docs/testing/user-journey-map.md`.
- Fragmento `.changes/painel-do-funil.md` com `impacto: capacidade_nova`.
