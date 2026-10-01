# Cadastro Incorporado v4 com coexistência — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** um admin clica em **Conectar WhatsApp** na aba Conexões › API Oficial, conclui o fluxo da Meta (Embedded Signup v4, variação de coexistência) e o canal oficial da organização fica Conectado sem colar token, WABA ou phone number id. Mensagem do celular aparece como "Celular" e silencia a IA na conversa; o histórico do celular entra sem IA, lead, automação ou janela de 24 h; desconexão pelo celular vira aviso na Central.

**Architecture:** a coexistência é **metadado da sessão `meta_cloud`**, não provider novo. A configuração da instalação (`app_id`, `es_config_id`) mora em `platform_meta_app` ao lado do `app_secret` que já existe. O caminho de gravação da conexão oficial (validar → cifrar → ressuscitar/inserir → assinar webhook → `metadata.webhook_da_conta`) sai da rota `POST /api/v1/channels/official` para `lib/channels/meta/conectar-canal-oficial.ts` e passa a ser usado pelos dois POSTs. Os webhooks novos entram pela rota existente; o eco do celular reaproveita `pausarIaPorAtendimentoManual` (que já é a regra do WAHA `fromMe`); o histórico vai para `event_log` e é processado por worker, com o gatilho `fn_emit_message_event` ignorando mensagem marcada como importada. Toda chamada à Graph passa por `baseDaGraph()` (override só em loopback), o que permite o e2e com Graph simulada no mesmo molde do Instagram.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript estrito, Vitest, Playwright, Postgres/Supabase com RLS, `event_log` + drain.

**Spec:** `docs/superpowers/specs/2026-10-01-cadastro-incorporado-coexistencia-design.md`

## Global Constraints

- **Prazo duro: 15/10/2026** (a Meta desliga o Embedded Signup v2). PR 1 até ~08/10; PR 2 **antes da conexão real** (webhook fora do ar durante a sincronização perde o histórico).
- **O `code` de troca vive 30 s.** O front envia ao servidor imediatamente; o servidor troca em `GET /oauth/access_token?client_id&client_secret&code` e valida com `debug_token` (app e escopos esperados).
- **Coexistência NÃO chama `/register`.** Só o evento `FINISH` (número novo) registra, com PIN gerado e guardado cifrado. Evento `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` pode trazer só `waba_id`: o `phone_number_id` vem de `GET /{waba_id}/phone_numbers`, conferindo `is_on_biz_app: true`.
- **`POST /{phone_number_id}/smb_app_data` uma vez por `sync_type`** (`smb_app_state_sync`, depois `history`), **até 24 h** após o onboarding. Falha não desfaz a conexão; a tela oferece "tentar de novo (até HH:MM)".
- **A grafia do parâmetro de coexistência em `extras` (v4) é conferida na tela da Meta antes de codar** (Task 0) e vive numa constante só. Sintoma de grafia errada: erro 3441030.
- **Resposta pelo celular silencia a IA com a MESMA regra do envio manual:** janela de 5 min renovada a cada mensagem humana. A regra já existe como `pausarIaPorAtendimentoManual` (`lib/escalacao/atendimento-manual.ts`, `PRAZO_DO_SILENCIO_MS = 5 min`, o mesmo valor de `HUMAN_REPLY_SILENCE_MS` em `app/api/v1/messages/_handler.ts:276`). **Não se extrai um segundo helper**: ver "Dúvidas" no fim.
- **Histórico não toca `last_inbound_at`** (abriria janela de 24 h que a Meta não honra), não incrementa não-lidas, não acorda IA, não cria lead, não dispara automação nem notificação. Idempotente por `(organization_id, external_id)`. Mídia só dos últimos 14 dias; mais antiga vira "mídia não disponível". Erro 2593109 = "o celular não compartilhou o histórico".
- **`smb_app_state_sync` preenche nome só quando vazio** — nunca sobrescreve nome editado.
- **`channel_sessions.status` só aceita** `STARTING | SCAN_QR_CODE | WORKING | STOPPED | FAILED` (CHECK no banco): "failed" da spec é `FAILED`.
- **Nome de provider e domínio da Meta só em `lib/channels/meta/`** (`pnpm lint:channels`; padrão em `scripts/lint-channels.pattern.ts`). Versão da Graph só por `graphVersion()` (`tests/unit/versao-da-graph-num-lugar-so.test.ts`).
- **Tripla de migration:** arquivo `supabase/migrations/<ts>_<NNNN>_<slug>.sql` (próximo NNNN por `ls supabase/migrations/ | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1`, hoje `0292` → **0293** no PR 1, **0294** no PR 2) + apêndice idempotente em `supabase/baseline.sql` **antes** do bloco `-- ---- VARREDURA anon ... (migration 0116) ----` + linha em `supabase/migrations/MANIFEST.md`.
- **Função nova em `public` revoga `public` e `anon`** (duas origens de EXECUTE). Este plano não cria função nova; recria `fn_emit_message_event` (trigger, não `security definer`), e o recreate entra antes da varredura.
- **Texto novo de tela exige espanhol** em `lib/i18n/dicionario.ts` (`tests/unit/i18n-espanhol-cobre-a-tela.test.ts`). Sem travessão (—) em texto que o usuário lê.
- **Audit em toda mutação** bem-sucedida (ação nova entra em `lib/audit/actions.ts`), sem token nem PIN no metadata.
- **`resolveMetaCreds` não cai no `.env`** quando a sessão tem token próprio e a decifra falha: lança.
- **Nenhuma segunda sessão oficial por org:** o POST novo reaproveita a linha existente (ativa ou arquivada), como hoje.
- **Fragmento em `.changes/`** com `impacto: capacidade_nova` (PR 1) e outro no PR 2.
- **E2E com `FB` simulado e Graph simulada** (servidor HTTP em loopback, no molde de `tests/e2e/instagram-responder.spec.ts`), spec listada em `SPECS_PARTE_4` de `.github/workflows/e2e.yml`.

## Review Focus

Cinco modos de falha que a spec implica e que nenhum teste de tarefa pegaria por acaso; cada um tem o teste na tarefa dona:

1. **Mensagem de histórico acorda a IA pelo gatilho do banco.** `trg_messages_emit_event` emite `message.received` em TODO insert inbound, e `ai-response-worker`, sentimento, follow-up, push e automação consomem esse evento. Sem a guarda na função do gatilho, o worker do histórico "não chama IA" e a IA acorda mesmo assim. Teste: `tests/invariants/historico-importado-nao-emite-evento.test.ts` (Task 11).
2. **Eco do celular que é, na verdade, eco de envio do CRM.** Pela Cloud API o CRM grava a linha com `external_id = wamid` da resposta de envio; o `smb_message_echoes` só cobre o que saiu do APP do celular, mas um `wamid` repetido tem de cair em `duplicate`, nunca silenciar a IA. Teste: `lib/channels/meta/ingest-echo.test.ts`, caso "wamid já gravado não silencia" (Task 7).
3. **Token de outro app passa pela troca.** `GET /oauth/access_token` devolve token para qualquer `code` válido do app, mas um `code` forjado de outro app/config retornaria um token cujo `debug_token.app_id` não é o nosso. Teste: `lib/channels/meta/cadastro-incorporado.test.ts`, caso "token de outro app é recusado" (Task 4).
4. **Segunda tentativa de sincronização depois das 24 h.** A rota `/sincronizar` tem de recusar com mensagem que manda refazer o fluxo, e nunca gravar `request_id` novo. Teste: `lib/channels/meta/coexistencia.test.ts`, `dentroDoPrazoDeSincronizacao` na borda (Task 4) + rota (Task 5).
5. **`account_reconnected` fecha o aviso certo e só ele.** Reconexão deve resolver o aviso aberto por `PARTNER_REMOVED` desta sessão (origem `empurrao`), sem fechar aviso de outra sessão e sem reabrir nada. Teste: `lib/channels/meta/saude-da-conta.test.ts` (Task 8).

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `lib/channels/meta/coexistencia.ts` (criar, Task 0) | constantes (grafia do `extras`, eventos, prazo), tipo `Coexistencia` da metadata, `lerCoexistencia`, `dentroDoPrazoDeSincronizacao`, `mensagemDoErroDaMeta`. Puro, importável pelo cliente |
| `supabase/migrations/20261001120000_0293_cadastro_incorporado.sql` (criar) | `platform_meta_app.app_id`, `es_config_id` |
| `lib/channels/meta/app.ts` (modificar) | `appDaMeta()` devolve `appId` e `esConfigId` (banco acima do `.env`) |
| `app/actions/settings/updateMetaApp.ts`, `app/admin/(protected)/meta/{page,_form}.tsx` (modificar) | os dois campos na tela da instalação |
| `app/api/v1/channels/official/route.ts` (modificar) | GET expõe `cadastroIncorporado` e `coexistencia`; POST passa a chamar `conectarCanalOficial` |
| `lib/channels/meta/conectar-canal-oficial.ts` (criar) | o caminho de gravação extraído do POST, usado pelos dois POSTs |
| `lib/channels/meta/graph-base.ts` (criar) | `baseDaGraph()` com override só em loopback (`META_GRAPH_BASE_URL`) |
| `lib/channels/meta/cadastro-incorporado.ts` (criar) | troca do `code`, `debug_token`, números da conta, `register`, `smb_app_data`, arquivar sessão legada do número |
| `lib/channels/meta/cadastro-incorporado-cliente.ts` (criar) | carrega o SDK, `FB.init`/`FB.login`, escuta `message` da Meta |
| `components/connections/CadastroIncorporado.tsx` (criar) | botão, estados, retry da sincronização, barra de progresso |
| `hooks/channels/useOfficialChannel.ts` (modificar) | tipos novos + mutations |
| `app/api/v1/channels/official/cadastro-incorporado/route.ts` (criar) | POST da troca/conexão |
| `app/api/v1/channels/official/cadastro-incorporado/sincronizar/route.ts` (criar) | POST do retry em 24 h |
| `lib/channels/meta/webhook.ts` (modificar) | eventos `echo_message`, `history_chunk`, `state_sync`, `account_event` |
| `lib/channels/meta/ingest.ts` (modificar) | `ingestMetaEcho` |
| `lib/channels/meta/saude-da-conta.ts` (criar) | `PARTNER_REMOVED`/offboarded/reconnected → sessão + Central |
| `lib/channels/health.ts` (modificar) | aviso com motivo do celular |
| `app/api/v1/webhooks/meta/[token]/route.ts` (modificar) | roteia os eventos novos |
| `lib/channels/meta/credentials.ts` (modificar) | decifra que falha lança |
| `supabase/migrations/20261006120000_0294_historico_importado_nao_emite_evento.sql` (criar, PR 2) | guarda em `fn_emit_message_event` |
| `workers/meta-history-worker.ts` + `.handler.ts` (criar, PR 2) | processa `meta.history_chunk` |
| `lib/channels/meta/contatos-do-celular.ts` (criar, PR 2) | upsert de contato do `smb_app_state_sync` |
| `docs/adr/0002-cadastro-incorporado.md`, `docs/doctrine/restricao-de-canal.md`, `docs/index.md`, `docs/architecture/cadastro-incorporado.architecture.json`, `.changes/*.md` | doutrina e registro |
| `tests/e2e/cadastro-incorporado.spec.ts`, `scripts/seed-e2e-cadastro-incorporado.ts`, `scripts/gerar-env-e2e.sh`, `.github/workflows/e2e.yml` | prova pela tela |

---

# Parte A = PR 1 (`feat/cadastro-incorporado-coexistencia`)

## Task 0: Conferir a grafia do `extras` na documentação da Meta (dono/coordenador)

**Files:**
- Create: `lib/channels/meta/coexistencia.ts`
- Test: `lib/channels/meta/coexistencia.test.ts`

**Interfaces:**
- Produces: `CHAVE_DO_TIPO_DE_RECURSO_V4: string`, `TIPO_DE_RECURSO_COEXISTENCIA`, `EVENTO_NUMERO_NOVO`, `EVENTO_COEXISTENCIA`, `PRAZO_DA_SINCRONIZACAO_MS`, `montarExtras(): Record<string, unknown>`.

> **Conferido em 01/10/2026 (coordenador, página em pt-BR, Etapa 2):** `extras: { setup: {}, "featureType": "whatsapp_business_app_onboarding", "sessionInfoVersion": "3" }`. Chave = `featureType` (camelCase); o exemplo oficial mantém `sessionInfoVersion: "3"` — incluir em `montarExtras()`.

- [x] **Step 1 (dono, no browser):** abrir `https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users`, **Step 2** ("Launch Embedded Signup"), e copiar o objeto `extras` exatamente como está no exemplo de código da v4. Anotar: a chave do tipo de recurso é `featureType` ou `feature_type`? O valor é `whatsapp_business_app_onboarding`? Há `sessionInfoVersion`?

- [ ] **Step 2:** criar `lib/channels/meta/coexistencia.ts` com o que foi lido:

```ts
/**
 * Coexistência (Embedded Signup v4, variação "WhatsApp Business app users") —
 * as constantes e as regras PURAS. Importado pelo cliente e pelo servidor:
 * nada aqui toca banco, rede ou `process.env`.
 *
 * ⚠️ `CHAVE_DO_TIPO_DE_RECURSO_V4` foi conferida na tela do passo 2 da
 * documentação de coexistência em <DATA>, por <QUEM>. O `.md` publicado omite o
 * trecho; grafia errada produz o erro 3441030 (entrou pelo fluxo normal).
 */
export const CHAVE_DO_TIPO_DE_RECURSO_V4 = "featureType"; // conferido na doc em 01/10/2026
export const TIPO_DE_RECURSO_COEXISTENCIA = "whatsapp_business_app_onboarding";

/** Eventos do `postMessage` da Meta (`type: "WA_EMBEDDED_SIGNUP"`). */
export const EVENTO_NUMERO_NOVO = "FINISH";
export const EVENTO_COEXISTENCIA = "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING";
export const EVENTO_CANCELADO = "CANCEL";

/** A Meta aceita `smb_app_data` até 24 h depois do onboarding. */
export const PRAZO_DA_SINCRONIZACAO_MS = 24 * 60 * 60 * 1000;

export function montarExtras(): Record<string, unknown> {
  return { setup: {}, [CHAVE_DO_TIPO_DE_RECURSO_V4]: TIPO_DE_RECURSO_COEXISTENCIA };
}
```

- [ ] **Step 3:** teste `lib/channels/meta/coexistencia.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { CHAVE_DO_TIPO_DE_RECURSO_V4, montarExtras, TIPO_DE_RECURSO_COEXISTENCIA } from "./coexistencia";

describe("extras da v4", () => {
  it("leva setup vazio e o tipo de recurso de coexistência sob a chave conferida", () => {
    expect(montarExtras()).toEqual({ setup: {}, [CHAVE_DO_TIPO_DE_RECURSO_V4]: TIPO_DE_RECURSO_COEXISTENCIA });
  });
  it("a chave foi conferida (não é o placeholder)", () => {
    expect(["featureType", "feature_type"]).toContain(CHAVE_DO_TIPO_DE_RECURSO_V4);
  });
});
```

- [ ] **Step 4:** `pnpm vitest run lib/channels/meta/coexistencia.test.ts` → 2 passed. `pnpm lint:channels` → sem ofensor novo.

- [ ] **Step 5:** commit:

```bash
git add lib/channels/meta/coexistencia.ts lib/channels/meta/coexistencia.test.ts
git commit -m "feat(canal-oficial): constantes do Cadastro Incorporado v4 com a grafia conferida na Meta

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 1: `platform_meta_app.app_id` / `es_config_id` (migration 0293) e `appDaMeta()`

**Files:**
- Create: `supabase/migrations/20261001120000_0293_cadastro_incorporado.sql`
- Modify: `supabase/baseline.sql` (apêndice antes de `-- ---- VARREDURA anon ... (migration 0116) ----`, hoje linha ~28676), `supabase/migrations/MANIFEST.md`, `.env.example` (linha 379, `META_APP_ID=` já existe; acrescentar `META_ES_CONFIG_ID=`)
- Modify: `lib/channels/meta/app.ts`
- Test: `tests/unit/app-da-meta-cadastro-incorporado.test.ts`, `tests/invariants/cadastro-incorporado-colunas-sem-grant.test.ts`

**Interfaces:**
- Produces: `AppDaMetaEmVigor` ganha `appId: string | null` e `esConfigId: string | null`; `VARIAVEIS_DO_CADASTRO_INCORPORADO = ["META_APP_ID", "META_ES_CONFIG_ID"] as const`.
- Consumes: `linhaDoBanco()`/`parDoBanco()` já existentes em `lib/channels/meta/app.ts`.

- [ ] **Step 1:** migration:

```sql
-- 0293 — Cadastro Incorporado (Embedded Signup v4): o App ID e o Configuration
-- ID da instalação. Nenhum dos dois é segredo (o App ID vai para o browser no
-- `FB.init`); o segredo continua em `app_secret_encrypted` (0257). Aditiva e
-- idempotente. A tabela já é server-side only (RLS sem policy, grants
-- revogados de anon/authenticated na 0257): coluna nova herda isso, e
-- `tests/invariants/cadastro-incorporado-colunas-sem-grant.test.ts` mede.
alter table public.platform_meta_app
  add column if not exists app_id text,
  add column if not exists es_config_id text;

comment on column public.platform_meta_app.app_id is
  'App ID do app da Meta desta instalação. Público (vai ao FB.init do browser). Piso de rollback: META_APP_ID.';
comment on column public.platform_meta_app.es_config_id is
  'Configuration ID da variação Embedded Signup (Facebook Login for Business › Configurations). Piso: META_ES_CONFIG_ID.';
```

- [ ] **Step 2:** apêndice no `baseline.sql`, inserido logo após `-- ---- fim: vocabulário de comentário (migration 0292) ----` e antes do bloco da varredura:

```sql
-- ---- cadastro incorporado: app_id e es_config_id (migration 0293) ----
alter table public.platform_meta_app
  add column if not exists app_id text,
  add column if not exists es_config_id text;
