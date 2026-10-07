# Painel do funil — plano TDD

> Desenho: `docs/superpowers/specs/2026-10-06-painel-do-funil-design.md`.
> Worktree: `/Users/andreluislopescosta/crm-f2-painel`, branch `feat/painel-do-funil`.
> Sem migration. Cada passo: teste vermelho → mudança mínima → verde → commit
> (`git add <arquivos pelo nome>`, conferir `git status --short` antes).

Comando de arquivo isolado (usado em todo passo):

```bash
cd /Users/andreluislopescosta/crm-f2-painel && pnpm vitest run <arquivo> > /tmp/pf.log 2>&1; echo "exit=$?"; grep -aE "Test Files|Tests |Errors " /tmp/pf.log
```

Arquivos novos, no total:

| Arquivo | Papel |
|---|---|
| `lib/metrics/painel-do-funil.ts` | Funções PURAS: janela, etapa alcançada, agregação, dimensão, custo/ROAS |
| `lib/plataformas-de-anuncio/meta/investimento.ts` | Leitura do gasto + moeda + mapa anúncio→campanha, com estados |
| `app/api/v1/metrics/funil/route.ts` | GET: Zod, papel, leituras paginadas, chama as puras |
| `hooks/metrics/usePainelDoFunil.ts` | react-query |
| `app/app/painel-do-funil/page.tsx` + `_components/PainelDoFunilClient.tsx` | Tela |
| `tests/unit/painel-do-funil-agregacao.test.ts` | Puras |
| `tests/unit/painel-do-funil-investimento.test.ts` | Estados do investimento |
| `tests/unit/painel-do-funil-rota.test.ts` | Rota |
| `tests/unit/painel-do-funil-navegacao.test.ts` | Porta no catálogo |
| `tests/e2e/painel-do-funil.spec.ts` | Prova de tela |

---

## Passo 1 — janela do período no fuso da organização

**Teste (vermelho)** em `tests/unit/painel-do-funil-agregacao.test.ts`:
- `janelaDoPeriodo({ de: "2026-09-01", ate: "2026-09-30", fuso: "America/Sao_Paulo" })`
  → `{ inicio: "2026-09-01T03:00:00.000Z", fimExclusivo: "2026-10-01T03:00:00.000Z", dias: 30 }`.
- Padrão: `periodoPadrao(new Date("2026-10-06T02:00:00Z"), "America/Sao_Paulo")`
  → `{ de: "2026-09-05", ate: "2026-10-04" }` (às 23h de 05/10 em Brasília, "hoje" é 05/10; termina ONTEM, como a tela Meta Ads; 30 dias inclusivos).
- `ate < de` → lança `RangeError("periodo_invertido")`; 91 dias → `RangeError("periodo_longo")`.

**Mudança mínima:** criar `lib/metrics/painel-do-funil.ts` com `periodoPadrao`,
`janelaDoPeriodo`, `DIAS_MAXIMOS = 90`, reusando `inicioDoDiaNoFuso` de
`lib/plataformas-de-anuncio/meta/resultado-crm.ts` (não reescrever).

**Verificar:** comando isolado acima; `pnpm typecheck`.

## Passo 2 — "chegou à etapa", lendo as DUAS gramáticas

**Teste:**
- Etapas: `novo(10)`, `interagiu(20, hint contacted)`, `negociacao(30)`, `ganho(40, is_won)`, `perdido(50, is_lost)`, `velha(25, is_archived)`.
- `posicaoAlcancada({ stage_id: "novo" }, [])` → 10.
- Movimento `{ payload: { from_stage_id: "novo", to_stage_id: "negociacao" } }` e depois `{ payload: { de: "negociacao", para: "interagiu" } }`, card hoje em `interagiu` → 30 (voltou, mas chegou a 30).
- Card hoje em `perdido`, movimento `{ de: "interagiu", para: "perdido" }` → 20 (perdido não conta como avanço).
- Etapa de outro funil no payload → ignorada.
- Payload sem nenhuma das chaves / não-objeto → ignorado sem lançar.
- Etapa ARQUIVADA não conta pela posição: `{de: novo, para: velha}` seguido de
  `{de: velha, para: interagiu}` → 20; card em `novo` com `{de: novo, para: velha}`
  e `{de: velha, para: novo}` → 10 (nunca 25).

**Mudança mínima:** `posicaoAlcancada(card, movimentos, etapasPorId)` e o leitor
interno `etapasDoMovimento(payload)` → `[from ?? de, to ?? para]` filtrando string.

