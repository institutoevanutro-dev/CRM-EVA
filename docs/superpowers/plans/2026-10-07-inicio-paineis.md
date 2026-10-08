# Início com painéis da clínica — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seção "Visão da clínica" no Início, só para manager/admin, com quatro painéis: conversas (30 dias), agenda da semana por unidade, funil de vendas e origem dos pacientes no mês.

**Architecture:** Quatro funções SQL `SECURITY INVOKER` (migration 0330) agregam no banco; uma rota `GET /api/v1/inicio/paineis` (manager+) calcula as janelas no fuso da org e chama as quatro isoladamente; um componente `PaineisDaClinica` com query própria desenha quatro cartões (recharts no de conversas).

**Tech Stack:** Postgres/Supabase (RLS), Next.js 16 Route Handlers, React 19, react-query, recharts 3, Tailwind 4, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-07-inicio-paineis-design.md`

**Worktree:** `~/crm-eva-inicio`, branch `feat/inicio-paineis` (base `origin/main` 7686c512b). Migration número **0330** (reservado com a sessão Graphify em 07/10). PR vai para o Graphify.

## Global Constraints

- Janelas no fuso da org: `fusoUtilizavel(authz.org.timezone)` e `inicioDoDiaNoFuso` (já existem em `lib/metrics/painel-do-funil.ts` e `lib/plataformas-de-anuncio/meta/resultado-crm.ts`).
- "IA sozinha" = conversa nova com saída e sem mensagem humana; humano = `sent_by_user_id is not null` ou `sent_via in ('crm','user','external_device')`; "sem resposta" = nenhuma saída.
- Comparecimento = realizadas ÷ (realizadas + faltas); `null` quando o divisor é 0.
- Funções: `SECURITY INVOKER`, `language sql stable`, `set search_path = public`, `revoke execute … from public, anon`, `grant execute … to authenticated`.
- Trio de schema: `supabase/migrations/<ts>_0330_inicio_paineis.sql` + bloco idempotente no fim de `supabase/baseline.sql` + linha em `supabase/migrations/MANIFEST.md`.
- Gestão decidida no servidor: a rota é `requireRole("manager")`; a tela só pede quando `gestao` veio no `/api/v1/inicio`.
- Todo texto visível por `t()` e com espanhol em `lib/i18n/dicionario.ts`.
- `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` e, por mexer em schema, `pnpm test:db` antes do PR (se o Postgres local subir; senão o job `invariants` do CI).

## Review Focus

1. Organização sem nenhuma conversa, agenda, funil ou contato no período — cada cartão mostra estado vazio com frase, nunca gráfico quebrado nem "NaN%".
2. Org sem funil (ou todos arquivados) — o cartão de funil diz "Nenhum funil ativo", sem 404 na rota inteira.
3. Usuário da org A pedindo `p_org` da org B direto na RPC — zero linhas (invoker + RLS).
4. Virada de dia/mês no fuso de São Paulo (21h UTC-3 = 00h UTC) — a conversa das 22h do dia 31 conta no dia 31, não no dia 1.
5. Agent/viewer — a rota responde 403 e a seção não aparece.

---

### Task 1: Funções e índices no banco (migration 0330)

**Files:**
- Create: `supabase/migrations/20261007200000_0330_inicio_paineis.sql`
- Modify: `supabase/baseline.sql` (bloco no fim: `-- ---- Painéis do Início (migration 0330) ----`)
- Modify: `supabase/migrations/MANIFEST.md`
- Create: `tests/invariants/inicio-paineis.test.ts`

**Interfaces — Produces:**
```
fn_inicio_conversas_por_dia(p_org uuid, p_inicio timestamptz, p_fim timestamptz, p_fuso text)
  → table(dia date, ia_sozinha int, com_equipe int, sem_resposta int, soma_primeira_resposta_s float8, respondidas int)
fn_inicio_agenda(p_org uuid, p_inicio timestamptz, p_fim timestamptz)
  → table(unit_id uuid, unidade text, marcadas int, confirmadas int, realizadas int, faltas int, canceladas int)
fn_inicio_funil(p_org uuid, p_pipeline uuid, p_mes_inicio timestamptz, p_mes_fim timestamptz, p_ant_inicio timestamptz)
  → jsonb { etapas: [{id, nome, abertos}], mes: {ganhos, perdidos, valor: {BRL: "123"}}, anterior: {…} }
fn_inicio_origem(p_org uuid, p_inicio timestamptz, p_fim timestamptz)
  → table(origem text, utm_source text, total int)