-- ---- fim: cadastro incorporado (migration 0293) ----
```

- [ ] **Step 3:** linha no MANIFEST (tabela Applied, depois da 0291):

```
| `20261001120000` | `0293_cadastro_incorporado` | `platform_meta_app.app_id` e `es_config_id` (texto, não secretos): o App ID e o Configuration ID do Embedded Signup v4 da instalação, cadastrados em Admin › API Oficial (Meta). Piso `META_APP_ID`/`META_ES_CONFIG_ID`. Sem os dois o botão "Conectar WhatsApp" não aparece. Aditiva, idempotente, server-side only como o resto da tabela. ADR `docs/adr/0002-cadastro-incorporado.md`. |
```

- [ ] **Step 4:** teste unit (falha antes):

```ts
// tests/unit/app-da-meta-cadastro-incorporado.test.ts
import { describe, expect, it } from "vitest";

import { appDaMetaDoAmbiente, VARIAVEIS_DO_CADASTRO_INCORPORADO } from "@/lib/channels/meta/app";

describe("app da Meta — Cadastro Incorporado", () => {
  it("lê META_APP_ID e META_ES_CONFIG_ID do ambiente, vazio é ausente", () => {
    expect(appDaMetaDoAmbiente({ META_APP_ID: " 1054112660758768 ", META_ES_CONFIG_ID: "" })).toMatchObject({
      appId: "1054112660758768",
      esConfigId: null,
    });
  });
  it("as variáveis que a tela pode nomear", () => {
    expect(VARIAVEIS_DO_CADASTRO_INCORPORADO).toEqual(["META_APP_ID", "META_ES_CONFIG_ID"]);
  });
});
```

- [ ] **Step 5:** `lib/channels/meta/app.ts`:

```ts
export interface AppDaMetaEmVigor {
  readonly appSecret: string | null;
  readonly verifyToken: string | null;
  /** Não é segredo: vai ao `FB.init` do browser. `null` = Cadastro Incorporado indisponível. */
  readonly appId: string | null;
  readonly esConfigId: string | null;
}

export const VARIAVEIS_DO_CADASTRO_INCORPORADO = ["META_APP_ID", "META_ES_CONFIG_ID"] as const;

export function appDaMetaDoAmbiente(
  source: Record<string, string | undefined> = process.env,
): AppDaMetaEmVigor {
  const appSecret = texto(source.META_APP_SECRET);
  const verifyToken = texto(source.META_WEBHOOK_VERIFY_TOKEN);
  const appId = texto(source.META_APP_ID);
  const esConfigId = texto(source.META_ES_CONFIG_ID);
  return { appSecret: appSecret || null, verifyToken: verifyToken || null, appId: appId || null, esConfigId: esConfigId || null };
}

interface LinhaDoApp {
  app_secret_encrypted: string | null;
  verify_token_encrypted: string | null;
  app_id: string | null;
  es_config_id: string | null;
}
// no select de linhaDoBanco(): "app_secret_encrypted, verify_token_encrypted, app_id, es_config_id"
// ⚠️ clone sem a 0293 devolve 42703 aqui; o `if (error)` já degrada para o `.env`.

type ParDeSegredos = Pick<AppDaMetaEmVigor, "appSecret" | "verifyToken">;
// parDoBanco passa a devolver Promise<ParDeSegredos | null> — corpo igual.