## Passo 3 — leads, interagiram e funil por etapa (coorte)

**Teste:** `agregarCoorte({ etapas, cards, movimentosPorCard })`:
- 4 cards: um em `novo`, um que passou por `interagiu`, um em `ganho`, um `perdido` vindo de `novo`.
  → `leads: 4`, `interagiram: 2`, `taxa_interacao: 0.5`,
  `por_etapa: [{novo,4},{interagiu,2},{negociacao,1},{ganho,1}]` (sem `perdido`, sem `velha` arquivada),
  `perdidos: 1`.
- Funil sem etapa `contacted` → `interagiram: null`, `taxa_interacao: null`, `aviso: "sem_etapa_de_interacao"`.
- 0 cards → `leads: 0`, `taxa_interacao: null` (nunca `0` inventado).
- Etapa ARQUIVADA com hint `contacted` é ignorada; vale a ativa. Só a arquivada
  tem o hint → `interagiram: null` com o aviso (duas ATIVAS com o hint são
  impossíveis: `uniq_crm_stages_pipeline_hint`).

**Mudança mínima:** `agregarCoorte` em `lib/metrics/painel-do-funil.ts`.

## Passo 4 — ganhos e receita por moeda

**Teste:** `agregarGanhos(cardsGanhos)`:
- `[{value_cents: 49000, currency: "BRL"}, {value_cents: 65000, currency: "BRL"}, {value_cents: null, currency: "BRL"}, {value_cents: 1000, currency: "USD"}, {value_cents: 500, currency: null}]`
  → `ganhos: 5`, `receita: [{moeda:"BRL", cents:"114000"}, {moeda:"USD", cents:"1000"}]`, `sem_valor: 1`, `sem_moeda: 1`.
- Somas em `bigint` serializadas como string (mesmo padrão de `resultado-crm.ts:104-105`).

## Passo 5 — agenda: agendados, realizados, faltas, sem baixa, taxa

**Teste:** `agregarAgenda(compromissos, agora)`:
- status `completed`×3, `no_show`×1, `confirmed` com `ends_at` passado ×1, `pending` futuro ×1, `cancelled`×2
  → `agendados: 6`, `realizados: 3`, `faltas: 1`, `sem_baixa: 1`, `cancelados: 2`, `taxa_comparecimento: 0.75`.
- Só cancelados → `taxa_comparecimento: null`.

## Passo 6 — custo por venda e ROAS

**Teste:** `custoERoas({ investimento, ganhosDeAnuncio, receitaDeAnuncio })`:
- investimento `{estado:"ok", moeda:"BRL", cents: 100000}`, 4 ganhos de anúncio, receita `[{BRL, "300000"}]`
  → `custo_por_venda_cents: 25000`, `roas: 3`.
- Receita só em USD → `roas: null`, custo continua `25000`.
- 0 ganhos de anúncio → `custo_por_venda_cents: null`.
- investimento `cents: 0` → `roas: null`.
- estado `nao_conectado` → os dois `null`.

## Passo 7 — valor da dimensão por card

**Teste:** `valoresDaDimensao(dimensao, { card, contato, campanha })` devolve chaves de balde:
- `campo_contato` `origem` com opções `[{value:"instagram"},{value:"indicacao"}]`: contato com `custom_fields.origem = "indicacao"` → `["indicacao"]`; ausente → `["__sem_valor"]`; `"tiktok"` → `["__fora_da_lista"]`; contato `null` → `["__sem_valor"]`.
- `campo_card` lê `card.custom_fields`, mesma regra.
- `etiqueta` prefixo `"Criativo-"`: tags `["criativo-a","criativo-b","vip"]` → `["criativo-a","criativo-b"]`; `["Criativo-A","criativo-a"]` → `["criativo-a"]` (uma vez); nenhuma → `["__sem_valor"]` (prefixo E cada etiqueta normalizados com `normalizarTag` de `lib/contacts/tag-normalizada.ts`).
- `campanha`: campanha `"123"` → `["123"]`; `null` → `["__sem_valor"]`.
- Contato anonimizado → `["__sem_valor"]` em `campo_contato`, `etiqueta` e `campanha`.
- Um só balde de ausência (`__sem_valor`); a tela escolhe a frase pela dimensão.

## Passo 8 — tabela por dimensão