```

- [ ] **Step 1: Invariante que falha** — `tests/invariants/inicio-paineis.test.ts` no padrão de `atrito-metrics.test.ts` (`seedGov()`, `sql()`, `lastLine()`; IDs próprios `beb0…`; janela fixa março/2026; fuso `America/Sao_Paulo`). Fixture: na `GOV_ORG`, três conversas novas em 10/03 (uma só com saída `sent_via='ai'`, uma com saída `sent_via='crm'` e `sent_by_user_id`, uma só com entrada) e uma criada em 31/03 22:00 local (= 01/04 01:00 UTC); dois agendamentos `completed` e um `no_show` numa unidade "Vitória", um `confirmed` sem unidade; funil com duas etapas e leads abertos 2/1, um `won` de 15000 BRL em março e um `lost` em fevereiro; contatos de março com `source` `meta_ads`, `whatsapp`, `webhook` (utm_source `site`). Na org vizinha, uma conversa e um contato em março. Casos:
  - conversas 10/03 → `ia_sozinha=1, com_equipe=1, sem_resposta=1`; a de 31/03 22h cai em `dia='2026-03-31'`.
  - agenda: Vitória `realizadas=2, faltas=1`; linha `unit_id null` com `confirmadas=1`.
  - funil: `etapas[*].abertos` 2 e 1 em `position`; `mes.ganhos=1`, `mes.valor.BRL="15000"`; `anterior.perdidos=1`.
  - origem: `meta_ads 1`, `whatsapp 1`, `webhook/site 1`.
  - como membro da GOV_ORG pedindo a org vizinha → zero em todas.
  Run: `pnpm test:db` (ou `bash scripts/test-db.sh tests/invariants/inicio-paineis.test.ts`). Expected: FAIL (funções não existem).
- [ ] **Step 2: Migration**

```sql
-- 0330 — Painéis do Início (spec docs/superpowers/specs/2026-10-07-inicio-paineis-design.md).
-- SECURITY INVOKER: a RLS de cada tabela continua valendo. Agregação no banco
-- (PostgREST corta em 1000 linhas).
create index if not exists conversations_org_created_idx on public.conversations (organization_id, created_at);
create index if not exists contacts_org_created_idx on public.contacts (organization_id, created_at);

create or replace function public.fn_inicio_conversas_por_dia(p_org uuid, p_inicio timestamptz, p_fim timestamptz, p_fuso text)
returns table(dia date, ia_sozinha int, com_equipe int, sem_resposta int, soma_primeira_resposta_s float8, respondidas int)
language sql stable set search_path = public as $$
  with conv as (
    select c.id, (c.created_at at time zone p_fuso)::date as dia
      from public.conversations c
     where c.organization_id = p_org and not c.is_group
       and c.created_at >= p_inicio and c.created_at < p_fim
  ), por_conv as (
    select conv.id, conv.dia,
           coalesce(bool_or(m.direction = 'outbound'), false) as saiu,
           coalesce(bool_or(m.direction = 'outbound' and (m.sent_by_user_id is not null
                    or m.sent_via in ('crm','user','external_device'))), false) as humano,
           min(m.sent_at) filter (where m.direction = 'inbound') as pri_in,
           min(m.sent_at) filter (where m.direction = 'outbound') as pri_out
      from conv
      left join public.messages m on m.conversation_id = conv.id and m.organization_id = p_org
     group by conv.id, conv.dia
  )
  select dia,
         (count(*) filter (where saiu and not humano))::int,
         (count(*) filter (where humano))::int,
         (count(*) filter (where not saiu))::int,
         coalesce(sum(extract(epoch from pri_out - pri_in)) filter (where pri_out > pri_in), 0)::float8,
         (count(*) filter (where pri_out > pri_in))::int
    from por_conv group by dia order by dia;
$$;

create or replace function public.fn_inicio_agenda(p_org uuid, p_inicio timestamptz, p_fim timestamptz)
returns table(unit_id uuid, unidade text, marcadas int, confirmadas int, realizadas int, faltas int, canceladas int)
language sql stable set search_path = public as $$
  select a.unit_id, u.name,
         (count(*) filter (where a.status <> 'cancelled'))::int,
         (count(*) filter (where a.status = 'confirmed'))::int,
         (count(*) filter (where a.status = 'completed'))::int,
         (count(*) filter (where a.status = 'no_show'))::int,
         (count(*) filter (where a.status = 'cancelled'))::int
    from public.calendar_appointments a
    left join public.calendar_units u on u.id = a.unit_id and u.organization_id = p_org
   where a.organization_id = p_org and a.starts_at >= p_inicio and a.starts_at < p_fim
   group by a.unit_id, u.name
   order by u.name nulls last;
$$;