export async function appDaMeta(): Promise<AppDaMetaEmVigor> {
  const memo = globalThis.__memoDoAppDaMeta;
  if (memo && memo.expiraEm > Date.now()) return memo.valor;

  const linha = await linhaDoBanco();
  const ambiente = appDaMetaDoAmbiente();
  // O PAR de segredos é servido inteiro de uma fonte só (ver cabeçalho). Os dois
  // identificadores públicos são independentes dele e cada um cai no `.env`
  // sozinho: App ID no banco com config id só no `.env` é configuração válida.
  const par = (await parDoBanco(linha)) ?? ambiente;
  const valor: AppDaMetaEmVigor = {
    appSecret: par.appSecret,
    verifyToken: par.verifyToken,
    appId: texto(linha?.app_id) || ambiente.appId,
    esConfigId: texto(linha?.es_config_id) || ambiente.esConfigId,
  };
  globalThis.__memoDoAppDaMeta = { valor, expiraEm: Date.now() + TTL_MS };
  return valor;
}
```

- [ ] **Step 6:** invariante (mede o Supabase real: a tabela nasce concedida pelo default ACL; a 0257 revogou; coluna nova não pode reabrir nada):

```ts
// tests/invariants/cadastro-incorporado-colunas-sem-grant.test.ts
import { describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

describe("platform_meta_app.app_id / es_config_id — sem grant a anon/authenticated", () => {
  it("as colunas existem", () => {
    const r = sql(`select string_agg(column_name, ',' order by column_name)
      from information_schema.columns
      where table_schema='public' and table_name='platform_meta_app'
        and column_name in ('app_id','es_config_id');`).trim();
    expect(r).toBe("app_id,es_config_id");
  });
  it("nenhum privilégio por coluna nem por tabela para anon/authenticated", () => {
    const porColuna = sql(`select count(*) from information_schema.column_privileges
      where table_schema='public' and table_name='platform_meta_app'
        and column_name in ('app_id','es_config_id') and grantee in ('anon','authenticated');`).trim();
    const porTabela = sql(`select count(*) from information_schema.role_table_grants
      where table_schema='public' and table_name='platform_meta_app' and grantee in ('anon','authenticated');`).trim();
    expect(porColuna).toBe("0");
    expect(porTabela).toBe("0");
  });
});
```

- [ ] **Step 7:** rodar: `pnpm vitest run tests/unit/app-da-meta-cadastro-incorporado.test.ts tests/unit/app-da-meta-credencial-do-banco.test.ts tests/unit/webhook-meta-le-do-banco.test.ts` → passed (os mocks de `appDaMeta` nos testes existentes continuam válidos: `vi.mock` não é tipado contra a interface). `pnpm test:db` → a suíte inteira verde, incluindo o invariante novo (o script não aceita arquivo avulso: aplica install + update e roda `tests/invariants/**`). `pnpm typecheck`.

- [ ] **Step 8:** commit:

```bash
git add supabase/migrations/20261001120000_0293_cadastro_incorporado.sql supabase/baseline.sql supabase/migrations/MANIFEST.md .env.example lib/channels/meta/app.ts tests/unit/app-da-meta-cadastro-incorporado.test.ts tests/invariants/cadastro-incorporado-colunas-sem-grant.test.ts
git commit -m "feat(canal-oficial): platform_meta_app ganha app_id e es_config_id (0293); appDaMeta devolve os dois

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: Os dois campos na tela da instalação e o GET da aba

**Files:**
- Modify: `app/actions/settings/updateMetaApp.ts` (schema linhas 69-87, fluxo 206-290), `app/admin/(protected)/meta/page.tsx` (select linha 52-54 e props), `app/admin/(protected)/meta/_form.tsx` (card novo depois do card "Instagram", ~linha 195)
- Modify: `app/api/v1/channels/official/route.ts` (GET, linhas 163-190), `hooks/channels/useOfficialChannel.ts`
- Modify: `lib/i18n/dicionario.ts`
- Test: `tests/unit/app-da-meta-cadastro-incorporado.test.ts` (acrescentar), `tests/unit/canal-oficial-cadastro-incorporado-get.test.ts`

**Interfaces:**
- `updateMetaApp(input)` aceita `app_id?: string`, `es_config_id?: string` (texto puro, `min(1).max(60)`); exige `app_secret` já gravado como hoje (`SEM_SEGREDO`).
- GET `/api/v1/channels/official` devolve, além do que já devolve:
  ```ts
  cadastroIncorporado: { disponivel: boolean; appId: string | null; configId: string | null; versao: string; faltam: ("META_APP_ID" | "META_ES_CONFIG_ID")[]; configurarEm: string | null }
  coexistencia: Coexistencia | null   // lido de channel_sessions.metadata.coexistencia (Task 5 passa a gravar)
  ```

- [ ] **Step 1:** teste da action (acrescentar ao arquivo da Task 1, com o molde de mocks de `tests/unit/app-da-meta-save-exige-o-segredo.test.ts`):

```ts
it("grava app_id e es_config_id como texto puro e audita só os nomes dos campos", async () => {
  estado.linha = { app_secret_encrypted: "\\x1", verify_token_encrypted: "\\x2", ig_app_secret_encrypted: null };
  const r = await updateMetaApp({ app_id: "1054112660758768", es_config_id: "9876" });
  expect(r).toEqual({ ok: true });
  expect(estado.upserts[0]).toMatchObject({ id: 1, app_id: "1054112660758768", es_config_id: "9876" });
  expect(auditorias[0]?.metadata).toMatchObject({ campos: ["app_id", "es_config_id"] });
});
```

- [ ] **Step 2:** action — no `entradaSchema`:

```ts
  /** Público: vai ao `FB.init` do browser. Texto puro, nunca cifrado. */
  app_id: z.string().trim().min(1).max(60).optional(),
  es_config_id: z.string().trim().min(1).max(60).optional(),
```

No `updateMetaApp`, depois de `const igSegredoNovo`:

```ts
  const appIdNovo = parsed.data.app_id;
  const esConfigIdNovo = parsed.data.es_config_id;
  if (!segredoNovo && jaTemToken && !igAppIdNovo && !igSegredoNovo && !appIdNovo && !esConfigIdNovo) {
    return { ok: false, error: "nada_para_salvar" };
  }
  // ...
  if (appIdNovo) { valores.app_id = appIdNovo; campos.push("app_id"); }
  if (esConfigIdNovo) { valores.es_config_id = esConfigIdNovo; campos.push("es_config_id"); }
```

e no metadata do audit: `cadastro_incorporado_trocado: Boolean(appIdNovo || esConfigIdNovo)`.

- [ ] **Step 3:** `page.tsx`: acrescentar `app_id, es_config_id` ao `select` e ao tipo `linha`; passar `cadastroAppId={linha?.app_id ?? null}` e `cadastroConfigId={linha?.es_config_id ?? null}` ao formulário. `_form.tsx`: props `readonly cadastroAppId: string | null; readonly cadastroConfigId: string | null;`, estados `const [appId, setAppId] = useState(cadastroAppId ?? "")`, `const [configId, setConfigId] = useState(cadastroConfigId ?? "")`, e um card:

```tsx
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-medium">{t("Cadastro Incorporado (conectar WhatsApp pelo botão)")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("Painel da Meta › seu app › Facebook Login for Business › Configurations. Com os dois valores, a aba Conexões ganha o botão Conectar WhatsApp.")}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="meta-app-id">{t("App ID")}</Label>
          <Input id="meta-app-id" data-testid="meta-app-id" autoComplete="off" value={appId}
            onChange={(e) => setAppId(e.target.value)} placeholder={t("Número do App ID")} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="meta-es-config-id">{t("Configuration ID do Cadastro Incorporado")}</Label>
          <Input id="meta-es-config-id" data-testid="meta-es-config-id" autoComplete="off" value={configId}
            onChange={(e) => setConfigId(e.target.value)} placeholder={t("Número da configuração")} />
        </div>
        <div className="flex items-center justify-end gap-3">
          <Button data-testid="cadastro-incorporado-salvar"
            disabled={ocupado || (appId.trim() === (cadastroAppId ?? "") && configId.trim() === (cadastroConfigId ?? ""))}
            onClick={salvarCadastroIncorporado}>
            {ocupado ? t("Salvando…") : t("Salvar")}
          </Button>
        </div>
      </Card>
```

com

```tsx
  function salvarCadastroIncorporado() {
    iniciar(async () => {
      const r = await updateMetaApp({
        app_id: appId.trim() || undefined,
        es_config_id: configId.trim() || undefined,
      });
      aoGravar(r, t("Cadastro Incorporado salvo."));
    });
  }
```

- [ ] **Step 4:** GET da rota oficial. Antes do `return ok({...})`:

```ts
  const app = await appDaMeta();
  const faltam = (["META_APP_ID", "META_ES_CONFIG_ID"] as const).filter((v) =>
    v === "META_APP_ID" ? !app.appId : !app.esConfigId,
  );
  const cadastroIncorporado = {
    disponivel: faltam.length === 0,
    appId: app.appId,
    configId: app.esConfigId,
    versao: graphVersion(),
    faltam,
    configurarEm: authz.user.is_platform_admin && !authz.user.support ? "/admin/meta" : null,
  };
```

(import `graphVersion` de `@/lib/graph-version` e `lerCoexistencia` de `@/lib/channels/meta/coexistencia`). No corpo: `cadastroIncorporado,` e `coexistencia: data ? lerCoexistencia(data.metadata) : null,`. `lerCoexistencia` nasce na Task 4 (Step 2 dela); nesta task deixe `coexistencia: null` e troque na Task 5.

- [ ] **Step 5:** `hooks/channels/useOfficialChannel.ts` — em `OfficialChannelState`:

```ts
  cadastroIncorporado?: {
    disponivel: boolean;
    appId: string | null;
    configId: string | null;
    versao: string;
    faltam: ("META_APP_ID" | "META_ES_CONFIG_ID")[];
    configurarEm: string | null;
  };
  coexistencia?: Coexistencia | null;
```

(`import type { Coexistencia } from "@/lib/channels/meta/coexistencia"` — tipo entra na Task 4; até lá, `unknown`).

- [ ] **Step 6:** teste do GET `tests/unit/canal-oficial-cadastro-incorporado-get.test.ts` (molde: `tests/unit/canal-oficial-token-de-verificacao-vem-da-instalacao.test.ts`): com `appDaMeta` mockado devolvendo `appId: "1", esConfigId: null`, `GET` responde `cadastroIncorporado.disponivel === false` e `faltam === ["META_ES_CONFIG_ID"]`; com os dois, `disponivel === true`.

- [ ] **Step 7:** espanhol em `lib/i18n/dicionario.ts` para cada string nova de `_form.tsx` (`"Cadastro Incorporado (conectar WhatsApp pelo botão)"`, a frase do painel, `"App ID"`, `"Configuration ID do Cadastro Incorporado"`, `"Número da configuração"`, `"Cadastro Incorporado salvo."`).

- [ ] **Step 8:** `pnpm vitest run tests/unit/app-da-meta-cadastro-incorporado.test.ts tests/unit/canal-oficial-cadastro-incorporado-get.test.ts tests/unit/i18n-espanhol-cobre-a-tela.test.ts tests/unit/app-da-meta-tela-nao-devolve-segredo.test.tsx` → passed. `pnpm typecheck && pnpm lint`.

- [ ] **Step 9:** commit:

```bash
git add app/actions/settings/updateMetaApp.ts "app/admin/(protected)/meta/page.tsx" "app/admin/(protected)/meta/_form.tsx" app/api/v1/channels/official/route.ts hooks/channels/useOfficialChannel.ts lib/i18n/dicionario.ts tests/unit/app-da-meta-cadastro-incorporado.test.ts tests/unit/canal-oficial-cadastro-incorporado-get.test.ts
git commit -m "feat(admin): App ID e Configuration ID do Cadastro Incorporado na tela da instalação; GET da aba diz o que falta

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: Botão **Conectar WhatsApp** e o módulo cliente do SDK

**Files:**
- Create: `lib/channels/meta/cadastro-incorporado-cliente.ts`, `components/connections/CadastroIncorporado.tsx`
- Modify: `components/connections/CanalOficialClient.tsx` (inserir o componente antes do card "Conectar canal oficial", ~linha 192), `hooks/channels/useOfficialChannel.ts`, `lib/i18n/dicionario.ts`
- Test: `lib/channels/meta/cadastro-incorporado-cliente.test.ts` (ambiente `jsdom`)

**Interfaces:**
- Produces:
  ```ts
  export interface ResultadoDoCadastro { code: string; evento: string; wabaId: string | null; phoneNumberId: string | null }
  export type DesfechoDoCadastro = { ok: true; resultado: ResultadoDoCadastro } | { ok: false; motivo: "cancelado" | "sem_code" | "sdk_indisponivel" | "sem_evento" };
  export async function abrirCadastroIncorporado(input: { appId: string; configId: string; versao: string; win?: Window }): Promise<DesfechoDoCadastro>
  ```
- `useCadastroIncorporado()` — mutation `POST /api/v1/channels/official/cadastro-incorporado` com `{ code, evento, waba_id, phone_number_id }` (rota na Task 5).

- [ ] **Step 1:** teste com `FB` simulado em `window` (é o mesmo truque que o e2e usa: se `window.FB` já existe, o módulo não carrega o script):

```ts
// lib/channels/meta/cadastro-incorporado-cliente.ts.test — nome real: cadastro-incorporado-cliente.test.ts
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { EVENTO_COEXISTENCIA } from "./coexistencia";
import { abrirCadastroIncorporado } from "./cadastro-incorporado-cliente";

function fbFalso(opts: { code?: string; evento?: string; wabaId?: string }) {
  const w = window as unknown as { FB?: unknown };
  w.FB = {
    init: () => undefined,
    login: (cb: (r: { authResponse?: { code?: string } }) => void) => {
      if (opts.evento) {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: "https://www.facebook.com",
            data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: opts.evento, data: { waba_id: opts.wabaId } }),
          }),
        );
      }
      cb({ authResponse: opts.code ? { code: opts.code } : undefined });
    },
  };
}

describe("abrirCadastroIncorporado", () => {
  it("junta o code do login com o evento do postMessage", async () => {
    fbFalso({ code: "AQB", evento: EVENTO_COEXISTENCIA, wabaId: "123" });
    const r = await abrirCadastroIncorporado({ appId: "1", configId: "2", versao: "v22.0" });
    expect(r).toEqual({ ok: true, resultado: { code: "AQB", evento: EVENTO_COEXISTENCIA, wabaId: "123", phoneNumberId: null } });
  });
  it("sem code é cancelado (o usuário fechou a janela)", async () => {
    fbFalso({});
    expect(await abrirCadastroIncorporado({ appId: "1", configId: "2", versao: "v22.0" })).toEqual({ ok: false, motivo: "cancelado" });
  });
  it("mensagem de outra origem é ignorada", async () => {
    fbFalso({ code: "AQB" });
    window.dispatchEvent(new MessageEvent("message", { origin: "https://evil.example", data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: EVENTO_COEXISTENCIA, data: { waba_id: "x" } }) }));
    expect(await abrirCadastroIncorporado({ appId: "1", configId: "2", versao: "v22.0" })).toEqual({ ok: false, motivo: "sem_evento" });
  });
});
```

- [ ] **Step 2:** implementação:

```ts
/**
 * O lado do BROWSER do Cadastro Incorporado: carrega o SDK da Meta, abre o
 * fluxo e devolve `code` + evento. Nome e domínio da Meta ficam aqui porque é
 * `lib/channels/meta/` (invariante 1 da restrição de canal).
 *
 * Se `window.FB` já existe (o e2e o simula), o script não é carregado.
 */
import { EVENTO_CANCELADO, montarExtras } from "./coexistencia";

const SDK = "https://connect.facebook.net/en_US/sdk.js";
const ORIGEM_DA_META = /\.facebook\.com$/;

interface FbSdk {
  init(o: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(cb: (r: { authResponse?: { code?: string } | null }) => void, o: Record<string, unknown>): void;
}

export interface ResultadoDoCadastro { code: string; evento: string; wabaId: string | null; phoneNumberId: string | null }
export type DesfechoDoCadastro =
  | { ok: true; resultado: ResultadoDoCadastro }
  | { ok: false; motivo: "cancelado" | "sem_code" | "sdk_indisponivel" | "sem_evento" };

function carregarSdk(win: Window): Promise<FbSdk | null> {
  const w = win as unknown as { FB?: FbSdk; fbAsyncInit?: () => void };
  if (w.FB) return Promise.resolve(w.FB);
  return new Promise((resolve) => {
    w.fbAsyncInit = () => resolve(w.FB ?? null);
    const s = win.document.createElement("script");
    s.src = SDK;
    s.async = true;
    s.onerror = () => resolve(null);
    win.document.body.appendChild(s);
  });
}

export async function abrirCadastroIncorporado(input: {
  appId: string;
  configId: string;
  versao: string;
  win?: Window;
}): Promise<DesfechoDoCadastro> {
  const win = input.win ?? window;
  const fb = await carregarSdk(win);
  if (!fb) return { ok: false, motivo: "sdk_indisponivel" };
  fb.init({ appId: input.appId, autoLogAppEvents: true, xfbml: true, version: input.versao });

  let evento: { nome: string; wabaId: string | null; phoneNumberId: string | null } | null = null;
  const ouvir = (ev: MessageEvent) => {
    if (!ORIGEM_DA_META.test(new URL(ev.origin).hostname)) return;
    try {
      const d = JSON.parse(String(ev.data)) as { type?: string; event?: string; data?: { waba_id?: string; phone_number_id?: string } };
      if (d.type !== "WA_EMBEDDED_SIGNUP" || !d.event) return;
      evento = { nome: d.event, wabaId: d.data?.waba_id ?? null, phoneNumberId: d.data?.phone_number_id ?? null };
    } catch {
      /* mensagem que não é nossa */
    }
  };
  win.addEventListener("message", ouvir);

  const code = await new Promise<string | null>((resolve) =>
    fb.login((r) => resolve(r.authResponse?.code ?? null), {
      config_id: input.configId,
      response_type: "code",
      override_default_response_type: true,
      extras: montarExtras(),
    }),
  );
  win.removeEventListener("message", ouvir);

  if (!code) return { ok: false, motivo: evento?.nome === EVENTO_CANCELADO ? "cancelado" : "cancelado" };
  if (!evento) return { ok: false, motivo: "sem_evento" };
  const e = evento as { nome: string; wabaId: string | null; phoneNumberId: string | null };
  return { ok: true, resultado: { code, evento: e.nome, wabaId: e.wabaId, phoneNumberId: e.phoneNumberId } };
}
```

- [ ] **Step 3:** hook em `useOfficialChannel.ts`:

```ts
export interface CadastroIncorporadoInput { code: string; evento: string; waba_id: string | null; phone_number_id: string | null }

export function useCadastroIncorporado() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CadastroIncorporadoInput) =>
      apiClient.post<{ data: { connected: boolean; displayName: string; phoneNumber: string | null; coexistencia: boolean; webhook?: { assinado: boolean; motivo?: string } } }>(
        "/api/v1/channels/official/cadastro-incorporado",
        input,
      ),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["official-channel"] }),
  });
}
```

- [ ] **Step 4:** componente `components/connections/CadastroIncorporado.tsx`:

```tsx
"use client";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { useCadastroIncorporado, type OfficialChannelState } from "@/hooks/channels/useOfficialChannel";
import { abrirCadastroIncorporado } from "@/lib/channels/meta/cadastro-incorporado-cliente";

export function CadastroIncorporado({ estado }: { estado: OfficialChannelState }) {
  const t = useT();
  const concluir = useCadastroIncorporado();
  const [abrindo, setAbrindo] = useState(false);
  const cfg = estado.cadastroIncorporado;
  if (!cfg) return null;

  if (!cfg.disponivel) {
    return (
      <Card className="p-4" data-testid="cadastro-incorporado-indisponivel">
        <h2 className="font-medium">{t("Conectar WhatsApp pelo botão")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Falta configurar na instalação:")} <span className="font-mono">{cfg.faltam.join(", ")}</span>.{" "}
          {t("Enquanto isso, use o formulário abaixo.")}
        </p>
        {cfg.configurarEm ? (
          <Link href={cfg.configurarEm} className="text-sm font-medium underline underline-offset-2">
            {t("Abrir API Oficial (Meta) na administração")}
          </Link>
        ) : null}
      </Card>
    );
  }

  async function conectar() {
    setAbrindo(true);
    try {
      const r = await abrirCadastroIncorporado({ appId: cfg!.appId!, configId: cfg!.configId!, versao: cfg!.versao });
      if (!r.ok) {
        if (r.motivo !== "cancelado") toast.error(t("Não deu para concluir o fluxo da Meta. Tente de novo."));
        return;
      }
      const resp = await concluir.mutateAsync({
        code: r.resultado.code,
        evento: r.resultado.evento,
        waba_id: r.resultado.wabaId,
        phone_number_id: r.resultado.phoneNumberId,
      });
      toast.success(`${t("Conectado:")} ${resp.data.displayName} ${resp.data.phoneNumber ?? ""}`.trim());
      if (resp.data.webhook?.assinado === false) {
        toast.warning(t("Conectado, mas a Meta não aceitou o endereço de recebimento. As mensagens não vão chegar."), {
          description: resp.data.webhook.motivo,
          duration: Infinity,
        });
      }
    } finally {
      setAbrindo(false);
    }
  }

  return (
    <Card className="p-4" data-testid="cadastro-incorporado">
      <h2 className="font-medium">{estado.connected ? t("Reconectar pelo botão") : t("Conectar WhatsApp")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("Abre a janela da Meta. Para manter o número no WhatsApp Business do celular, escolha essa opção lá dentro.")}
      </p>
      <Button className="mt-3" onClick={conectar} disabled={abrindo || concluir.isPending} data-testid="btn-conectar-whatsapp">
        {abrindo || concluir.isPending ? t("Aguardando a Meta…") : t("Conectar WhatsApp")}
      </Button>
    </Card>
  );
}
```

Em `CanalOficialClient.tsx`, logo antes do `<Card className="p-4">` do formulário: `{estado ? <CadastroIncorporado estado={estado} /> : null}`.

- [ ] **Step 5:** espanhol para todas as strings novas. `pnpm vitest run lib/channels/meta/cadastro-incorporado-cliente.test.ts tests/unit/i18n-espanhol-cobre-a-tela.test.ts` → passed. `pnpm lint:channels` → `components/connections/CadastroIncorporado.tsx` sem nome de provider (o componente só diz "Meta"/"WhatsApp", que o padrão não proíbe). `pnpm typecheck`.

- [ ] **Step 6:** commit:

```bash
git add lib/channels/meta/cadastro-incorporado-cliente.ts lib/channels/meta/cadastro-incorporado-cliente.test.ts components/connections/CadastroIncorporado.tsx components/connections/CanalOficialClient.tsx hooks/channels/useOfficialChannel.ts lib/i18n/dicionario.ts
git commit -m "feat(conexoes): botão Conectar WhatsApp abre o Cadastro Incorporado v4 e manda o code ao servidor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: `baseDaGraph()` e o módulo servidor do Cadastro Incorporado

**Files:**
- Create: `lib/channels/meta/graph-base.ts`, `lib/channels/meta/cadastro-incorporado.ts`
- Modify: `lib/channels/meta/validate-credentials.ts` (linhas 26, 73), `lib/channels/meta/assinar-webhook.ts` (linha 37), `lib/channels/meta/coexistencia.ts` (tipo e regras puras), `.env.example` (ao lado de `META_GRAPH_VERSION`: `META_GRAPH_BASE_URL=` com comentário "só loopback em produção")
- Test: `lib/channels/meta/graph-base.test.ts`, `lib/channels/meta/cadastro-incorporado.test.ts`, `lib/channels/meta/coexistencia.test.ts` (acrescentar)

**Interfaces:**
- `baseDaGraph(env = process.env): string` — `https://graph.facebook.com` por padrão; honra `META_GRAPH_BASE_URL`; em produção só loopback (cópia declarada de `baseDoInstagram`, `lib/channels/instagram/graph.ts`).
- `coexistencia.ts`:
  ```ts
  export interface Coexistencia {
    onboarding_em: string;
    pedidos: { contatos: { request_id: string } | { erro: string } | null; historico: { request_id: string } | { erro: string } | null };
    historico: { fase: number | null; progresso: number | null; concluido: boolean; erro: string | null } | null;
  }
  export function lerCoexistencia(metadata: unknown): Coexistencia | null
  export function dentroDoPrazoDeSincronizacao(onboardingEm: string, agora?: Date): boolean
  export function mensagemDoErroDaMeta(codigo: number | null, subcodigo: number | null, padrao: string): string
  ```
- `cadastro-incorporado.ts`:
  ```ts
  export class ErroDaMeta extends Error { readonly codigo: number | null; readonly subcodigo: number | null }
  export async function trocarCodigo(app: { appId: string; appSecret: string }, code: string): Promise<string>
  export async function conferirToken(app: { appId: string; appSecret: string }, token: string): Promise<{ ok: true } | { ok: false; motivo: string }>
  export interface NumeroDaConta { id: string; displayPhoneNumber: string | null; isOnBizApp: boolean }
  export async function numerosDaConta(token: string, wabaId: string): Promise<NumeroDaConta[]>
  export function escolherNumero(numeros: NumeroDaConta[], input: { phoneNumberId: string | null; coexistencia: boolean }): { ok: true; numero: NumeroDaConta } | { ok: false; motivo: string }
  export function gerarPin(): string
  export async function registrarNumero(token: string, phoneNumberId: string, pin: string): Promise<void>
  export async function pedirSincronizacao(token: string, phoneNumberId: string, tipo: "smb_app_state_sync" | "history"): Promise<{ request_id: string } | { erro: string }>
  export async function arquivarSessaoLegadaDoNumero(admin: SupabaseClient, organizationId: string, phoneNumber: string, excetoSessionId: string): Promise<string | null>
  ```

- [ ] **Step 1:** `graph-base.ts` + teste (3 casos: default, override em dev, override não-loopback ignorado em produção) — corpo igual a `baseDoInstagram` trocando a variável para `META_GRAPH_BASE_URL` e a constante para `BASE_DA_GRAPH = "https://graph.facebook.com"`. Trocar as três URLs existentes por `` `${baseDaGraph()}/${graphVersion()}/…` ``. Rodar `pnpm vitest run lib/channels/meta/validate-credentials.test.ts lib/channels/meta/assinar-webhook.test.ts tests/unit/versao-da-graph-num-lugar-so.test.ts` → passed.

- [ ] **Step 2:** regras puras em `coexistencia.ts` (teste primeiro, no arquivo da Task 0):

```ts
describe("prazo de sincronização", () => {
  const t0 = "2026-10-10T12:00:00.000Z";
  it("23h59 depois ainda vale; 24h depois não", () => {
    expect(dentroDoPrazoDeSincronizacao(t0, new Date("2026-10-11T11:59:59.000Z"))).toBe(true);
    expect(dentroDoPrazoDeSincronizacao(t0, new Date("2026-10-11T12:00:00.000Z"))).toBe(false);
  });
});
describe("erros conhecidos da Meta", () => {
  it("3441041 explica o número preso em outra WABA", () => {
    expect(mensagemDoErroDaMeta(3441041, null, "x")).toMatch(/outra conta do WhatsApp Business/);
  });
  it("o subcódigo também é consultado", () => {
    expect(mensagemDoErroDaMeta(100, 2655093, "x")).toMatch(/15 minutos/);
  });
  it("desconhecido devolve o padrão", () => {
    expect(mensagemDoErroDaMeta(999, null, "padrão")).toBe("padrão");
  });
});
describe("lerCoexistencia", () => {
  it("devolve null sem a chave e o objeto quando há onboarding_em", () => {
    expect(lerCoexistencia({ ai_gate: "allowlist" })).toBeNull();
    expect(lerCoexistencia({ coexistencia: { onboarding_em: "2026-10-10T12:00:00.000Z", pedidos: { contatos: null, historico: null }, historico: null } })?.onboarding_em).toBe("2026-10-10T12:00:00.000Z");
  });
});
```

Implementação:

```ts
export interface Coexistencia { /* como na interface acima */ }

export function lerCoexistencia(metadata: unknown): Coexistencia | null {
  const c = (metadata as { coexistencia?: unknown } | null)?.coexistencia as Partial<Coexistencia> | undefined;
  if (!c || typeof c.onboarding_em !== "string") return null;
  return {
    onboarding_em: c.onboarding_em,
    pedidos: { contatos: c.pedidos?.contatos ?? null, historico: c.pedidos?.historico ?? null },
    historico: c.historico ?? null,
  };
}

export function dentroDoPrazoDeSincronizacao(onboardingEm: string, agora: Date = new Date()): boolean {
  const inicio = new Date(onboardingEm).getTime();
  return Number.isFinite(inicio) && agora.getTime() - inicio < PRAZO_DA_SINCRONIZACAO_MS;
}

/**
 * Códigos da página `embedded-signup/errors` (01/10/2026). A Meta entrega o
 * código ora em `error.code`, ora em `error.error_subcode`: consultamos os dois.
 */
const MENSAGENS_POR_CODIGO: Record<number, string> = {
  3441030: "A Meta tratou o cadastro como número novo, não como coexistência. Confira a configuração do Cadastro Incorporado na instalação e tente de novo.",
  3441041: "Este número já está em outra conta do WhatsApp Business (WABA). Remova-o de lá no Gerenciador de Negócios e tente de novo.",
  3441042: "A Meta não conseguiu verificar este número no aplicativo do celular. Abra o WhatsApp Business no celular, confira a conexão e tente de novo.",
  3441045: "O WhatsApp Business do celular precisa estar atualizado para a coexistência. Atualize o aplicativo e tente de novo.",
  2655093: "Este número está ligado a outro parceiro. Desconecte-o no aplicativo (Configurações › Ferramentas comerciais) e espere 15 minutos antes de tentar de novo.",
  3441049: "Este número está ligado a outro parceiro. Desconecte-o no aplicativo (Configurações › Ferramentas comerciais) e espere 15 minutos antes de tentar de novo.",
  2655094: "Este número está ligado a outro parceiro. Desconecte-o no aplicativo (Configurações › Ferramentas comerciais) e espere 15 minutos antes de tentar de novo.",
  4563015: "O aplicativo do WhatsApp Business no celular está desatualizado. Atualize-o e tente de novo.",
  2593109: "O celular não compartilhou o histórico. A conexão continua; o histórico pode ser pedido de novo em até 24 horas.",
};

export function mensagemDoErroDaMeta(codigo: number | null, subcodigo: number | null, padrao: string): string {
  return (subcodigo !== null && MENSAGENS_POR_CODIGO[subcodigo]) || (codigo !== null && MENSAGENS_POR_CODIGO[codigo]) || padrao;
}
```

- [ ] **Step 3:** teste do módulo servidor com `fetch` substituído (`vi.stubGlobal`):

```ts
// lib/channels/meta/cadastro-incorporado.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { conferirToken, escolherNumero, ErroDaMeta, gerarPin, pedirSincronizacao, trocarCodigo } from "./cadastro-incorporado";

const APP = { appId: "1054112660758768", appSecret: "s".repeat(32) };
const chamadas: Array<{ url: string; init?: RequestInit }> = [];
function graphFalsa(respostas: Record<string, { status?: number; body: unknown }>) {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    chamadas.push({ url, init });
    const chave = Object.keys(respostas).find((k) => url.includes(k));
    const r = chave ? respostas[chave]! : { status: 404, body: { error: { message: "não simulado" } } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  });
}
afterEach(() => { vi.unstubAllGlobals(); chamadas.length = 0; });

describe("trocarCodigo", () => {
  it("troca o code pelo token do system user do cliente", async () => {
    graphFalsa({ "/oauth/access_token": { body: { access_token: "EAAX" } } });
    expect(await trocarCodigo(APP, "AQB")).toBe("EAAX");
    expect(chamadas[0]!.url).toContain(`client_id=${APP.appId}`);
    expect(chamadas[0]!.url).toContain("code=AQB");
  });
  it("code vencido vira ErroDaMeta com o código da Meta", async () => {
    graphFalsa({ "/oauth/access_token": { status: 400, body: { error: { message: "expired", code: 100, error_subcode: 36007 } } } });
    await expect(trocarCodigo(APP, "velho")).rejects.toMatchObject({ codigo: 100, subcodigo: 36007 });
  });
});

describe("conferirToken", () => {
  it("token de outro app é recusado", async () => {
    graphFalsa({ "/debug_token": { body: { data: { app_id: "999", is_valid: true, scopes: ["whatsapp_business_management", "whatsapp_business_messaging"] } } } });
    expect(await conferirToken(APP, "t")).toMatchObject({ ok: false });
  });
  it("sem o escopo de mensagens é recusado", async () => {
    graphFalsa({ "/debug_token": { body: { data: { app_id: APP.appId, is_valid: true, scopes: ["whatsapp_business_management"] } } } });
    expect(await conferirToken(APP, "t")).toMatchObject({ ok: false });
  });
  it("app certo, válido e com os dois escopos passa", async () => {
    graphFalsa({ "/debug_token": { body: { data: { app_id: APP.appId, is_valid: true, scopes: ["whatsapp_business_management", "whatsapp_business_messaging"] } } } });
    expect(await conferirToken(APP, "t")).toEqual({ ok: true });
    expect(chamadas[0]!.url).toContain(`access_token=${APP.appId}%7C`);
  });
});

describe("escolherNumero", () => {
  const n = (id: string, biz: boolean) => ({ id, displayPhoneNumber: "+55 27 99904-9879", isOnBizApp: biz });
  it("coexistência exige is_on_biz_app", () => {
    expect(escolherNumero([n("1", false)], { phoneNumberId: null, coexistencia: true })).toMatchObject({ ok: false });
    expect(escolherNumero([n("1", true)], { phoneNumberId: null, coexistencia: true })).toEqual({ ok: true, numero: n("1", true) });
  });
  it("com phone_number_id informado, tem de estar na conta", () => {
    expect(escolherNumero([n("1", true)], { phoneNumberId: "2", coexistencia: true })).toMatchObject({ ok: false });
  });
  it("número novo sem id e com um só número na conta usa esse", () => {
    expect(escolherNumero([n("7", false)], { phoneNumberId: null, coexistencia: false })).toEqual({ ok: true, numero: n("7", false) });
  });
});

describe("pedirSincronizacao", () => {
  it("manda sync_type e devolve o request_id", async () => {
    graphFalsa({ "/smb_app_data": { body: { request_id: "req-1" } } });
    expect(await pedirSincronizacao("t", "111", "history")).toEqual({ request_id: "req-1" });
    expect(String(chamadas[0]!.init?.body)).toContain("sync_type=history");
  });
  it("erro da Meta vira texto, nunca throw (a conexão já está gravada)", async () => {
    graphFalsa({ "/smb_app_data": { status: 400, body: { error: { message: "x", code: 100, error_subcode: 2593109 } } } });
    expect(await pedirSincronizacao("t", "111", "history")).toMatchObject({ erro: expect.stringMatching(/não compartilhou/) });
  });
});

it("gerarPin tem 6 dígitos", () => {
  expect(gerarPin()).toMatch(/^\d{6}$/);
});

it("ErroDaMeta carrega a mensagem em português quando o código é conhecido", () => {
  expect(new ErroDaMeta(100, 3441041, "raw").message).toMatch(/outra conta/);
});
```

- [ ] **Step 4:** implementação:

```ts
/**
 * O lado do SERVIDOR do Cadastro Incorporado v4: troca do `code` (30 s), conferência
 * do token, resolução do número, `register` (só número novo), `smb_app_data`
 * (só coexistência) e o arquivamento da sessão legada do mesmo número.
 *
 * Tudo que fala com a Graph vive aqui, por `baseDaGraph()` + `graphVersion()`.
 * Nada aqui grava a sessão: quem grava é `conectarCanalOficial` (o mesmo caminho
 * do formulário manual).
 */
import { randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { graphVersion } from "@/lib/graph-version";
import { logger } from "@/lib/logger";
import { getWahaClient } from "@/lib/waha/client";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { CHANNEL_PROVIDER_WAHA } from "../capabilities";
import { mensagemDoErroDaMeta } from "./coexistencia";
import { baseDaGraph } from "./graph-base";

const ESCOPOS_EXIGIDOS = ["whatsapp_business_management", "whatsapp_business_messaging"] as const;

interface ErroGraph { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } }

export class ErroDaMeta extends Error {
  readonly codigo: number | null;
  readonly subcodigo: number | null;
  constructor(codigo: number | null, subcodigo: number | null, cru: string) {
    super(mensagemDoErroDaMeta(codigo, subcodigo, cru));
    this.codigo = codigo;
    this.subcodigo = subcodigo;
  }
}

async function graph<T>(caminho: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...resto } = init;
  const res = await fetch(`${baseDaGraph()}/${graphVersion()}${caminho}`, {
    ...resto,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(resto.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: ErroGraph };
  if (!res.ok || body.error) {
    const e = body.error ?? {};
    throw new ErroDaMeta(e.code ?? null, e.error_subcode ?? null, e.error_data?.details ?? e.message ?? `http_${res.status}`);
  }
  return body;
}

export async function trocarCodigo(app: { appId: string; appSecret: string }, code: string): Promise<string> {
  const q = new URLSearchParams({ client_id: app.appId, client_secret: app.appSecret, code });
  const r = await graph<{ access_token?: string }>(`/oauth/access_token?${q}`);
  if (!r.access_token) throw new ErroDaMeta(null, null, "troca_sem_token");
  return r.access_token;
}

export async function conferirToken(app: { appId: string; appSecret: string }, token: string): Promise<{ ok: true } | { ok: false; motivo: string }> {
  const q = new URLSearchParams({ input_token: token, access_token: `${app.appId}|${app.appSecret}` });
  try {
    const r = await graph<{ data?: { app_id?: string; is_valid?: boolean; scopes?: string[] } }>(`/debug_token?${q}`);
    const d = r.data ?? {};
    if (d.app_id !== app.appId) return { ok: false, motivo: "o token devolvido não é do app desta instalação" };
    if (!d.is_valid) return { ok: false, motivo: "a Meta devolveu um token inválido" };
    const faltam = ESCOPOS_EXIGIDOS.filter((s) => !(d.scopes ?? []).includes(s));
    if (faltam.length) return { ok: false, motivo: `o token não tem as permissões ${faltam.join(", ")}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, motivo: err instanceof Error ? err.message : "debug_token falhou" };
  }
}