**Teste:** `agregarPorDimensao({...})` com 3 cards da coorte, 2 ganhos (um criado antes do período), 2 compromissos (um com vínculo, outro só pelo contato):
- Linhas incluem TODAS as opções do campo (zeradas) + baldes especiais que tiverem contagem.
- Cada linha: `leads, interagiram, ganhos, receita[], agendados, realizados` (e `investimento_cents` em `campanha`).
- Compromisso sem vínculo herda o valor do card mais recente do contato (campo do card).
- Compromisso com DOIS vínculos a cards deste funil conta uma vez, pelo vínculo
  mais recente (`created_at`); vínculo a card de outro funil é ignorado.
- Rótulos vêm das opções (`label`), nunca do valor cru; balde `__fora_da_lista` não carrega o texto digitado.
- **Asserção de privacidade:** `JSON.stringify(resultado)` não contém nenhum id de card/contato nem o valor fora da lista usado na fixture.

**Commit 1** (passos 1–8):
`feat(metricas): agregações puras do painel do funil`.

## Passo 9 — investimento do período (estados)

**Teste** `tests/unit/painel-do-funil-investimento.test.ts`, com `vi.mock` de
`@/lib/plataformas-de-anuncio/credenciais-de-leitura` e `@/lib/plataformas-de-anuncio/meta/insights`:
- Sem credencial → `{ estado: "nao_conectado" }`; `cifra_indisponivel` → `{ estado: "indisponivel", motivo: "cifra_indisponivel" }`.
- Conta escolhida pela regra de `MetaAdsClient.tsx:119-124`: padrão; sem padrão, a
  primeira com `status === 1`; senão a primeira da lista.
- `listarContas` vazia → `{ estado: "sem_conta" }` e **nenhuma** chamada a `lerInsights`.
- Padrão gravada que NÃO aparece em `listarContas` → `{ estado: "indisponivel",
  motivo: "conta_fora_do_alcance" }`, sem `lerInsights` e sem moeda presumida.
- `lerInsights` ok com `spend: "120.50"` e `"79.50"`, `listarContas` com moeda `BRL`, `lerAnunciosDaConta` ok
  → `{ estado:"ok", conta:{id,nome}, moeda:"BRL", cents: 20000, porCampanha: Map<id,{nome,cents}>, campanhaPorAnuncio: Map }`.
- `lerInsights` falha `token_invalido` → `{ estado: "indisponivel", motivo: "token_invalido" }` (sem lançar).
- `spend` ausente numa linha → conta 0 nessa linha; `spend` não numérico → ignora.

**Mudança mínima:** `lib/plataformas-de-anuncio/meta/investimento.ts` exportando
`investimentoDoPeriodo(admin, orgId, de, ate)`; contas primeiro (escolhem a
conta), depois insights + anúncios em `Promise.all`.
`ponytail:` reais→centavos por `Math.round(x*100)` — vale para as moedas servidas
(BRL/MXN/USD, `lib/money.ts:223`); moeda sem centavos exige tabela de expoente.

**Verificar:** isolado + `pnpm lint:channels` (o arquivo fica dentro da fronteira permitida).

**Commit 2:** `feat(anuncios): investimento do período com estados explícitos`.

## Passo 10 — rota: papel, Zod, escopo de org

**Teste** `tests/unit/painel-do-funil-rota.test.ts` (padrão de
`tests/unit/reports-por-etiqueta.test.ts`: `vi.mock` de `require-role`,
`supabase/server`, `supabase/admin` e `investimento`). O client falso grava cada
`.from(tabela)` e cada `.eq(col, val)`:
1. `requireRole` negado → devolve a resposta dele (403) e não lê nada.
2. `requireRole` chamado com `"manager"`.
3. 422: `de=2026-99-99`; `de > ate`; 91 dias; `dimensao=campo_contato` sem `campo`; `campo` que não é `select` do funil padrão; `dimensao=etiqueta` sem `prefixo`; `pipeline_id=nao-uuid`.
4. `pipeline_id` que não volta na leitura com `.eq("organization_id", org)` → 404 `not_found`.
5. **Toda** leitura de `crm_leads`, `crm_lead_activities`, `crm_stages`, `crm_pipelines`, `calendar_appointments`, `crm_lead_links`, `contacts` recebeu `.eq("organization_id", ORG)` com o org do `requireRole` — mesmo com `?organization_id=outra` na query. Nenhuma leitura de `organizations` (o fuso vem de `authz.org.timezone`).
6. Leitura com `error` → 500, nunca números zerados.
7. Página cheia em todas as 10 → `truncado: true`; lote de movimentos com mais
   linhas do que cabe → `truncado: true`.
7b. Sem dimensão e com investimento `ok`: `ganhos_de_anuncio` é calculado (os
   contatos dos ganhos são lidos sempre que o investimento está `ok`).