create or replace function public.fn_inicio_funil(p_org uuid, p_pipeline uuid, p_mes_inicio timestamptz, p_mes_fim timestamptz, p_ant_inicio timestamptz)
returns jsonb language sql stable set search_path = public as $$
  with bloco as (
    select janela,
           count(*) filter (where l.status = 'won') as ganhos,
           count(*) filter (where l.status = 'lost') as perdidos
      from (values ('mes', p_mes_inicio, p_mes_fim), ('anterior', p_ant_inicio, p_mes_inicio)) as j(janela, de, ate)
      left join public.crm_leads l on l.organization_id = p_org and l.pipeline_id = p_pipeline
           and l.status in ('won','lost') and l.closed_at >= j.de and l.closed_at < j.ate
     group by janela
  ), valor as (
    select j.janela, jsonb_object_agg(coalesce(l.currency, 'BRL'), s.total::text) as valor
      from (values ('mes', p_mes_inicio, p_mes_fim), ('anterior', p_ant_inicio, p_mes_inicio)) as j(janela, de, ate)
      join lateral (
        select l2.currency, sum(l2.value_cents) as total from public.crm_leads l2
         where l2.organization_id = p_org and l2.pipeline_id = p_pipeline and l2.status = 'won'
           and l2.closed_at >= j.de and l2.closed_at < j.ate and l2.value_cents is not null
         group by l2.currency) s on true
      cross join lateral (select s.currency) l
     group by j.janela
  )
  select jsonb_build_object(
    'etapas', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'nome', s.name,
        'abertos', (select count(*) from public.crm_leads l where l.organization_id = p_org
                     and l.stage_id = s.id and l.status = 'open')) order by s.position)
        from public.crm_stages s where s.organization_id = p_org and s.pipeline_id = p_pipeline
         and not s.is_archived and not s.is_won and not s.is_lost), '[]'::jsonb),
    'mes', (select jsonb_build_object('ganhos', b.ganhos, 'perdidos', b.perdidos,
        'valor', coalesce((select v.valor from valor v where v.janela = 'mes'), '{}'::jsonb)) from bloco b where b.janela = 'mes'),
    'anterior', (select jsonb_build_object('ganhos', b.ganhos, 'perdidos', b.perdidos,
        'valor', coalesce((select v.valor from valor v where v.janela = 'anterior'), '{}'::jsonb)) from bloco b where b.janela = 'anterior'));
$$;

create or replace function public.fn_inicio_origem(p_org uuid, p_inicio timestamptz, p_fim timestamptz)
returns table(origem text, utm_source text, total int)
language sql stable set search_path = public as $$
  select coalesce(nullif(c.source, ''), 'manual'), nullif(c.source_metadata ->> 'utm_source', ''), count(*)::int
    from public.contacts c
   where c.organization_id = p_org and c.created_at >= p_inicio and c.created_at < p_fim
     and not c.is_anonymized and c.merged_at is null
   group by 1, 2 order by 3 desc;
$$;