export interface NumeroDaConta { id: string; displayPhoneNumber: string | null; isOnBizApp: boolean }

export async function numerosDaConta(token: string, wabaId: string): Promise<NumeroDaConta[]> {
  // ponytail: uma página de até 100 números, como `conferirNumeroDaConta`.
  const r = await graph<{ data?: Array<{ id?: string; display_phone_number?: string; is_on_biz_app?: boolean }> }>(
    `/${wabaId}/phone_numbers?fields=id,display_phone_number,is_on_biz_app&limit=100`,
    { token },
  );
  return (r.data ?? []).filter((n): n is { id: string } & typeof n => typeof n.id === "string").map((n) => ({
    id: n.id,
    displayPhoneNumber: n.display_phone_number ?? null,
    isOnBizApp: n.is_on_biz_app === true,
  }));
}

export function escolherNumero(
  numeros: NumeroDaConta[],
  input: { phoneNumberId: string | null; coexistencia: boolean },
): { ok: true; numero: NumeroDaConta } | { ok: false; motivo: string } {
  const candidatos = input.phoneNumberId ? numeros.filter((n) => n.id === input.phoneNumberId) : numeros;
  if (candidatos.length === 0) return { ok: false, motivo: "a Meta não devolveu o número desta conta. Refaça o fluxo." };
  if (input.coexistencia) {
    const noApp = candidatos.find((n) => n.isOnBizApp);
    if (!noApp) return { ok: false, motivo: "o número não está marcado como coexistência (is_on_biz_app). Refaça o fluxo escolhendo manter o número no celular." };
    return { ok: true, numero: noApp };
  }
  if (candidatos.length > 1) return { ok: false, motivo: "a conta tem mais de um número e a Meta não disse qual foi cadastrado. Use o formulário manual." };
  return { ok: true, numero: candidatos[0]! };
}

/** PIN de verificação em duas etapas do número novo. CSPRNG, 6 dígitos. */
export function gerarPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export async function registrarNumero(token: string, phoneNumberId: string, pin: string): Promise<void> {
  await graph(`/${phoneNumberId}/register`, {
    method: "POST",
    token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", pin }),
  });
}

export async function pedirSincronizacao(
  token: string,
  phoneNumberId: string,
  tipo: "smb_app_state_sync" | "history",
): Promise<{ request_id: string } | { erro: string }> {
  try {
    const r = await graph<{ request_id?: string }>(`/${phoneNumberId}/smb_app_data`, {
      method: "POST",
      token,
      body: new URLSearchParams({ messaging_product: "whatsapp", sync_type: tipo }),
    });
    return r.request_id ? { request_id: r.request_id } : { erro: "a Meta aceitou sem devolver request_id" };
  } catch (err) {
    return { erro: err instanceof Error ? err.message : "smb_app_data falhou" };
  }
}

/**
 * A Meta desconecta todos os aparelhos vinculados no onboarding: a sessão WAHA
 * deste mesmo número já caiu. Arquiva (não apaga: conversas ficam) e tenta
 * limpar a sessão no WAHA, sem falhar a conexão se o WAHA não responder.
 * Devolve o id arquivado, ou `null` se não havia.
 */