7c. Cada mensagem de erro nova da rota tem entrada `es` no dicionário.
8. Resposta não tem chaves `name`, `phone_number`, `email`, `contact_id`, `lead_id`.
9. Feliz (sem leitura de `organizations`): payload tem `periodo {de, ate, fuso}`, `funil`, `numeros`, `por_etapa`, `dimensao`, `investimento`, `opcoes {funis, campos_contato, campos_card}`, `truncado`.

**Mudança mínima:** `app/api/v1/metrics/funil/route.ts`:
- fuso: `fusoUtilizavel(authz.org.timezone)` (já vem do `requireRole`);
- funil: `pipeline_id` ou `is_default`; etapas do funil;
- coorte: `crm_leads` `pipeline_id`, `created_at` na janela (paginado `range` + `count: "exact"`, ordem `created_at,id`, 10×1000);
- movimentos: `crm_lead_activities` `type = 'stage_changed'`, `.in("lead_id", lote)` em lotes de 100, só colunas `lead_id, payload`, CADA lote paginado com `range` + `count: "exact"` na ordem `lead_id, performed_at, id`;
- ganhos: `crm_leads` `status='won'`, `closed_at` na janela;
- agenda: `calendar_appointments` `starts_at` na janela; `crm_lead_links` `target_kind='appointment'` dos ids; cards dos contatos sem vínculo;
- contatos: `id, custom_fields, tags, source_metadata, is_anonymized` em lotes de 100 — dos cards da coorte/agenda quando a dimensão é do contato ou campanha, e dos GANHOS sempre que o investimento está `ok` (Ganhos de anúncio, Custo por venda e ROAS dependem deles);
- investimento: `investimentoDoPeriodo` (sempre; a atribuição de "ganhos de anúncio" precisa do mapa);
- monta com as puras e responde `ok(...)`. Sem audit.

**Verificar:** isolado; `pnpm typecheck`; `pnpm lint`.

**Commit 3:** `feat(metricas): rota GET /api/v1/metrics/funil`.

## Passo 11 — porta no catálogo

**Teste** `tests/unit/painel-do-funil-navegacao.test.ts`:
- `NAV_DESTINATIONS` (de `@/lib/navigation/registry`) tem `/app/painel-do-funil` com `group: "analise"`, `minRole: "manager"`, `section: "Os números do período"` e **sem** `sidebar`.
- Rodar também `tests/unit/navegacao-completude.test.ts` e `tests/unit/navegacao-registry.test.ts`: depois de criar a página no passo 12, sem a entrada o primeiro reprova (é a prova de que a porta é exigida).

**Mudança mínima:** entrada em `lib/navigation/catalogo.ts`, logo depois de Meta Ads
(`catalogo.ts:540-551`), com comentário do porquê (fecha a conta que Desempenho e
Meta Ads deixam cada uma pela metade).

## Passo 12 — tela

**Teste (vermelho):** `tests/unit/i18n-espanhol-cobre-a-tela.test.ts` passa a varrer
a página nova (ele varre `app` e `components`, ignora `api`); todo texto novo sem
entrada `es` no `lib/i18n/dicionario.ts` reprova. Ele NÃO cobre o catálogo, e
`idioma-da-interface.test.ts` só olha itens com `sidebar` — por isso
`painel-do-funil-navegacao.test.ts` cobra `label` e `description` da entrada nova
no `DICIONARIO`, e o teste da rota cobra as mensagens de erro.

**Mudança mínima:**
- `hooks/metrics/usePainelDoFunil.ts`: `useQuery` com `queryKey ["metrics","funil",params]`, `staleTime: 300_000`, `refetchOnWindowFocus: false`, `retry: false`.
- `app/app/painel-do-funil/page.tsx`: servidor, `requireAuth` + `resolveActiveOrg`, `redirect("/403")` abaixo de `manager` (igual `app/app/ads/meta/page.tsx:34-40`), superfície clara.
- `_components/PainelDoFunilClient.tsx`: filtros (duas `<input type="date">`, `Select` de funil, `Select` de dimensão + `Select` de campo ou `Input` de prefixo), blocos de número com a régua em texto pequeno embaixo, barras do funil por etapa (mesmo desenho de `MetricsClient.tsx:103-114`), tabela da dimensão com `components/ui/table`. Valores com `formatCents` (`lib/money.ts:184`), percentuais com `Intl.NumberFormat` do idioma. `null` → "—". Estados do investimento em frase.
- Todas as frases via `t()`, com espanhol no dicionário.