revoke execute on function public.fn_inicio_conversas_por_dia(uuid, timestamptz, timestamptz, text) from public, anon;
revoke execute on function public.fn_inicio_agenda(uuid, timestamptz, timestamptz) from public, anon;
revoke execute on function public.fn_inicio_funil(uuid, uuid, timestamptz, timestamptz, timestamptz) from public, anon;
revoke execute on function public.fn_inicio_origem(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.fn_inicio_conversas_por_dia(uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.fn_inicio_agenda(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.fn_inicio_funil(uuid, uuid, timestamptz, timestamptz, timestamptz) to authenticated;
grant execute on function public.fn_inicio_origem(uuid, timestamptz, timestamptz) to authenticated;
```
(Simplificar o CTE `valor` se o invariante mostrar duplicação; o contrato é o do bloco **Produces**.)
- [ ] **Step 3:** Copiar o mesmo SQL para o fim do `baseline.sql` sob o rótulo; linha no `MANIFEST.md` (`0330 | inicio_paineis | quatro funções invoker e dois índices para os painéis do Início`).
- [ ] **Step 4:** `pnpm test:db` → PASS (incluindo `hardening-definer-varredura`, `manifest-x-migrations`).
- [ ] **Step 5:** Commit `feat(db): funções dos painéis do Início (0330)`.

### Task 2: Janelas e rótulos (lib/inicio/paineis.ts)

**Files:** Create `lib/inicio/paineis.ts`, `lib/inicio/paineis.test.ts`.

**Interfaces — Produces:**
```ts
export function janelasDosPaineis(agora: Date, fuso: string): {
  conversas: { inicio: string; fim: string; dias: string[] };      // 30 dias terminando hoje
  semana: { inicio: string; fim: string; de: string; ate: string }; // segunda..domingo
  mes: { inicio: string; fim: string }; mesAnterior: { inicio: string };
};
export type Origem = "anuncio_meta" | "anuncio_google" | "whatsapp" | "formulario" | "prontuario" | "manual" | "outros";
export function origemDoContato(source: string): Origem;
export const ROTULO_DA_ORIGEM: Record<Origem, string>;
export function preencherDias(dias: string[], linhas: Array<{ dia: string } & Record<string, unknown>>): …; // dias sem conversa viram zeros
```
- [ ] Teste que falha: 07/10/2026 12:00 em `America/Sao_Paulo` → semana `2026-10-05`..`2026-10-11`, mês `2026-10-01T03:00:00.000Z`, mês anterior `2026-09-01T03:00:00.000Z`, 30 dias de `2026-09-08` a `2026-10-07`; `origemDoContato("meta_ads")="anuncio_meta"`, `"webhook"="formulario"`, `"prontuario_eva"="prontuario"`, `"whatsapp"="whatsapp"`, `""/"manual"="manual"`, `"xyz"="outros"`; `preencherDias` devolve 30 linhas com zeros onde não há dado.
- [ ] Implementar com `inicioDoDiaNoFuso` e a aritmética de dia de `painel-do-funil.ts`. Rodar, ver passar, commit.

### Task 3: Rota `GET /api/v1/inicio/paineis`

**Files:** Create `app/api/v1/inicio/paineis/route.ts`, `app/api/v1/inicio/paineis/route.test.ts`.

- [ ] Teste que falha (mockando `requireRole` e `createClient` como fazem os testes vizinhos de rota): agent → 403; manager → `{ data: { conversas, agenda, funil, origem, funis } }`, cada um `{ ok:true, … }`; RPC que devolve erro vira `{ ok:false }` só naquele painel; `?funil=<uuid>` inexistente → usa o padrão.
- [ ] Implementar: `requireRole("manager", { requestId, resource: "inicio" })`; `fuso = fusoUtilizavel(authz.org.timezone)`; `janelasDosPaineis`; ler funis (`crm_pipelines` não arquivados, `is_default` primeiro); `Promise.all` das quatro RPCs, cada uma isolada; conversas passam por `preencherDias` e calculam `primeiraRespostaMediaS = soma/respondidas`; origem agrupada por `origemDoContato`. Resposta com `ok()`.
- [ ] Rodar, commit.

### Task 4: Cartões na tela

**Files:** Create `app/app/inicio/_components/PaineisDaClinica.tsx` e `app/app/inicio/_components/PaineisDaClinica.test.tsx`; Modify `app/app/inicio/_components/PainelInicio.tsx` (renderiza `<PaineisDaClinica />` abaixo do "Meu dia" quando `gestao` não é null); Modify `lib/i18n/dicionario.ts`.

- [ ] Teste que falha (render com `QueryClientProvider` e `fetch` mockado): os quatro títulos ("Conversas · últimos 30 dias", "Agenda da semana", "Funil de vendas", "Origem dos pacientes · mês"); comparecimento "67%" para 2 realizadas e 1 falta; "—" sem realizadas nem faltas; estado vazio "Nenhuma conversa nova nos últimos 30 dias."; painel com `{ok:false}` mostra "Não foi possível carregar este painel." sem derrubar os outros.
- [ ] Implementar: query `["inicio-paineis", funil]`; grade `grid gap-4 lg:grid-cols-2`; cartão no padrão do Início (`rounded-2xl border bg-surface p-5 shadow-sm`); conversas com `BarChart` empilhado (`ResponsiveContainer`, cores `var(--color-accent-600)`, `var(--color-gold)`/`--color-warning`, `var(--color-neutral-300)`; legenda com rótulos), número grande do tempo médio; agenda em linhas por unidade; funil com barras horizontais em `div` (largura = abertos/máximo) + três números com seta ▲▼ vs mês anterior; origem em barras horizontais com rótulo e detalhe do utm. `CarregandoLinhas`-like skeleton enquanto carrega.
- [ ] Rodar, commit.

### Task 5: e2e e cobertura do CI

**Files:** Create `tests/e2e/inicio-paineis.spec.ts`; Modify `.github/workflows/e2e.yml` (incluir em uma `SPECS_PARTE_*`, exigido por `tests/unit/e2e-cobertura-completa.test.ts`).
- [ ] Spec: manager entra, `/app/inicio` mostra os quatro títulos e nenhum "Não foi possível"; agent entra e a seção não existe; `GET /api/v1/inicio/paineis` como agent → 403. Captura em `.superpowers/evidence/inicio-paineis/`.
- [ ] Commit.

### Task 6: Prova e PR

- [ ] `pnpm typecheck && pnpm lint`; `pnpm test:unit` (exit code, rodapé, Errors); `pnpm test:db` se possível.
- [ ] Prova visual (render estático dos cartões com dados fictícios e o CSS compilado, como na parte 2) → mandar ao dono e esperar o ok.
- [ ] `.changes/inicio-paineis-da-clinica.md` (`capacidade_nova`), push, `gh pr create`, número ao Graphify.