export async function arquivarSessaoLegadaDoNumero(
  admin: SupabaseClient,
  organizationId: string,
  phoneNumber: string,
  excetoSessionId: string,
): Promise<string | null> {
  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, waha_session_name")
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_WAHA)
      .eq("phone_number", phoneNumber)
      .neq("id", excetoSessionId);
  const { data } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  const legada = data as { id: string; waha_session_name: string | null } | null;
  if (!legada) return null;

  const now = new Date().toISOString();
  await admin
    .from("channel_sessions")
    .update({ archived_at: now, status: "STOPPED", last_status_change_at: now, status_reason: "substituida_pela_coexistencia" })
    .eq("organization_id", organizationId)
    .eq("id", legada.id);

  const waha = getWahaClient();
  if (waha && legada.waha_session_name) {
    try {
      await waha.logoutSession(legada.waha_session_name);
      await waha.deleteSession(legada.waha_session_name);
    } catch (err) {
      logger.warn("[cadastro-incorporado] sessão legada arquivada no banco, mas o WAHA não limpou", {
        organization_id: organizationId,
        session: legada.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return legada.id;
}
```

- [ ] **Step 5:** `pnpm vitest run lib/channels/meta/cadastro-incorporado.test.ts lib/channels/meta/coexistencia.test.ts lib/channels/meta/graph-base.test.ts` → passed. `pnpm lint:channels`, `pnpm typecheck`.

- [ ] **Step 6:** commit:

```bash
git add lib/channels/meta/graph-base.ts lib/channels/meta/graph-base.test.ts lib/channels/meta/cadastro-incorporado.ts lib/channels/meta/cadastro-incorporado.test.ts lib/channels/meta/coexistencia.ts lib/channels/meta/coexistencia.test.ts lib/channels/meta/validate-credentials.ts lib/channels/meta/assinar-webhook.ts .env.example
git commit -m "feat(canal-oficial): troca do code, debug_token, número da conta, register x coexistência, smb_app_data; Graph com base configurável em loopback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: `conectarCanalOficial` extraído, rota do Cadastro Incorporado e rota `/sincronizar`

**Files:**
- Create: `lib/channels/meta/conectar-canal-oficial.ts`
- Modify: `app/api/v1/channels/official/route.ts` (POST: linhas 212-380 viram uma chamada; `publicBase`/`callbackDaSessao`/`traduzirMotivo`/`assinaturaGravada` ficam na rota porque o GET os usa; a nova função recebe `callbackBase`)
- Create: `app/api/v1/channels/official/cadastro-incorporado/route.ts`, `app/api/v1/channels/official/cadastro-incorporado/sincronizar/route.ts`
- Modify: `lib/audit/actions.ts` (perto de `"channel.connected"`, linha 212): `"channel.official_connected_es"`, `"channel.official_sync_requested"`
- Modify: `components/connections/CadastroIncorporado.tsx` (retry), `hooks/channels/useOfficialChannel.ts` (`useSincronizarCoexistencia`), `lib/i18n/dicionario.ts`
- Test: `tests/unit/canal-oficial-assina-webhook-da-conta.test.ts` (existente, continua verde), `tests/unit/canal-oficial-cadastro-incorporado-post.test.ts`, `tests/unit/canal-oficial-sincronizar-coexistencia.test.ts`

**Interfaces:**
- ```ts
  export interface ConexaoOficialInput { organizationId: string; userId: string; requestId: string; phoneNumberId: string; wabaId: string; token: string; callbackBase: string; metadataExtra?: Record<string, unknown> }
  export type ConexaoOficialResultado =
    | { ok: true; sessionId: string; displayName: string; phoneNumber: string | null; webhook: { assinado: true } | { assinado: false; motivo: string } }
    | { ok: false; status: 422 | 500; codigo: "invalid_request" | "internal_error"; motivo: string };
  export async function conectarCanalOficial(admin: SupabaseClient, input: ConexaoOficialInput): Promise<ConexaoOficialResultado>
  ```
  `motivo` volta SEM traduzir; a rota aplica `traduzirMotivo`. `metadataExtra` é mesclado na metadata junto de `webhook_da_conta` (é onde `coexistencia` entra).
- POST `/api/v1/channels/official/cadastro-incorporado` — body `{ code: string; evento: string; waba_id: string | null; phone_number_id: string | null }`; guardas `requireSupportWrite()` + `requireRole("admin")`; resposta `{ connected: true, displayName, phoneNumber, coexistencia: boolean, webhook }`.
- POST `/api/v1/channels/official/cadastro-incorporado/sincronizar` — sem body; só os pedidos que ainda não têm `request_id`; 422 fora das 24 h.

- [ ] **Step 1 (refactor, sem mudar comportamento):** mover o miolo do POST (da validação até o `metadata.webhook_da_conta`) para `conectarCanalOficial`, trocando `callbackDaSessao(req, token)` por `` `${input.callbackBase}/api/v1/webhooks/meta/${token}` `` e `t(...)` pelos textos crus (a rota traduz). A rota vira:

```ts
  const r = await conectarCanalOficial(createAdminClient(), {
    organizationId: orgId, userId, requestId, phoneNumberId: phone_number_id, wabaId: waba_id, token, callbackBase: publicBase(req),
  });
  if (!r.ok) return fail(r.codigo, traduzirMotivo(r.motivo, t), r.status, { requestId });
  return ok({
    connected: true, displayName: r.displayName, phoneNumber: r.phoneNumber,
    webhook: r.webhook.assinado ? { assinado: true } : { assinado: false, motivo: traduzirMotivo(r.webhook.motivo, t) },
  });
```

Rodar `pnpm vitest run tests/unit/canal-oficial-assina-webhook-da-conta.test.ts tests/unit/canal-oficial-aviso-de-recebimento.test.tsx` → passed (os `vi.mock` são por caminho de módulo e continuam valendo dentro do módulo novo).

- [ ] **Step 2:** teste da rota nova (mocks no molde do teste existente; `cadastro-incorporado` mockado por função):

```ts
// tests/unit/canal-oficial-cadastro-incorporado-post.test.ts
vi.mock("@/lib/channels/meta/cadastro-incorporado", () => ({
  trocarCodigo: async () => "EAAX",
  conferirToken: async () => ({ ok: true }),
  numerosDaConta: async () => [{ id: "111", displayPhoneNumber: "+55 27 99904-9879", isOnBizApp: true }],
  escolherNumero: (ns: unknown[], i: { coexistencia: boolean }) => (i.coexistencia ? { ok: true, numero: (ns as { id: string }[])[0] } : { ok: true, numero: (ns as { id: string }[])[0] }),
  registrarNumero: (...a: unknown[]) => registrar(...a),
  gerarPin: () => "123456",
  pedirSincronizacao: (...a: unknown[]) => sincronizar(...a),
  arquivarSessaoLegadaDoNumero: async () => "sessao-waha-antiga",
  ErroDaMeta: class extends Error { codigo = null; subcodigo = null },
}));
vi.mock("@/lib/channels/meta/conectar-canal-oficial", () => ({
  conectarCanalOficial: (...a: unknown[]) => conectar(...a),
}));

it("coexistência: não registra, pede contatos e histórico, grava metadata.coexistencia e audita sem token", async () => {
  conectar.mockResolvedValue({ ok: true, sessionId: CANAL, displayName: "Clínica", phoneNumber: "+5527999049879", webhook: { assinado: true } });
  sincronizar.mockResolvedValueOnce({ request_id: "c-1" }).mockResolvedValueOnce({ request_id: "h-1" });
  const res = await POST(req({ code: "AQB", evento: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", waba_id: "222", phone_number_id: null }));
  expect(res.status).toBe(200);
  expect(registrar).not.toHaveBeenCalled();
  expect(sincronizar.mock.calls.map((c) => c[2])).toEqual(["smb_app_state_sync", "history"]);
  expect(db.updates.at(-1)?.patch.metadata).toMatchObject({ coexistencia: { pedidos: { contatos: { request_id: "c-1" }, historico: { request_id: "h-1" } } } });
  expect(JSON.stringify(auditorias)).not.toContain("EAAX");
  expect(auditorias[0]).toMatchObject({ action: "channel.official_connected_es", metadata: { coexistencia: true, sessao_legada_arquivada: "sessao-waha-antiga" } });
});

it("número novo (FINISH): registra com PIN e não pede sincronização", async () => { /* registrar chamado 1x com pin "123456"; sincronizar 0x; metadata sem coexistencia */ });

it("falha no smb_app_data não desfaz a conexão: 200 com o erro gravado em pedidos.historico", async () => { /* sincronizar 2ª chamada { erro: "x" } → status 200, metadata.coexistencia.pedidos.historico.erro === "x" */ });

it("token de outro app → 422 sem gravar nada", async () => { /* conferirToken mock { ok:false } via vi.mocked → conectar não chamado */ });

it("code vencido → 422 com a mensagem da Meta", async () => { /* trocarCodigo rejeita ErroDaMeta → 422 */ });
```

- [ ] **Step 3:** rota:

```ts
// app/api/v1/channels/official/cadastro-incorporado/route.ts
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { appDaMeta } from "@/lib/channels/meta/app";
import {
  arquivarSessaoLegadaDoNumero, conferirToken, ErroDaMeta, escolherNumero, gerarPin, numerosDaConta,
  pedirSincronizacao, registrarNumero, trocarCodigo,
} from "@/lib/channels/meta/cadastro-incorporado";
import { EVENTO_COEXISTENCIA, EVENTO_NUMERO_NOVO, type Coexistencia } from "@/lib/channels/meta/coexistencia";
import { conectarCanalOficial } from "@/lib/channels/meta/conectar-canal-oficial";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

import { publicBase, traduzirMotivo } from "../route-helpers"; // extrair de ../route.ts neste passo (publicBase, traduzirMotivo)

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  code: z.string().min(10).max(2000),
  evento: z.string().min(1).max(80),
  waba_id: z.string().min(5).max(40).nullable(),
  phone_number_id: z.string().min(5).max(40).nullable(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("invalid_request", t("code, evento e waba_id são obrigatórios"), 422, { requestId });
  const { code, evento, waba_id, phone_number_id } = parsed.data;
  const coexistencia = evento === EVENTO_COEXISTENCIA;
  if (!coexistencia && evento !== EVENTO_NUMERO_NOVO) {
    return fail("invalid_request", t("o fluxo da Meta não terminou. Tente de novo."), 422, { requestId });
  }
  if (!waba_id) return fail("invalid_request", t("a Meta não devolveu a conta do WhatsApp Business. Tente de novo."), 422, { requestId });

  const app = await appDaMeta();
  if (!app.appId || !app.appSecret) {
    return fail("invalid_request", t("o Cadastro Incorporado não está configurado nesta instalação"), 422, { requestId });
  }

  // 1. troca (30 s) + conferência
  let token: string;
  try {
    token = await trocarCodigo({ appId: app.appId, appSecret: app.appSecret }, code);
  } catch (err) {
    const msg = err instanceof ErroDaMeta ? err.message : t("a troca do código com a Meta falhou. Tente de novo.");
    return fail("invalid_request", msg, 422, { requestId });
  }
  const conferido = await conferirToken({ appId: app.appId, appSecret: app.appSecret }, token);
  if (!conferido.ok) return fail("invalid_request", conferido.motivo, 422, { requestId });

  // 2. número
  let numeros;
  try { numeros = await numerosDaConta(token, waba_id); } catch (err) {
    return fail("invalid_request", err instanceof Error ? err.message : "phone_numbers", 422, { requestId });
  }
  const escolha = escolherNumero(numeros, { phoneNumberId: phone_number_id, coexistencia });
  if (!escolha.ok) return fail("invalid_request", t(escolha.motivo), 422, { requestId });
  const phoneNumberId = escolha.numero.id;

  // 3. register só para número novo
  const admin = createAdminClient();
  let pinCifrado: string | null = null;
  if (!coexistencia) {
    const pin = gerarPin();
    pinCifrado = await encryptWebhookSecret(admin, pin);
    if (!pinCifrado) return fail("invalid_request", t("cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o token não foi gravado"), 422, { requestId });
    try { await registrarNumero(token, phoneNumberId, pin); } catch (err) {
      return fail("invalid_request", err instanceof Error ? err.message : "register", 422, { requestId });
    }
  }

  // 4. o MESMO caminho do formulário manual
  const agora = new Date().toISOString();
  const r = await conectarCanalOficial(admin, {
    organizationId: orgId, userId: authz.user.id, requestId, phoneNumberId, wabaId: waba_id, token, callbackBase: publicBase(req),
    metadataExtra: {
      cadastro_incorporado: { evento, em: agora },
      ...(pinCifrado ? { pin_cifrado: pinCifrado } : {}),
    },
  });
  if (!r.ok) return fail(r.codigo, traduzirMotivo(r.motivo, t), r.status, { requestId });

  // 5. coexistência: contatos, depois histórico. Falha NÃO desfaz a conexão.
  let coex: Coexistencia | null = null;
  if (coexistencia) {
    const contatos = await pedirSincronizacao(token, phoneNumberId, "smb_app_state_sync");
    const historico = await pedirSincronizacao(token, phoneNumberId, "history");
    coex = { onboarding_em: agora, pedidos: { contatos, historico }, historico: null };
    await gravarCoexistencia(admin, orgId, r.sessionId, coex);
  }

  // 6. a sessão WAHA deste número já caiu (a Meta desconecta os aparelhos)
  const legada = r.phoneNumber ? await arquivarSessaoLegadaDoNumero(admin, orgId, r.phoneNumber, r.sessionId) : null;

  // 7. trilha — sem token, sem PIN
  void audit({
    action: "channel.official_connected_es", actorUserId: authz.user.id, organizationId: orgId,
    resourceType: "channel_session", resourceId: r.sessionId, requestId,
    metadata: { coexistencia, evento, waba_id, phone_number_id: phoneNumberId, sessao_legada_arquivada: legada, pedidos: coex?.pedidos ?? null },
  });

  return ok({
    connected: true, displayName: r.displayName, phoneNumber: r.phoneNumber, coexistencia,
    webhook: r.webhook.assinado ? { assinado: true } : { assinado: false, motivo: traduzirMotivo(r.webhook.motivo, t) },
  });
}
```

`gravarCoexistencia(admin, orgId, sessionId, coex)` vive em `lib/channels/meta/conectar-canal-oficial.ts` (exportada; ler-mesclar-gravar de `metadata`, mesmo `ponytail:` do POST atual) para a rota `/sincronizar` e a Task 11 reutilizarem. `publicBase`/`traduzirMotivo` saem de `official/route.ts` para `app/api/v1/channels/official/route-helpers.ts` (Next ignora arquivo sem `route.ts` no nome; o GET/POST existentes importam de lá).

- [ ] **Step 4:** rota `/sincronizar`:

```ts
export async function POST(): Promise<NextResponse> {
  // guardas iguais; sem body
  const sessao = await metaSessionForOrg(orgId);             // lib/channels/meta/session.ts
  if (!sessao?.phoneNumberId) return fail("not_found", t("Nenhum canal oficial conectado."), 404, { requestId });
  const admin = createAdminClient();
  const { data } = await admin.from("channel_sessions").select("metadata").eq("organization_id", orgId).eq("id", sessao.id).maybeSingle();
  const coex = lerCoexistencia((data as { metadata?: unknown } | null)?.metadata);
  if (!coex) return fail("invalid_request", t("Este canal não foi conectado em coexistência."), 422, { requestId });
  if (!dentroDoPrazoDeSincronizacao(coex.onboarding_em)) {
    return fail("invalid_request", t("Passaram 24 horas desde a conexão. Para importar o histórico, desconecte e refaça o fluxo pelo botão."), 422, { requestId });
  }
  const creds = await resolveMetaCreds(admin, { organizationId: orgId, phoneNumberId: sessao.phoneNumberId });
  if (!creds || creds.source !== "session") return fail("invalid_request", t("sem credencial da sessão"), 422, { requestId });

  const pedidos = { ...coex.pedidos };
  if (!pedidos.contatos || "erro" in pedidos.contatos) pedidos.contatos = await pedirSincronizacao(creds.token, creds.phoneNumberId, "smb_app_state_sync");
  if (!pedidos.historico || "erro" in pedidos.historico) pedidos.historico = await pedirSincronizacao(creds.token, creds.phoneNumberId, "history");
  await gravarCoexistencia(admin, orgId, sessao.id, { ...coex, pedidos });
  void audit({ action: "channel.official_sync_requested", actorUserId: authz.user.id, organizationId: orgId, resourceType: "channel_session", resourceId: sessao.id, requestId, metadata: { pedidos } });
  return ok({ pedidos, ate: new Date(new Date(coex.onboarding_em).getTime() + PRAZO_DA_SINCRONIZACAO_MS).toISOString() });
}
```

Teste `tests/unit/canal-oficial-sincronizar-coexistencia.test.ts`: (a) pedido com `request_id` NÃO é repetido; (b) 24 h depois → 422 e `pedirSincronizacao` não chamado; (c) erro anterior é tentado de novo e gravado.

- [ ] **Step 5:** GET passa a devolver `coexistencia: data ? lerCoexistencia(data.metadata) : null` (Task 2, Step 4). Componente: quando `estado.coexistencia?.pedidos.historico` tem `erro` e `dentroDoPrazoDeSincronizacao(onboarding_em)`:

```tsx
<div role="alert" data-testid="historico-nao-pedido" className="rounded-md border border-warning/40 bg-warning-bg p-3 text-sm">
  <p>{t("Importação do histórico não foi pedida.")} {t("Dá para tentar de novo até")} {ate}.</p>
  <Button size="sm" variant="outline" onClick={() => sincronizar.mutate()} disabled={sincronizar.isPending} data-testid="btn-sincronizar">
    {t("Tentar de novo")}
  </Button>
</div>
```

(`ate` = `new Date(onboarding_em + PRAZO).toLocaleTimeString(...)`); fora do prazo, texto fixo "Passaram 24 horas. Desconecte e refaça o fluxo pelo botão."

- [ ] **Step 6:** espanhol; `pnpm vitest run tests/unit/canal-oficial-cadastro-incorporado-post.test.ts tests/unit/canal-oficial-sincronizar-coexistencia.test.ts tests/unit/canal-oficial-assina-webhook-da-conta.test.ts tests/unit/i18n-espanhol-cobre-a-tela.test.ts`; `pnpm lint:channels`; `pnpm typecheck`; `pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"` com as sondas do CLAUDE.md.

- [ ] **Step 7:** commit:

```bash
git add lib/channels/meta/conectar-canal-oficial.ts app/api/v1/channels/official/route.ts app/api/v1/channels/official/route-helpers.ts app/api/v1/channels/official/cadastro-incorporado/route.ts app/api/v1/channels/official/cadastro-incorporado/sincronizar/route.ts lib/audit/actions.ts components/connections/CadastroIncorporado.tsx hooks/channels/useOfficialChannel.ts lib/i18n/dicionario.ts tests/unit/canal-oficial-cadastro-incorporado-post.test.ts tests/unit/canal-oficial-sincronizar-coexistencia.test.ts
git commit -m "feat(canal-oficial): POST cadastro-incorporado conecta pelo mesmo caminho do formulário, pede sincronização e arquiva a sessão legada; retry em 24 h

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: Parser dos webhooks da coexistência

**Files:**
- Modify: `lib/channels/meta/webhook.ts` (tipos novos + ramos em `parseMetaWebhook`, depois do ramo `statuses`, ~linha 251)
- Create: `tests/fixtures/meta/coexistencia-webhooks.json`
- Test: `tests/unit/meta-webhook-coexistencia.test.ts`

**Interfaces:**
```ts
export interface EchoMessageEvent { kind: "echo_message"; wabaId: string; phoneNumberId: string; externalId: string; to: string; sentAt: Date; type: string; text: string | null; media: { id: string; url: string | null; mime: string | null; voice: boolean } | null }
export interface HistoryChunkEvent { kind: "history_chunk"; wabaId: string; phoneNumberId: string; fase: number | null; progresso: number | null; chunkOrder: number | null; erroCodigo: number | null; bruto: Record<string, unknown> }
export interface StateSyncEvent { kind: "state_sync"; wabaId: string; phoneNumberId: string; contatos: Array<{ waId: string; nome: string | null }> }
export interface AccountEvent { kind: "account_event"; wabaId: string; evento: "PARTNER_REMOVED" | "ACCOUNT_OFFBOARDED" | "ACCOUNT_RECONNECTED" | "OUTRO"; motivo: string | null; phoneNumber: string | null }
export type MetaWebhookEvent = TemplateStatusEvent | MessageStatusEvent | InboundMessageEvent | EchoMessageEvent | HistoryChunkEvent | StateSyncEvent | AccountEvent;
```

- [ ] **Step 1:** fixtures (uma entrada por campo, escritas a partir da documentação de 01/10/2026; **conferir contra o payload real no dia da conexão** e substituir):

```json
[
  { "object": "whatsapp_business_account", "entry": [{ "id": "222", "changes": [{ "field": "smb_message_echoes", "value": {
      "messaging_product": "whatsapp", "metadata": { "display_phone_number": "5527999049879", "phone_number_id": "111" },
      "message_echoes": [{ "from": "5527999049879", "to": "5531998966398", "id": "wamid.ECO1", "timestamp": "1760097600", "type": "text", "text": { "body": "respondi pelo celular" } }] } }] }] },
  { "object": "whatsapp_business_account", "entry": [{ "id": "222", "changes": [{ "field": "history", "value": {
      "messaging_product": "whatsapp", "metadata": { "display_phone_number": "5527999049879", "phone_number_id": "111" },
      "history": [{ "metadata": { "phase": 0, "chunk_order": 1, "progress": 20 }, "threads": [{ "id": "5531998966398", "messages": [
        { "from": "5531998966398", "id": "wamid.H1", "timestamp": "1759000000", "type": "text", "text": { "body": "oi" }, "history_context": { "status": "DELIVERED" } },
        { "from": "5527999049879", "to": "5531998966398", "id": "wamid.H2", "timestamp": "1759000100", "type": "text", "text": { "body": "olá" } } ] }] }] } }] }] },
  { "object": "whatsapp_business_account", "entry": [{ "id": "222", "changes": [{ "field": "history", "value": {
      "messaging_product": "whatsapp", "metadata": { "phone_number_id": "111" },
      "history": [{ "metadata": { "phase": 0, "chunk_order": 0, "progress": 0 }, "threads": [] }],
      "errors": [{ "code": 2593109, "title": "History sync not shared" }] } }] }] },
  { "object": "whatsapp_business_account", "entry": [{ "id": "222", "changes": [{ "field": "smb_app_state_sync", "value": {
      "messaging_product": "whatsapp", "metadata": { "phone_number_id": "111" },
      "state_sync": [{ "type": "contact", "action": "add", "contact": { "full_name": "Maria Silva", "phone_number": "+55 31 99896-6398" }, "metadata": { "timestamp": "1760097600" } }] } }] }] },
  { "object": "whatsapp_business_account", "entry": [{ "id": "222", "changes": [{ "field": "account_update", "value": {
      "phone_number": "+5527999049879", "event": "PARTNER_REMOVED", "disconnection_info": { "reason": "USER_INITIATED_DISCONNECT" } } }] }] },
  { "object": "whatsapp_business_account", "entry": [{ "id": "222", "changes": [{ "field": "account_update", "value": { "phone_number": "+5527999049879", "event": "ACCOUNT_RECONNECTED" } }] }] }
]
```

- [ ] **Step 2:** teste (molde: `tests/unit/meta-webhook-inbound.test.ts`):

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMetaWebhook } from "@/lib/channels/meta/webhook";

const F = JSON.parse(readFileSync("tests/fixtures/meta/coexistencia-webhooks.json", "utf8")) as Parameters<typeof parseMetaWebhook>[0][];

describe("coexistência — parser", () => {
  it("smb_message_echoes vira echo_message com o DESTINATÁRIO como contato", () => {
    expect(parseMetaWebhook(F[0]!)[0]).toMatchObject({ kind: "echo_message", phoneNumberId: "111", externalId: "wamid.ECO1", to: "5531998966398", type: "text", text: "respondi pelo celular" });
  });
  it("history vira UM history_chunk com fase/progresso e o value cru", () => {
    const [e] = parseMetaWebhook(F[1]!);
    expect(e).toMatchObject({ kind: "history_chunk", fase: 0, progresso: 20, chunkOrder: 1, erroCodigo: null });
    expect((e as { bruto: { history: unknown[] } }).bruto.history).toHaveLength(1);
  });
  it("history com erro 2593109 carrega o código", () => {
    expect(parseMetaWebhook(F[2]!)[0]).toMatchObject({ kind: "history_chunk", erroCodigo: 2593109 });
  });
  it("smb_app_state_sync vira contatos com wa_id só dígitos e nome", () => {
    expect(parseMetaWebhook(F[3]!)[0]).toMatchObject({ kind: "state_sync", contatos: [{ waId: "5531998966398", nome: "Maria Silva" }] });
  });
  it("account_update PARTNER_REMOVED traz o motivo; ACCOUNT_RECONNECTED não", () => {
    expect(parseMetaWebhook(F[4]!)[0]).toMatchObject({ kind: "account_event", evento: "PARTNER_REMOVED", motivo: "USER_INITIATED_DISCONNECT", phoneNumber: "+5527999049879" });
    expect(parseMetaWebhook(F[5]!)[0]).toMatchObject({ kind: "account_event", evento: "ACCOUNT_RECONNECTED", motivo: null });
  });
});
```

- [ ] **Step 3:** ramos em `parseMetaWebhook` (reaproveitando `str()`; a extração de mídia do inbound vira função `midiaDe(raw, tipo)` usada pelos dois ramos):

```ts
      if (change.field === "smb_message_echoes" && Array.isArray(v.message_echoes)) {
        const meta = (v.metadata ?? {}) as Record<string, unknown>;
        for (const raw of v.message_echoes as Record<string, unknown>[]) {
          const id = str(raw.id); const to = str(raw.to);
          if (!id || !to) continue;
          const tipo = str(raw.type) ?? "unknown";
          out.push({
            kind: "echo_message", wabaId, phoneNumberId: str(meta.phone_number_id) ?? "", externalId: id, to,
            sentAt: new Date(Number(str(raw.timestamp) ?? "0") * 1000), type: tipo,
            text: tipo === "text" ? str((raw.text as Record<string, unknown>)?.body) : null,
            media: midiaDe(raw, tipo),
          });
        }
        continue;
      }
      if (change.field === "history") {
        const meta = (v.metadata ?? {}) as Record<string, unknown>;
        const primeiro = (Array.isArray(v.history) ? (v.history[0] as Record<string, unknown> | undefined) : undefined)?.metadata as Record<string, unknown> | undefined;
        const erros = Array.isArray(v.errors) ? (v.errors as Record<string, unknown>[]) : [];
        out.push({
          kind: "history_chunk", wabaId, phoneNumberId: str(meta.phone_number_id) ?? "",
          fase: typeof primeiro?.phase === "number" ? primeiro.phase : null,
          progresso: typeof primeiro?.progress === "number" ? primeiro.progress : null,
          chunkOrder: typeof primeiro?.chunk_order === "number" ? primeiro.chunk_order : null,
          erroCodigo: typeof erros[0]?.code === "number" ? (erros[0]!.code as number) : null,
          bruto: v as Record<string, unknown>,
        });
        continue;
      }
      if (change.field === "smb_app_state_sync" && Array.isArray(v.state_sync)) {
        const meta = (v.metadata ?? {}) as Record<string, unknown>;
        const contatos: StateSyncEvent["contatos"] = [];
        for (const raw of v.state_sync as Record<string, unknown>[]) {
          if (str(raw.type) !== "contact" || str(raw.action) === "remove") continue;
          const c = (raw.contact ?? {}) as Record<string, unknown>;
          const digitos = (str(c.phone_number) ?? "").replace(/\D/g, "");
          if (!digitos) continue;
          contatos.push({ waId: digitos, nome: str(c.full_name) ?? str(c.first_name) });
        }
        out.push({ kind: "state_sync", wabaId, phoneNumberId: str(meta.phone_number_id) ?? "", contatos });
        continue;
      }
      if (change.field === "account_update" && str(v.event)) {
        const ev = str(v.event)!;
        const conhecido = (["PARTNER_REMOVED", "ACCOUNT_OFFBOARDED", "ACCOUNT_RECONNECTED"] as const).find((k) => k === ev);
        out.push({
          kind: "account_event", wabaId, evento: conhecido ?? "OUTRO",
          motivo: str((v.disconnection_info as Record<string, unknown> | undefined)?.reason),
          phoneNumber: str(v.phone_number),
        });
        continue;
      }
```

(`account_offboarded` e `account_reconnected` como CAMPOS próprios: tratar `change.field === "account_offboarded"` → evento `ACCOUNT_OFFBOARDED`, `"account_reconnected"` → `ACCOUNT_RECONNECTED`, mesmo objeto. Fixture 7 e 8 para os dois.)

- [ ] **Step 4:** `pnpm vitest run tests/unit/meta-webhook-coexistencia.test.ts tests/unit/meta-webhook-inbound.test.ts tests/unit/meta-webhook.test.ts tests/unit/contrato-do-webhook-meta.test.ts` → passed (o envelope continua loose; nada muda em `envelope.ts`).

- [ ] **Step 5:** commit:

```bash
git add lib/channels/meta/webhook.ts tests/fixtures/meta/coexistencia-webhooks.json tests/unit/meta-webhook-coexistencia.test.ts
git commit -m "feat(canal-oficial): parser dos webhooks de coexistência (echo, history, state_sync, account_update)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: Eco do celular entra como "Celular" e silencia a IA

**Files:**
- Modify: `lib/channels/meta/ingest.ts` (nova função `ingestMetaEcho`), `app/api/v1/webhooks/meta/[token]/route.ts` (ramo `echo_message` no `for`, ~linha 130), `app/api/v1/channels/official/route.ts` (GET, `fields` linha 187)
- Test: `lib/channels/meta/ingest-echo.test.ts`

**Interfaces:**
- `export async function ingestMetaEcho(admin: SupabaseClient, e: EchoMessageEvent, dono: ChannelTenantScope): Promise<IngestOutcome>`
- Consome `pausarIaPorAtendimentoManual` (`lib/escalacao/atendimento-manual.ts`), `marcarConversaComMensagem`, `encontrarContatoPorTelefone`, `fn_upsert_wa_contact`/`fn_upsert_wa_conversation`.
- `fields` do GET passa a ser `["messages", "message_template_status_update", "smb_message_echoes", "history", "smb_app_state_sync", "account_update"]`.

- [ ] **Step 1:** teste com o `adminFalso` de `tests/unit/ingestao-do-canal-oficial-por-organizacao.test.ts` (copiar a fábrica para este arquivo; registrar `rpc` chamadas e `insert` payloads):

```ts
// lib/channels/meta/ingest-echo.test.ts
vi.mock("@/lib/escalacao/atendimento-manual", () => ({ pausarIaPorAtendimentoManual: (...a: unknown[]) => pausar(...a) }));
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: (...a: unknown[]) => posEntrada(...a) }));
vi.mock("@/lib/channels/marcar-conversa", () => ({ marcarConversaComMensagem: (...a: unknown[]) => marcar(...a) }));