**Verificar:** `pnpm vitest run tests/unit/i18n-espanhol-cobre-a-tela.test.ts tests/unit/navegacao-completude.test.ts tests/unit/painel-do-funil-navegacao.test.ts`; `pnpm typecheck`; `pnpm lint`.

**Commit 4:** `feat(analise): tela Painel do funil com porta no hub de Análise`.

## Passo 13 — prova de tela (Playwright)

**Spec** `tests/e2e/painel-do-funil.spec.ts`: login com conta de teste do seed.
Não existe API de seed de funil, e o handler da agenda recusa `completed`/`no_show`
em compromisso que ainda não começou (`_handler.ts:366-389`): os compromissos
nascem com `starts_at` no PASSADO (admin client do ambiente de teste) e só depois
são marcados realizado/faltou. O resto do setup sai pela API real (funis, leads,
move). Criar um funil com etapa ligada a `contacted`, 3 cards (um
movido para "Interagiu", um ganho com valor), um compromisso `completed` e um
`no_show`; abrir `/app/analise`, clicar "Painel do funil", conferir por
`getByText`/`getBoundingClientRect`: Leads 3, Interagiram 2 (67%), Ganhos 1,
Realizados 1, Faltas 1, comparecimento 50%, Investimento "não conectado" (sem
credencial no ambiente fresco). Escolher dimensão por campo do card e ver as
opções listadas. Screenshot em `.superpowers/evidence/painel-do-funil/`.

Registrar a spec em uma `SPECS_PARTE_*` de `.github/workflows/e2e.yml`
(`tests/unit/e2e-cobertura-completa.test.ts` reprova spec órfã).

**Verificar:** ambiente fresco (baseline + `scripts/bootstrap-owner.ts`, `next build && next start`), `pnpm test:e2e tests/e2e/painel-do-funil.spec.ts`. Se o ambiente não subir: declarar **NÃO MEDIDO** no PR, com o motivo.

**Commit 5:** `test(e2e): prova de tela do Painel do funil`.

## Passo 14 — documentos de estado (DoD 13, 16, 17)

- `docs/architecture/painel-do-funil.architecture.json` no formato de
  `docs/architecture/indice-de-atrito.architecture.json`; rodar
  `tests/unit/mapas-de-arquitetura.test.ts`.
- Linha na jornada de Análise em `docs/testing/user-journey-map.md`.
- `.changes/painel-do-funil.md` com `impacto: capacidade_nova`, `secao` conforme
  `docs/doctrine/versionamento.md`; `pnpm release:conferir`.
- Descrição de `/app/metrics` em `catalogo.ts` não muda (continua verdadeira).

**Commit 6:** `docs(analise): mapa, jornada e fragmento do Painel do funil`.

## Passo 15 — suíte inteira

```bash
cd /Users/andreluislopescosta/crm-f2-painel && pnpm gov:verify > /tmp/vt.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests |Errors " /tmp/vt.log
grep -aE "^ *FAIL " /tmp/vt.log | sed 's/ > .*//' | sort | uniq -c
```

Exit code é a autoridade. Falha que não toca arquivo deste plano: rodar o
arquivo isolado e comparar com o código da `origin/main` para provar que é
pré-existente; registrar no PR.

`pnpm test:db`: não obrigatório (nenhum schema, RLS, função ou trigger muda; a
rota só lê). Rodar mesmo assim se sobrar tempo, para registrar verde.

---

## Riscos conhecidos

- Card que vai de perdido direto para ganho mantém o `closed_at` da perda
  (trigger `fn_crm_lead_close_on_stage`, `coalesce`): o ganho cai no período da
  perda. Declarado na régua; conserto no trigger, em issue separada, sem migration
  neste PR.
- Investimento é da conta inteira: com mais de um funil, custo por venda e ROAS
  de cada funil saem inflados. Declarado na régua.
- Volume acima de 10×1000 linhas por leitura → `truncado: true` na tela (nunca
  número falso). Conserto futuro: RPC `security invoker` com tripla de migration.
- Gasto fecha o dia no fuso da conta de anúncios; o CRM no da organização. Diferença
  de horas nas bordas do período, declarada na régua.
- Movimento de etapa feito por caminho que não grava `stage_changed` não entra em
  "chegou a". Hoje todos os escritores de `stage_id` listados no desenho gravam;
  caminho novo que não gravar some do funil sem erro.
- 3 leituras da plataforma por carregamento; conta com cota baixa pode ver
  `indisponivel: limite_de_chamadas` (estado tratado, sem retry).