const ECO: EchoMessageEvent = { kind: "echo_message", wabaId: "222", phoneNumberId: "111", externalId: "wamid.ECO1", to: "5531998966398", sentAt: new Date("2026-10-10T12:00:00Z"), type: "text", text: "respondi pelo celular", media: null };

it("grava outbound sent_via external_device, origem celular, e pausa a IA com a regra do atendimento manual", async () => {
  const r = await ingestMetaEcho(admin, ECO, { organizationId: ORG });
  expect(r).toMatchObject({ status: "ingested" });
  expect(inserts[0]).toMatchObject({ direction: "outbound", status: "sent", sent_via: "external_device", external_id: "wamid.ECO1", metadata: { origem: "celular", fromMe: true } });
  expect(pausar).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ organizationId: ORG, conversationId: CONV, canal: "meta" }));
  expect(posEntrada).not.toHaveBeenCalled();
  expect(marcar).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ direction: "outbound" }));
});
it("wamid já gravado → duplicate, e NÃO silencia (pode ser o eco de um envio do CRM reentregue)", async () => {
  insertErro = { code: "23505", message: "dup" };
  expect(await ingestMetaEcho(admin, ECO, { organizationId: ORG })).toEqual({ status: "duplicate" });
  expect(pausar).not.toHaveBeenCalled();
});
it("o contato é o DESTINATÁRIO e o nome do perfil não é passado (seria o da loja)", async () => {
  await ingestMetaEcho(admin, ECO, { organizationId: ORG });
  expect(rpcs.find((r) => r.fn === "fn_upsert_wa_contact")?.args).toMatchObject({ p_chat_id: "5531998966398", p_notify: null });
});
```

- [ ] **Step 2:** implementação em `ingest.ts` (depois de `ingestMetaInbound`):

```ts
/**
 * Eco do CELULAR (`smb_message_echoes`): uma pessoa respondeu pelo WhatsApp
 * Business do aparelho. É o mesmo gesto do `fromMe` do outro canal
 * (`lib/waha/ingest.ts`, `handleOutboundFromUserPhone`) e tem o mesmo desfecho:
 * linha outbound `external_device`, conversa carimbada (sem não-lida), IA
 * pausada por `pausarIaPorAtendimentoManual` — a regra de 5 min que o composer
 * também usa. NÃO passa por `aplicarEfeitosPosEntrada`: ninguém entrou, alguém saiu.
 *
 * Idempotente por `(organization_id, external_id)`; o `duplicate` não pausa
 * nada — um wamid repetido pode ser reentrega de eco de envio do próprio CRM.
 */
export async function ingestMetaEcho(admin: Admin, e: EchoMessageEvent, dono: ChannelTenantScope): Promise<IngestOutcome> {
  let sessao: { id: string; organization_id: string } | null;
  try { sessao = await sessionByPhoneNumberId(admin, dono.organizationId, e.phoneNumberId); }
  catch (err) { return { status: "failed", reason: err instanceof Error ? err.message : "sessao_do_numero" }; }
  if (!sessao) return { status: "no_session" };
  const orgId = sessao.organization_id;

  const existente = await findContactByVariants(admin, orgId, e.to);
  const phone = existente?.phone_number ? canonicalPhoneBR(existente.phone_number) : canonicalPhoneBR(`+${e.to.replace(/\D/g, "")}`);
  const { data: contactId, error: erroContato } = await admin.rpc("fn_upsert_wa_contact" as never,
    { p_org: orgId, p_kind: "phone", p_phone: phone, p_lid: null, p_chat_id: e.to, p_notify: null } as never);
  if (erroContato || !contactId) return { status: "failed", reason: `contato: ${erroContato?.message ?? "sem id"}` };

  const { data: conversationId, error: erroConversa } = await admin.rpc("fn_upsert_wa_conversation" as never,
    { p_org: orgId, p_contact: contactId as string, p_session: sessao.id } as never);
  if (erroConversa || !conversationId) return { status: "failed", reason: `conversa: ${erroConversa?.message ?? "sem id"}` };

  const { data: inserida, error: erroInsert } = await admin.from("messages").insert({
    organization_id: orgId, conversation_id: conversationId as string, channel_session_id: sessao.id, contact_id: contactId as string,
    direction: "outbound", status: "sent", sent_via: "external_device",
    type: e.type, body: e.text, external_id: e.externalId,
    media_url: e.media ? `meta-media:${e.media.id}` : null, media_mime: e.media?.mime ?? null,
    sent_at: e.sentAt.toISOString(),
    metadata: { origem: "celular", fromMe: true, ...(e.media ? { meta_media_id: e.media.id, voice: e.media.voice } : {}) },
  }).select("id").maybeSingle();
  if (erroInsert) {
    if (erroInsert.code === "23505") return { status: "duplicate" };
    return { status: "failed", reason: `mensagem: ${erroInsert.message}` };
  }

  await marcarConversaComMensagem(admin, { organizationId: orgId, conversationId: conversationId as string, direction: "outbound", preview: previewDoEco(e), at: e.sentAt.toISOString(), canal: "meta" });
  await pausarIaPorAtendimentoManual(admin, { organizationId: orgId, conversationId: conversationId as string, canal: "meta", agora: e.sentAt });

  const messageId = (inserida as { id: string } | null)?.id ?? "";
  if (e.media && messageId) await pedirPersistenciaDeMidia(admin, orgId, messageId, conversationId as string); // extraído do inbound neste passo
  return { status: "ingested", messageId, conversationId: conversationId as string };
}
```

(`previewDoEco` é o `previewOf` existente com a assinatura trocada para `Pick<InboundMessageEvent, "type" | "text" | "media"> & Partial<Pick<InboundMessageEvent, "sharedContact">>`, que serve aos dois eventos.)

- [ ] **Step 3:** rota do webhook: `if (e.kind === "echo_message") { const r = await ingestMetaEcho(admin, e, { organizationId: session.organizationId }); desfechos.push(\`echo:${r.status}\`); continue; }` antes do ramo `template_status`. Os kinds `history_chunk`, `state_sync` e `account_event` recebem `desfechos.push("ignorado")` nesta task (Tasks 8, 11 e 12 os ligam). ⚠️ O `else` final hoje trata TUDO que não é template como `message_status`; com os kinds novos, trocar por `if (e.kind === "message_status")` explícito.

- [ ] **Step 4:** `pnpm vitest run lib/channels/meta/ingest-echo.test.ts tests/unit/ingestao-do-canal-oficial-por-organizacao.test.ts tests/unit/webhook-meta-le-do-banco.test.ts tests/unit/rotulo-de-origem-tem-emissor.test.ts` → passed (a bolha já rotula `external_device` como "Celular": `components/inbox/MessageBubble.tsx:96`, nada a mudar na UI).

- [ ] **Step 5:** commit:

```bash
git add lib/channels/meta/ingest.ts lib/channels/meta/ingest-echo.test.ts "app/api/v1/webhooks/meta/[token]/route.ts" app/api/v1/channels/official/route.ts
git commit -m "feat(canal-oficial): eco do celular entra como Celular, carimba a conversa e pausa a IA pela regra do atendimento manual

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: Desconexão pelo celular vira `FAILED` + aviso na Central; reconexão fecha o aviso

**Files:**
- Create: `lib/channels/meta/saude-da-conta.ts`
- Modify: `lib/channels/health.ts` (constante + ramo em `avisoDaConexao`, ao lado de `DETALHE_TOKEN_DE_RENOVACAO_VENCIDO`, ~linha 150), `app/api/v1/webhooks/meta/[token]/route.ts`
- Test: `lib/channels/meta/saude-da-conta.test.ts`, `tests/unit/saude-dos-canais-oficiais.test.ts` (existente, continua verde)

**Interfaces:**
- `export const DETALHE_DESCONECTADO_NO_APP = "desconectado_no_aplicativo"` e `EPISODIO_DESCONECTADO_NO_APP = "DESCONECTADO_NO_APP"` em `health.ts`; `avisoDaConexao` reconhece `detail` que começa com `${DETALHE_DESCONECTADO_NO_APP}:` e usa o resto como corpo.
- `export async function aplicarEventoDaConta(admin: SupabaseClient, sessao: MetaWebhookSession, e: AccountEvent): Promise<"caiu" | "voltou" | "ignorado">`

- [ ] **Step 1:** testes:

```ts
// lib/channels/meta/saude-da-conta.test.ts
vi.mock("@/lib/channels/health", async (orig) => ({ ...(await orig<typeof import("@/lib/channels/health")>()), sincronizarSaudeDaConexao: (...a: unknown[]) => sincronizar(...a) }));

it("PARTNER_REMOVED: sessão FAILED com status_reason e aviso pelo empurrão, com o motivo da Meta", async () => {
  expect(await aplicarEventoDaConta(admin, SESSAO, { kind: "account_event", wabaId: "222", evento: "PARTNER_REMOVED", motivo: "USER_INITIATED_DISCONNECT", phoneNumber: null })).toBe("caiu");
  expect(updates[0]?.patch).toMatchObject({ status: "FAILED", status_reason: "coexistencia_desconectada" });
  expect(sincronizar).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: SESSAO.id, status: "FAILED" }),
    { reachable: false, status: null, detail: `${DETALHE_DESCONECTADO_NO_APP}:USER_INITIATED_DISCONNECT` }, "Clínica", "empurrao");
});
it("ACCOUNT_RECONNECTED: WORKING, status_reason nulo, observação boa pelo empurrão (resolve o aviso)", async () => { /* status WORKING; sincronizar com { reachable: true, status: "WORKING", detail: null }, "empurrao" */ });
it("evento desconhecido é ignorado sem tocar na sessão", async () => { /* "OUTRO" → "ignorado", zero updates */ });

// em tests/unit/saude-dos-canais-oficiais.test.ts (ou novo describe aqui) — o aviso:
it("avisoDaConexao com detalhe de desconexão no app: crítico, título diz que foi pelo celular, corpo é o motivo", () => {
  expect(avisoDaConexao({ reachable: false, status: null, detail: `${DETALHE_DESCONECTADO_NO_APP}:USER_INITIATED_DISCONNECT` }, "Clínica")).toMatchObject({
    kind: "channel_number_alert", severity: "critical", episodio: EPISODIO_DESCONECTADO_NO_APP, title: expect.stringMatching(/desconectad.*celular/i), body: expect.stringContaining("USER_INITIATED_DISCONNECT"),
  });
});
```

- [ ] **Step 2:** `health.ts` — depois do ramo do token de renovação:

```ts
    if (saude.detail?.startsWith(`${DETALHE_DESCONECTADO_NO_APP}:`)) {
      const motivo = saude.detail.slice(DETALHE_DESCONECTADO_NO_APP.length + 1);
      return {
        kind: "channel_number_alert",
        severity: "critical",
        title: `${canal} "${apelido}" foi desconectado pelo celular`,
        body: `Alguém removeu a conexão no WhatsApp Business do aparelho (motivo da Meta: ${motivo || "não informado"}). Nenhuma mensagem entra nem sai até reconectar em Conexões › API Oficial.`,
        episodio: EPISODIO_DESCONECTADO_NO_APP,
      };
    }
```

- [ ] **Step 3:** `saude-da-conta.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { DETALHE_DESCONECTADO_NO_APP, sincronizarSaudeDaConexao } from "@/lib/channels/health";
import { CHANNEL_PROVIDER_META } from "../capabilities";
import type { MetaWebhookSession } from "./session";
import type { AccountEvent } from "./webhook";

export const STATUS_REASON_COEXISTENCIA_DESCONECTADA = "coexistencia_desconectada";

export async function aplicarEventoDaConta(admin: SupabaseClient, sessao: MetaWebhookSession, e: AccountEvent): Promise<"caiu" | "voltou" | "ignorado"> {
  if (e.evento === "OUTRO") return "ignorado";
  const caiu = e.evento !== "ACCOUNT_RECONNECTED";
  const now = new Date().toISOString();
  const status = caiu ? "FAILED" : "WORKING";
  await admin.from("channel_sessions")
    .update({ status, status_reason: caiu ? STATUS_REASON_COEXISTENCIA_DESCONECTADA : null, last_status_change_at: now })
    .eq("organization_id", sessao.organizationId).eq("id", sessao.id);
  const { data } = await admin.from("channel_sessions").select("display_name, phone_number").eq("organization_id", sessao.organizationId).eq("id", sessao.id).maybeSingle();
  const apelido = (data?.display_name as string | null) ?? (data?.phone_number as string | null) ?? "sem nome";
  await sincronizarSaudeDaConexao(
    admin,
    { id: sessao.id, organization_id: sessao.organizationId, status, provider: CHANNEL_PROVIDER_META },
    caiu ? { reachable: false, status: null, detail: `${DETALHE_DESCONECTADO_NO_APP}:${e.motivo ?? ""}` } : { reachable: true, status: "WORKING", detail: null },
    apelido,
    "empurrao",
  );
  return caiu ? "caiu" : "voltou";
}
```

Rota: `if (e.kind === "account_event") { desfechos.push(\`conta:${await aplicarEventoDaConta(admin, session, e)}\`); continue; }`.

- [ ] **Step 4:** `pnpm vitest run lib/channels/meta/saude-da-conta.test.ts tests/unit/saude-dos-canais-oficiais.test.ts` → passed. `pnpm lint:channels`.

- [ ] **Step 5:** commit:

```bash
git add lib/channels/meta/saude-da-conta.ts lib/channels/meta/saude-da-conta.test.ts lib/channels/health.ts "app/api/v1/webhooks/meta/[token]/route.ts" tests/unit/saude-dos-canais-oficiais.test.ts
git commit -m "feat(canal-oficial): desconexão pelo celular derruba a sessão e abre aviso na Central; reconexão fecha

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 9: `resolveMetaCreds` não cai no `.env` quando a decifra da sessão falha

**Files:**
- Modify: `lib/channels/meta/credentials.ts` (linhas 131-136)
- Test: `tests/unit/credencial-da-sessao-nao-cai-no-env.test.ts`; conferir `tests/unit/modelo-e-sincronizacao-usam-a-credencial-da-sessao.test.ts` e `tests/unit/saude-dos-canais-oficiais.test.ts`

- [ ] **Step 1:** teste: sessão com `meta_token_encrypted` e `fn_decrypt_oauth` devolvendo `null`, `META_SYSTEM_USER_TOKEN` no ambiente → `resolveMetaCreds` **rejeita** com `meta_creds_decrypt_failed`; sem token cifrado na sessão continua caindo no env (`source: "env"`).

- [ ] **Step 2:** trocar o `if (!token) return null;` por:

```ts
  // A sessão TEM token e ele não decifrou (chave mestra trocada, GUC ausente).
  // Cair no `.env` aqui enviaria pela conta de OUTRA instalação sem erro em
  // lugar nenhum — o mesmo defeito da issue #236 por outra porta. Falha fechada.
  if (!token) throw new Error("meta_creds_decrypt_failed: a credencial da sessão não decifrou; o .env não é usado");
```

Atualizar o comentário acima dele. Quem chama (`send`, `checkHealth`, template sync) já trata throw de `metaCredsForPhoneNumberId` (o caso PGRST116 lança desde a #236); conferir em `grep -rn "resolveMetaCreds(" lib app` que cada chamador está dentro de `try` ou propaga para um desfecho `failed` visível.

- [ ] **Step 3:** `pnpm vitest run tests/unit/credencial-da-sessao-nao-cai-no-env.test.ts tests/unit/modelo-e-sincronizacao-usam-a-credencial-da-sessao.test.ts tests/unit/saude-dos-canais-oficiais.test.ts tests/unit/channel-adapter-meta.test.ts` → passed (ajustar expectativa que afirmava o fallback, se houver, com o motivo no commit).

- [ ] **Step 4:** commit:

```bash
git add lib/channels/meta/credentials.ts tests/unit/credencial-da-sessao-nao-cai-no-env.test.ts
git commit -m "fix(canal-oficial): token da sessão que não decifra lança em vez de cair na conta do .env

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: ADR, doutrina, mapa vivo, fragmento de release e e2e (Parte A)

**Files:**
- Create: `docs/adr/0002-cadastro-incorporado.md`, `docs/architecture/cadastro-incorporado.architecture.json`, `.changes/cadastro-incorporado-v4.md`, `scripts/seed-e2e-cadastro-incorporado.ts`, `tests/e2e/cadastro-incorporado.spec.ts`
- Modify: `docs/doctrine/restricao-de-canal.md` (seção "Embedded Signup não cabe em self-host", linhas 199-230), `docs/index.md` (linha 96, ao lado do ADR-0001), `docs/testing/user-journey-map.md`, `scripts/gerar-env-e2e.sh` (ao lado de `INSTAGRAM_GRAPH_BASE_URL`), `.github/workflows/e2e.yml` (`SPECS_PARTE_4`)

- [ ] **Step 1:** ADR (molde: `docs/adr/0001-packaging-e-distribuicao.md`): Status aceito; Contexto (a doutrina de 2026-07-30 dizia que Embedded Signup não cabe em self-host; no EvaLink a instalação usa o app de Tech Provider do EvaLink, app 1054112660758768; o produto aberto segue BYO por padrão); Decisões (configuração no banco, `es_config_id` vazio = botão ausente, BYO fica; coexistência é metadado; histórico por `event_log`; sem `/register` em coexistência); Consequências (limite de 10 clientes/7 dias sem verificação; webhook fora do ar perde histórico; WAHA do número cai); Recusados (provider novo `meta_coex`; extrair um segundo helper de silêncio quando `pausarIaPorAtendimentoManual` já é a regra; chamar `/register` "por garantia").

- [ ] **Step 2:** doutrina — ao fim da seção, um parágrafo: "**Revisão (2026-10-01):** quando a instalação tem um app de Tech Provider à disposição (caso EvaLink), o Cadastro Incorporado passa a existir como caminho opcional, ligado por `platform_meta_app.es_config_id`; o BYO continua sendo o padrão do produto aberto. Decisão e limites em [`docs/adr/0002-cadastro-incorporado.md`](../adr/0002-cadastro-incorporado.md)." Linha em `docs/index.md`. Mapa `.architecture.json` com lanes operador/servidor/banco/externo e ≥2 arestas (botão → rota → `conectarCanalOficial` → `channel_sessions`; webhook → eco → `pausarIaPorAtendimentoManual`; webhook → `aplicarEventoDaConta` → Central). Rodar `pnpm vitest run tests/unit/mapas-de-arquitetura.test.ts tests/unit/documentacao-aponta-para-o-que-existe.test.ts`.

- [ ] **Step 3:** `.changes/cadastro-incorporado-v4.md`:

```md
---
impacto: capacidade_nova
secao: adicionado
titulo: Conectar o WhatsApp oficial pelo botão, mantendo o número no celular
---

Em Conexões › API Oficial aparece o botão Conectar WhatsApp quando quem administra
a instalação cadastra o App ID e o Configuration ID em Admin › API Oficial (Meta).
O fluxo da Meta conecta o número sem colar token; o número pode continuar no
WhatsApp Business do celular (coexistência). Resposta dada pelo celular aparece
como Celular e pausa a IA por 5 minutos; desconectar pelo celular abre aviso na
Central. Sem os dois valores nada muda: o formulário manual continua.
```

- [ ] **Step 4:** ambiente do e2e: em `scripts/gerar-env-e2e.sh`, `META_GRAPH_BASE_URL=http://127.0.0.1:47812` (comentário: só a spec de Cadastro Incorporado escuta ali). Seed `scripts/seed-e2e-cadastro-incorporado.ts` (molde: `seed-e2e-instagram.ts` linhas 100-120): upsert em `platform_meta_app` de `app_id: "e2e-app"`, `es_config_id: "e2e-config"`, `app_secret_encrypted` e `verify_token_encrypted` cifrados por `encryptWebhookSecret`; arquiva qualquer sessão `meta_cloud` ativa da org do seed.

- [ ] **Step 5:** spec `tests/e2e/cadastro-incorporado.spec.ts` (login com `creds.users.admin`, como `instagram-receber.spec.ts`):

```ts
test.beforeAll(async () => {
  graph = http.createServer((req, res) => {
    const url = req.url ?? "";
    const responder = (b: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(b)); };
    if (url.includes("/oauth/access_token")) return responder({ access_token: "EAAX-e2e" });
    if (url.includes("/debug_token")) return responder({ data: { app_id: "e2e-app", is_valid: true, scopes: ["whatsapp_business_management", "whatsapp_business_messaging"] } });
    if (url.includes("/phone_numbers")) return responder({ data: [{ id: "111", display_phone_number: "+55 27 99904-9879", verified_name: "Clínica E2E", is_on_biz_app: true }] });
    if (url.endsWith("/111?fields=display_phone_number,verified_name,quality_rating")) return responder({ display_phone_number: "+55 27 99904-9879", verified_name: "Clínica E2E" });
    if (url.includes("/subscribed_apps")) return responder({ success: true });
    if (url.includes("/smb_app_data")) { pedidos.push(String(req.read())); return responder({ request_id: `req-${pedidos.length}` }); }
    res.statusCode = 404; responder({ error: { message: `não simulado: ${url}` } });
  });
  await new Promise<void>((ok) => graph.listen(47812, "127.0.0.1", ok));
});

test("[P0] admin conecta pelo botão e a aba mostra Conectado", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { FB: unknown }).FB = {
      init: () => undefined,
      login: (cb: (r: unknown) => void) => {
        window.dispatchEvent(new MessageEvent("message", { origin: "https://www.facebook.com",
          data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", data: { waba_id: "222" } }) }));
        cb({ authResponse: { code: "AQB-e2e" } });
      },
    };
  });
  await login(page, creds.users.admin.email);
  await page.goto("/app/connections?aba=oficial");
  await page.getByTestId("btn-conectar-whatsapp").click();
  await expect(page.getByTestId("canal-conectado")).toContainText("Clínica E2E");
  await expect(page.getByTestId("canal-conectado")).toContainText("WORKING");
  expect(pedidos.map((p) => new URLSearchParams(p).get("sync_type"))).toEqual(["smb_app_state_sync", "history"]);
  await page.screenshot({ path: path.join(EVIDENCIA, "conectado.png"), fullPage: true });
});
```

(`?aba=oficial` — conferir o nome do parâmetro em `ConexoesShell.tsx:50`.) Acrescentar `cadastro-incorporado.spec.ts` a `SPECS_PARTE_4`; `pnpm vitest run tests/unit/e2e-cobertura-completa.test.ts`. Registrar a jornada `[P0]` em `docs/testing/user-journey-map.md`.

- [ ] **Step 6:** rodar o e2e localmente conforme `docs/testing/` (Supabase local pg15 + `baseline.sql` + `next build && next start`): `pnpm test:e2e tests/e2e/cadastro-incorporado.spec.ts` → 1 passed, evidência em `.superpowers/evidence/`. Rodar a suíte inteira: `pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"` e as sondas; `pnpm gov:verify`; `pnpm test:db`.

- [ ] **Step 7:** commit:

```bash
git add docs/adr/0002-cadastro-incorporado.md docs/doctrine/restricao-de-canal.md docs/index.md docs/architecture/cadastro-incorporado.architecture.json docs/testing/user-journey-map.md .changes/cadastro-incorporado-v4.md scripts/seed-e2e-cadastro-incorporado.ts scripts/gerar-env-e2e.sh tests/e2e/cadastro-incorporado.spec.ts .github/workflows/e2e.yml
git commit -m "docs(adr): 0002 Cadastro Incorporado; e2e do botão com FB e Graph simulados; fragmento de release

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Abrir o PR 1 (`gh pr create`) com a lista de verificação do DoD; não fazer merge sem `verify, build-and-size, invariants, e2e, imagens-ok` verdes.

---

# Parte B = PR 2 (branch `feat/coexistencia-historico`, a partir da `main` com o PR 1 mergeado)

## Task 11: Histórico do celular: fila em `event_log`, worker idempotente, gatilho que não acorda ninguém (migration 0294)

**Files:**
- Create: `supabase/migrations/20261006120000_0294_historico_importado_nao_emite_evento.sql`, `workers/meta-history-worker.ts`, `workers/meta-history-worker.handler.ts`
- Modify: `supabase/baseline.sql` (apêndice antes da varredura), `supabase/migrations/MANIFEST.md`, `lib/event-log/register-handlers.ts`, `app/api/v1/webhooks/meta/[token]/route.ts` (ramo `history_chunk`), `lib/channels/meta/conectar-canal-oficial.ts` (`gravarCoexistencia` já existe)
- Test: `workers/meta-history-worker.test.ts`, `tests/invariants/historico-importado-nao-emite-evento.test.ts`

**Interfaces:**
- Evento `meta.history_chunk` (`event_type_format` do banco exige `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`): `entity_kind: "channel_session"`, `entity_id: session.id`, `payload: { phone_number_id, fase, progresso, chunk_order, erro_codigo, value: <bruto> }`, `metadata: { source: "meta_webhook", request_id }`.
- `export const META_HISTORY_CONSUMER_KEY = "meta-history-worker"`; `export async function processarChunkDeHistorico(row: EventRow, admin?: SupabaseClient): Promise<HandlerResult>`.
- Marca na mensagem: `metadata.importada_do_historico: true` (é o que o gatilho lê).

- [ ] **Step 1 (migration + baseline + MANIFEST):**

```sql
-- 0294 — Mensagem IMPORTADA DO HISTÓRICO (coexistência) não emite evento.
-- `trg_messages_emit_event` emite `message.received` em todo insert inbound e
-- é o que acorda IA, sentimento, follow-up, push e automação. Um worker que
-- "não chama a IA" não basta: o gatilho chama por ele. A guarda vive no
-- gatilho porque é o único lugar por onde TODOS os consumidores passam.
-- Corpo derivado da versão em vigor (0152: `body_preview`); só a guarda entra.
create or replace function public.fn_emit_message_event() returns trigger
language plpgsql set search_path to 'public', 'pg_temp' as $$
declare
  v_event text;
begin
  if coalesce(new.metadata->>'importada_do_historico', '') = 'true' then
    return new;
  end if;
  if new.direction = 'inbound' then
    v_event := 'message.received';
  else
    v_event := case new.status
                 when 'sending' then 'message.sending'
                 when 'sent' then 'message.sent'
                 when 'failed' then 'message.failed'
                 else 'message.outbound'
               end;
  end if;
  perform public.fn_log_event(
    new.organization_id, v_event,
    jsonb_build_object(
      'message_id', new.id, 'conversation_id', new.conversation_id,
      'contact_id', new.contact_id, 'direction', new.direction,
      'type', new.type, 'status', new.status, 'external_id', new.external_id,
      'channel_session_id', new.channel_session_id,
      'body_preview', left(new.body, 280)
    )
  );
  return new;
end$$;
```

Apêndice idêntico sob `-- ---- histórico importado não emite evento (migration 0294) ----`, ANTES da varredura (`tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts` proíbe `create function` depois dela). MANIFEST: "Guarda em `fn_emit_message_event`: linha com `metadata.importada_do_historico = true` não emite `message.*`. Sem isso o histórico da coexistência acordaria IA, follow-up, push e automação pelo gatilho. Idempotente (`create or replace`)."

- [ ] **Step 2:** invariante:

```ts
// tests/invariants/historico-importado-nao-emite-evento.test.ts
it("insert inbound marcado como importado NÃO cria linha em event_log; sem a marca, cria", () => {
  // seed: org, contato, sessão, conversa (sql() do psql-transporte, como fazem os invariantes de canal)
  const antes = sql(`select count(*) from public.event_log where organization_id='${ORG}'`).trim();
  sql(`insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, direction, status, type, body, external_id, sent_at, metadata)
       values ('${ORG}','${CONV}','${SESSAO}','${CONTATO}','inbound','delivered','text','velha','wamid.H1',now()-interval '30 days','{"importada_do_historico":true}')`);
  expect(sql(`select count(*) from public.event_log where organization_id='${ORG}'`).trim()).toBe(antes);
  sql(`insert into public.messages (...) values (... 'wamid.N1' ..., '{}')`);
  expect(Number(sql(`select count(*) from public.event_log where organization_id='${ORG}'`))).toBe(Number(antes) + 1);
});
```

- [ ] **Step 3:** teste do worker (`adminFalso` com `rpc`/`insert`/`update` registrados; `vi.mock("@/lib/channels/pos-entrada")` e `vi.mock("@/lib/channels/marcar-conversa")` para afirmar que NÃO são chamados):

```ts
const LINHA: EventRow = { id: "ev1", organization_id: ORG, event_type: "meta.history_chunk", entity_kind: "channel_session", entity_id: SESSAO, consumed_by: [], attempts: 0,
  payload: { phone_number_id: "111", fase: 0, progresso: 20, chunk_order: 1, erro_codigo: null, value: FIXTURE_HISTORY_VALUE }, metadata: {} };

it("direção pela origem: from = número do negócio → outbound; sent_at do timestamp original; marca importada", async () => {
  await processarChunkDeHistorico(LINHA, admin);
  expect(inserts.map((i) => [i.external_id, i.direction])).toEqual([["wamid.H1", "inbound"], ["wamid.H2", "outbound"]]);
  expect(inserts[0]).toMatchObject({ sent_at: "2025-09-27T18:26:40.000Z", metadata: { importada_do_historico: true } });
  expect(inserts[1]).toMatchObject({ sent_via: "external_device" });
});
it("não chama efeitos pós-entrada nem carimba a conversa (last_inbound_at intocado)", async () => {
  await processarChunkDeHistorico(LINHA, admin);
  expect(posEntrada).not.toHaveBeenCalled();
  expect(marcar).not.toHaveBeenCalled();
  expect(rpcs.map((r) => r.fn)).not.toContain("fn_mark_conversation_message");
});
it("reprocessar o mesmo chunk não duplica (23505 é ok) e devolve ok", async () => {
  insertErro = { code: "23505", message: "dup" };
  expect(await processarChunkDeHistorico(LINHA, admin)).toMatchObject({ status: "ok" });
});
it("mídia dos últimos 14 dias pede media.persist_requested; mais velha vira midia_indisponivel", async () => { /* duas mensagens image, timestamps 3 dias e 40 dias */ });
it("progresso vai para metadata.coexistencia.historico; progresso 100 marca concluido", async () => { /* updates no channel_sessions.metadata */ });
it("erro 2593109 grava historico.erro com a frase do celular", async () => { /* payload.erro_codigo 2593109 → historico.erro match /não compartilhou/ */ });
it("sessão arquivada/ausente → skipped", async () => {});
```

- [ ] **Step 4:** worker:

```ts
// workers/meta-history-worker.ts
/**
 * Processa um pedaço do histórico do celular (`history`, coexistência).
 *
 * O que NÃO faz, de propósito: IA, lead, automação, notificação, carimbo da
 * conversa (`fn_mark_conversation_message` mexeria em `last_inbound_at`, que
 * é a janela de 24 h — a Meta não honra janela aberta por mensagem anterior ao
 * onboarding — e em não-lidas). O gatilho do banco é desarmado pela marca
 * `metadata.importada_do_historico` (migration 0294).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { encontrarContatoPorTelefone } from "@/lib/channels/contato-por-telefone";
import { gravarCoexistencia } from "@/lib/channels/meta/conectar-canal-oficial";
import { lerCoexistencia, mensagemDoErroDaMeta } from "@/lib/channels/meta/coexistencia";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const META_HISTORY_CONSUMER_KEY = "meta-history-worker";
const JANELA_DE_MIDIA_MS = 14 * 24 * 60 * 60 * 1000;

interface MensagemCrua { id?: string; from?: string; to?: string; timestamp?: string; type?: string; text?: { body?: string }; [k: string]: unknown }

function digitos(v: unknown): string { return typeof v === "string" ? v.replace(/\D/g, "") : ""; }

export async function processarChunkDeHistorico(row: EventRow, admin: SupabaseClient = createAdminClient()): Promise<HandlerResult> {
  const orgId = row.organization_id;
  const sessionId = row.entity_id;
  const p = row.payload as { phone_number_id?: string; fase?: number | null; progresso?: number | null; erro_codigo?: number | null; value?: Record<string, unknown> };
  if (!sessionId) return { consumer_key: META_HISTORY_CONSUMER_KEY, status: "skipped", detail: "sem_sessao" };

  const { data: sessao } = await admin.from("channel_sessions").select("id, phone_number, metadata, archived_at").eq("organization_id", orgId).eq("id", sessionId).maybeSingle();
  if (!sessao || (sessao as { archived_at?: string | null }).archived_at) return { consumer_key: META_HISTORY_CONSUMER_KEY, status: "skipped", detail: "sessao_arquivada" };
  const numeroDoNegocio = digitos((sessao as { phone_number: string | null }).phone_number);
  const agora = Date.now();

  let gravadas = 0, duplicadas = 0;
  const threads = Array.isArray((p.value?.history as Array<Record<string, unknown>> | undefined)?.[0]?.threads)
    ? ((p.value!.history as Array<Record<string, unknown>>)[0]!.threads as Array<Record<string, unknown>>)
    : [];
  for (const thread of threads) {
    const chatId = digitos(thread.id);
    if (!chatId || thread.id && String(thread.id).endsWith("@g.us")) continue; // grupos: a Cloud API não entrega em coexistência
    const existente = await encontrarContatoPorTelefone(admin as never, orgId, chatId);
    const phone = existente?.phone_number ? canonicalPhoneBR(existente.phone_number) : canonicalPhoneBR(`+${chatId}`);
    const { data: contactId } = await admin.rpc("fn_upsert_wa_contact" as never, { p_org: orgId, p_kind: "phone", p_phone: phone, p_lid: null, p_chat_id: chatId, p_notify: null } as never);
    if (!contactId) continue;
    const { data: conversationId } = await admin.rpc("fn_upsert_wa_conversation" as never, { p_org: orgId, p_contact: contactId as string, p_session: sessionId } as never);
    if (!conversationId) continue;

    for (const m of (Array.isArray(thread.messages) ? thread.messages : []) as MensagemCrua[]) {
      if (!m.id) continue;
      const outbound = digitos(m.from) === numeroDoNegocio;
      const sentAt = new Date(Number(m.timestamp ?? "0") * 1000);
      const tipo = m.type ?? "unknown";
      const corpoMidia = tipo !== "text" ? (m[tipo] as { id?: string; mime_type?: string } | undefined) : undefined;
      const temMidia = Boolean(corpoMidia?.id);
      const midiaRecente = temMidia && agora - sentAt.getTime() <= JANELA_DE_MIDIA_MS;
      const { data: inserida, error } = await admin.from("messages").insert({
        organization_id: orgId, conversation_id: conversationId as string, channel_session_id: sessionId, contact_id: contactId as string,
        direction: outbound ? "outbound" : "inbound", status: outbound ? "sent" : "delivered",
        ...(outbound ? { sent_via: "external_device" } : {}),
        type: tipo === "contacts" ? "contact" : tipo, body: tipo === "text" ? (m.text?.body ?? null) : null,
        external_id: m.id, media_url: midiaRecente ? `meta-media:${corpoMidia!.id}` : null, media_mime: corpoMidia?.mime_type ?? null,
        sent_at: sentAt.toISOString(),
        metadata: { importada_do_historico: true, origem: outbound ? "celular" : "contato", ...(midiaRecente ? { meta_media_id: corpoMidia!.id } : temMidia ? { midia_indisponivel: true } : {}) },
      }).select("id").maybeSingle();
      if (error) { if (error.code === "23505") { duplicadas += 1; continue; } return { consumer_key: META_HISTORY_CONSUMER_KEY, status: "error", detail: error.message }; }
      gravadas += 1;
      const messageId = (inserida as { id: string } | null)?.id;
      if (midiaRecente && messageId) {
        await admin.rpc("emit_event" as never, { p_event_type: "media.persist_requested", p_entity_kind: "message", p_entity_id: messageId,
          p_payload: { message_id: messageId, conversation_id: conversationId }, p_metadata: { source: "meta_history" }, p_organization_id: orgId } as never);
      }
    }
    // Só a ordenação/prévia da lista, e só se o histórico for mais novo que o que já há.
    // NÃO passa por fn_mark_conversation_message (last_inbound_at, não-lidas).
    await atualizarPreviaSeMaisNova(admin, orgId, conversationId as string, thread);
  }

  const coex = lerCoexistencia((sessao as { metadata?: unknown }).metadata);
  if (coex) {
    const erro = p.erro_codigo ? mensagemDoErroDaMeta(p.erro_codigo, null, `erro ${p.erro_codigo}`) : coex.historico?.erro ?? null;
    await gravarCoexistencia(admin, orgId, sessionId, { ...coex, historico: { fase: p.fase ?? null, progresso: p.progresso ?? null, concluido: (p.progresso ?? 0) >= 100, erro } });
  }
  logger.info("[meta.history] chunk processado", { organization_id: orgId, session: sessionId, gravadas, duplicadas, fase: p.fase, progresso: p.progresso });
  return { consumer_key: META_HISTORY_CONSUMER_KEY, status: "ok", detail: `gravadas=${gravadas} duplicadas=${duplicadas}` };
}
```

`atualizarPreviaSeMaisNova`: lê `last_message_at` da conversa; se a última mensagem da thread (maior `timestamp`) é mais nova, `update { last_message_at, last_message_preview }` filtrando `organization_id` e `id`. Handler:

```ts
// workers/meta-history-worker.handler.ts
import type { EventHandler } from "@/lib/event-log/dispatcher";
import { META_HISTORY_CONSUMER_KEY, processarChunkDeHistorico } from "@/workers/meta-history-worker";
export const metaHistoryHandler: EventHandler = { key: META_HISTORY_CONSUMER_KEY, events: ["meta.history_chunk"], handle: (row) => processarChunkDeHistorico(row) };
```

`registerHandler(metaHistoryHandler)` em `register-handlers.ts` (depois de `mediaDeriveHandler`). Rota do webhook, ramo `history_chunk`:

```ts
    if (e.kind === "history_chunk") {
      const { error } = await admin.rpc("emit_event" as never, {
        p_event_type: "meta.history_chunk", p_entity_kind: "channel_session", p_entity_id: session.id,
        p_payload: { phone_number_id: e.phoneNumberId, fase: e.fase, progresso: e.progresso, chunk_order: e.chunkOrder, erro_codigo: e.erroCodigo, value: e.bruto },
        p_metadata: { source: "meta_webhook", request_id: requestId }, p_organization_id: session.organizationId,
      } as never);
      desfechos.push(error ? "history:falhou_enfileirar" : "history:enfileirado");
      if (error) logger.error("[meta.webhook] history_chunk não enfileirado", { request_id: requestId, error: error.message });
      continue;
    }
```

- [ ] **Step 5:** `pnpm vitest run workers/meta-history-worker.test.ts tests/unit/webhook-meta-le-do-banco.test.ts tests/unit/cron-audita-so-quando-ha-efeito.test.ts` → passed; `pnpm test:db` → verde com o invariante novo; `pnpm lint:channels` (o worker fica em `workers/`, que o lint varre: nenhum nome de provider nele — `meta` sozinho não está no padrão; `meta_cloud` fica em `lib/channels`).

- [ ] **Step 6:** commit:

```bash
git add supabase/migrations/20261006120000_0294_historico_importado_nao_emite_evento.sql supabase/baseline.sql supabase/migrations/MANIFEST.md workers/meta-history-worker.ts workers/meta-history-worker.handler.ts workers/meta-history-worker.test.ts lib/event-log/register-handlers.ts "app/api/v1/webhooks/meta/[token]/route.ts" tests/invariants/historico-importado-nao-emite-evento.test.ts
git commit -m "feat(canal-oficial): histórico do celular entra por event_log, idempotente, sem IA/lead/automação e sem abrir janela (0294)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 12: Contatos do celular (`smb_app_state_sync`) e barra de progresso na aba

**Files:**
- Create: `lib/channels/meta/contatos-do-celular.ts`
- Modify: `app/api/v1/webhooks/meta/[token]/route.ts` (ramo `state_sync`), `components/connections/CadastroIncorporado.tsx`, `lib/i18n/dicionario.ts`
- Test: `lib/channels/meta/contatos-do-celular.test.ts`, `tests/unit/cadastro-incorporado-progresso.test.tsx`

**Interfaces:**
- `export async function upsertContatosDoCelular(admin: SupabaseClient, organizationId: string, contatos: Array<{ waId: string; nome: string | null }>): Promise<{ processados: number }>` — chama `fn_upsert_wa_contact` com `p_notify = nome`. **A regra "preenche só quando vazio" já é a da RPC** (`display_name = coalesce(display_name, nullif(p_notify,''))`, `supabase/baseline.sql:13559`); não há segunda regra em TypeScript.

- [ ] **Step 1:** teste: 2 contatos → 2 chamadas a `fn_upsert_wa_contact` com `p_notify` = nome e `p_chat_id` = waId; nome `null` passa `null`; erro numa RPC não interrompe as demais (log) e conta só os ok. Mais um teste de contrato, lendo o `baseline.sql` e afirmando que a definição em vigor de `fn_upsert_wa_contact` contém `coalesce(display_name, nullif(p_notify, ''))` — é o que sustenta "nunca sobrescreve nome editado".

- [ ] **Step 2:** implementação (≈25 linhas) + ramo na rota: `if (e.kind === "state_sync") { const r = await upsertContatosDoCelular(admin, session.organizationId, e.contatos); desfechos.push(\`contatos:${r.processados}\`); continue; }`.

- [ ] **Step 3:** UI — no card do `CadastroIncorporado`, quando `estado.coexistencia` existe:

```tsx
{coex?.historico && !coex.historico.erro ? (
  <div className="mt-3" data-testid="historico-progresso">
    <p className="text-sm">{coex.historico.concluido ? t("Histórico importado.") : t("Importando histórico…")} {coex.historico.progresso ?? 0}%</p>
    <progress className="mt-1 h-2 w-full" max={100} value={coex.historico.progresso ?? 0} aria-label={t("Progresso da importação do histórico")} />
  </div>
) : null}
{coex?.historico?.erro ? <p className="mt-2 text-sm text-destructive" data-testid="historico-erro">{coex.historico.erro}</p> : null}
```

`useOfficialChannel` com `refetchInterval: 5_000` enquanto `coexistencia?.historico && !concluido` (no `useQuery`, `refetchInterval: (q) => precisaAcompanhar(q.state.data) ? 5_000 : false`). Teste de render (`@testing-library/react`, como `canal-oficial-aviso-de-recebimento.test.tsx`): progresso 20 → barra com `value=20` e texto "Importando histórico… 20%"; `concluido` → "Histórico importado."; `erro` → texto do erro.

- [ ] **Step 4:** espanhol; `pnpm vitest run lib/channels/meta/contatos-do-celular.test.ts tests/unit/cadastro-incorporado-progresso.test.tsx tests/unit/i18n-espanhol-cobre-a-tela.test.ts tests/unit/controle-decorativo.test.ts` → passed.

- [ ] **Step 5:** commit:

```bash
git add lib/channels/meta/contatos-do-celular.ts lib/channels/meta/contatos-do-celular.test.ts "app/api/v1/webhooks/meta/[token]/route.ts" components/connections/CadastroIncorporado.tsx hooks/channels/useOfficialChannel.ts lib/i18n/dicionario.ts tests/unit/cadastro-incorporado-progresso.test.tsx
git commit -m "feat(canal-oficial): contatos do celular preenchem só nome vazio; barra de progresso do histórico na aba

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 13: E2E do histórico, mapa vivo e fragmento (Parte B)

**Files:**
- Modify: `tests/e2e/cadastro-incorporado.spec.ts`, `docs/architecture/cadastro-incorporado.architecture.json`, `docs/testing/user-journey-map.md`
- Create: `.changes/coexistencia-historico.md`

- [ ] **Step 1:** segundo teste na spec: depois de conectar, enviar ao webhook da sessão (`/api/v1/webhooks/meta/<token>`, token lido pela API `GET /api/v1/channels/official` → `webhook.callbackUrl`) o fixture de `history` assinado com HMAC SHA-256 do `APP_SECRET` do seed (molde: `instagram-receber.spec.ts`), chamar o drain (`POST /api/v1/cron/event-log-drain` com `Bearer INTERNAL_CRON_SECRET`, como as specs de follow-up fazem), e afirmar pela tela: `historico-progresso` mostra "20%", e o Inbox mostra a conversa com a mensagem "olá" rotulada "Celular" e "oi" sem não-lida (`unread_count_for_assignee` não sobe: conferir que a conversa não aparece com badge de não-lida). Terceiro teste: fixture de `account_update PARTNER_REMOVED` → Central mostra o aviso "foi desconectado pelo celular"; `ACCOUNT_RECONNECTED` → aviso some.

- [ ] **Step 2:** arestas novas no mapa (webhook → `event_log meta.history_chunk` → worker → `messages`; gatilho com guarda). Jornada no mapa de jornadas. Fragmento:

```md
---
impacto: capacidade_nova
secao: adicionado
titulo: O histórico do celular entra no CRM depois de conectar em coexistência
---

Até 180 dias de conversas do WhatsApp Business do celular aparecem no Inbox depois
da conexão pelo botão, com barra de progresso na aba Conexões. Nada disso acorda a
IA, cria lead, dispara automação ou abre janela de 24 horas. Mídia só dos últimos
14 dias. Os nomes dos contatos do celular preenchem apenas quem ainda não tinha nome.
```

- [ ] **Step 3:** `pnpm test:e2e tests/e2e/cadastro-incorporado.spec.ts` → 3 passed; `pnpm gov:verify`; `pnpm test:db`; `pnpm release:conferir`. Commit:

```bash
git add tests/e2e/cadastro-incorporado.spec.ts docs/architecture/cadastro-incorporado.architecture.json docs/testing/user-journey-map.md .changes/coexistencia-historico.md
git commit -m "test(e2e): histórico, contatos e desconexão da coexistência provados pela tela; fragmento de release

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Abrir o PR 2. **Só depois do merge do PR 2 em produção** acontece o dia da conexão (spec §Entrega, item 3).

---

## Dúvidas e lacunas encontradas lendo o código (para o dono decidir antes de executar)

1. **Helper de silêncio: a spec manda extrair de `messages/_handler.ts:276`; o repo já tem o helper certo.** `pausarIaPorAtendimentoManual` (`lib/escalacao/atendimento-manual.ts`) é a regra do `fromMe` do WAHA — mesmo gesto (resposta pelo celular), mesmos 5 minutos, renovação a cada mensagem, nunca encurta `'infinity'`, e ainda grava `last_handoff_at`/`last_handoff_reason`. `extendBotSilence` do composer é o mesmo valor em outro lugar. O plano usa o existente (Task 7) e NÃO cria um terceiro; se o dono quiser unificar o composer também, é refactor separado.
2. **O gatilho do banco acorda a IA mesmo que o worker não.** `trg_messages_emit_event` emite `message.received` em todo insert inbound; IA, sentimento, follow-up, push e automação consomem. A spec não menciona isso. A Task 11 põe a guarda no gatilho (migration 0294, PR 2) — sem ela a promessa "sem IA, sem automação" seria falsa.
3. **`fn_mark_conversation_message` não serve ao histórico.** Além de `last_inbound_at`, ela incrementa `unread_count_for_assignee` e mexe em `awaiting_since` (a régua da Fila, 0290). O worker não a chama e só atualiza prévia/ordem quando o histórico é mais novo que o que há.
4. **`status` "failed" da spec = `FAILED`.** CHECK `channel_sessions_status_check` só aceita maiúsculas.
5. **Rate limit na rota nova.** Não existe helper genérico de rate limit para rotas no repo (`lib/auth/rate-limit.ts` é só do login; `grep -rn "X-RateLimit" app/api/v1` vazio). O plano não inventa um: a rota exige `admin` + `requireSupportWrite`, e o `code` é de uso único com 30 s. Se o dono quiser, vira item próprio.
6. **Códigos de erro da Meta: `code` ou `error_subcode`?** A página de erros não diz em qual campo cada número chega; `mensagemDoErroDaMeta` consulta os dois. Conferir no primeiro erro real.
7. **Formato dos payloads de coexistência.** As fixtures da Task 6 vêm da documentação, não de um payload real (o repo só tem `inbound-webhooks.json` reais). Trocar pelo real no dia da conexão; o parser é tolerante (campo que faltar vira `null`, nunca throw).
8. **`conferirNumeroDaConta` dentro de `conectarCanalOficial`** repete a chamada `GET /{waba}/phone_numbers` que a rota nova já fez. Custo: uma chamada a mais, uma vez por conexão. Deixado assim para o caminho de gravação ser literalmente o mesmo do formulário.
9. **Sem `register` em coexistência está certo; para número NOVO (`FINISH`) o PIN cifrado vai para `metadata.pin_cifrado`.** A spec diz "guardado cifrado" sem dizer onde; não há coluna e criar uma por um caso que o EvaLink não vai usar agora é DIRC falhando. Se o dono preferir coluna, é uma linha a mais na 0293.
10. **`META_GRAPH_BASE_URL` é novo** (só loopback em produção, molde do Instagram). Entra para o e2e poder simular a Graph, como a spec pede; sem ele o e2e teria de bater na Meta real.
11. **O número da clínica hoje é WAHA.** `arquivarSessaoLegadaDoNumero` arquiva pelo `phone_number` igual; se a linha WAHA tiver o número em grafia diferente (`+55…` vs sem `+`), não casa. `channel_sessions.phone_number` do WAHA é gravado por `canonicalPhoneBR`; `conectarCanalOficial` grava `+${digits}`. Conferir no dia com `select phone_number, provider from channel_sessions where organization_id = …`.
