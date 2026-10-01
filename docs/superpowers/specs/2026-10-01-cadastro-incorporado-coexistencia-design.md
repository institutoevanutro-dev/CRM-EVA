# Cadastro Incorporado v4 com coexistência — desenho

Data: 2026-10-01 · Dono: André · Prazo duro: **15/10/2026** (a Meta desliga o Embedded Signup v2; a v3 sai no mesmo mês)

## Objetivo

O número da clínica (+55 27 99904-9879, org Instituto) passa a falar pela **WhatsApp Cloud API sem sair do WhatsApp Business do celular** (coexistência), conectado por um botão no CRM. O mesmo botão serve às clínicas clientes do EvaLink a partir da semana seguinte, sem retrabalho: a configuração vive no banco da instalação, não no código.

Critérios de sucesso:

1. Um admin clica em **Conectar WhatsApp** (Conexões › API Oficial), conclui o fluxo da Meta e o canal oficial da organização fica **Conectado** — sem colar token, WABA ou phone number id.
2. Mensagem recebida chega ao CRM pela Cloud API; mensagem enviada pelo CRM sai pela Cloud API.
3. Mensagem enviada **pelo celular** aparece na conversa como enviada ("pelo celular") e silencia a IA naquela conversa.
4. O histórico de até 180 dias do celular entra no CRM sem acordar IA, sem criar lead, sem automação e sem duplicar.
5. Desconexão pelo celular aparece na tela e abre aviso na Central.

Fora do escopo: o número profissional do André (99865-9879), onboarding de clientes em escala (limite de 10 por 7 dias da Meta), grupos (a Cloud API não os entrega em coexistência), migração das conversas antigas do WAHA para o canal oficial.

## Decisões tomadas com o André (01/10/2026)

| Pergunta | Decisão |
|---|---|
| Só a clínica ou clientes também? | Só a clínica agora; desenho já serve aos clientes |
| Importar o histórico? | Sim (até 180 dias), sem IA, sem lead |
| Resposta pelo celular e a IA | Silencia a IA na conversa — **mesma regra do envio manual pelo CRM** (`HUMAN_REPLY_SILENCE_MS`, janela de 5 min renovada a cada mensagem humana, `app/api/v1/messages/_handler.ts:276`) |
| Abordagem | Estender o canal oficial existente (`meta_cloud`); o formulário manual (BYO) fica como reserva |

## Fatos da Meta que o desenho respeita

Fonte: documentação de 01/10/2026 (`developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/…`: `version-4`, `implementation`, `onboarding-business-app-users`, `onboarding-customers-as-a-tech-provider`, `errors`).

- **v4 vem da configuração, não do código**: App Dashboard › Facebook Login for Business › Configurations › variação *Embedded Signup* com o produto Cloud API → `config_id`. `extras` só leva `setup` e o tipo de recurso de coexistência (`whatsapp_business_app_onboarding`). A grafia exata do parâmetro na v4 (`featureType` × `feature_type`) **deve ser conferida na tela do passo 2 da documentação de coexistência antes de codar** — o `.md` publicado omite o trecho. Sintoma de grafia errada: erro **3441030** (entrou pelo fluxo normal).
- **Código de troca vive 30 s**: o front envia `code` ao servidor imediatamente; o servidor troca em `GET /oauth/access_token?client_id&client_secret&code`, recebendo o **token do system user de integração do negócio** (escopado ao cliente).
- **Coexistência não chama `/register`** (o número já está registrado no app). Evento de sucesso: `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, cujo `data` pode trazer só `waba_id` → o `phone_number_id` vem de `GET /{waba_id}/phone_numbers`; conferir `is_on_biz_app: true`.
- **Sincronização, uma vez cada, até 24 h após o onboarding**: `POST /{phone_number_id}/smb_app_data` com `sync_type` `smb_app_state_sync` (contatos) e `history`. Passadas 24 h sem pedir, o cliente precisa sair e refazer o fluxo.
- **Webhooks novos**: `history` (em pedaços: `chunk_order`, `phase`, `progress`; mídia só dos últimos 14 dias; erro 2593109 = negócio recusou compartilhar), `smb_app_state_sync`, `smb_message_echoes`, `account_update` (`PARTNER_REMOVED` + `disconnection_info.reason`), `account_offboarded`, `account_reconnected`.
- **Teste antes da aprovação do App Review**: possível para quem tem papel admin/developer/tester no app 1054112660758768 (o André é admin).
- **Efeitos colaterais**: todos os aparelhos vinculados são desconectados no onboarding (o **WAHA cai sozinho** para esse número); throughput fixo de 20 mps; sem grupos; janela de 24 h só abre com mensagem recebida após o onboarding.

## Desenho

### 1. Configuração da instalação

- `platform_meta_app` (singleton, só service_role) ganha `app_id text` e `es_config_id text` (migration nova + apêndice idempotente no `baseline.sql` + MANIFEST). Nenhum dos dois é segredo; o `app_secret` já existe ali (`lib/channels/meta/app.ts`).
- `appDaMeta()` passa a devolver `appId` e `esConfigId`; banco acima do `.env` (`META_APP_ID`, `META_ES_CONFIG_ID` como piso, mesmo padrão de par do arquivo).
- `updateMetaApp` + tela `app/admin/(protected)/meta/` ganham os dois campos (platform admin). Sem os dois, o botão não aparece e a aba diz o que falta (doutrina "toda configuração tem superfície").

### 2. Botão e troca do código

- Componente cliente em `components/connections/` chama um módulo de `lib/channels/meta/` que carrega o SDK, faz `FB.init` (`appId`, versão da Graph de `lib/graph-version.ts`) e `FB.login({ config_id, response_type: "code", override_default_response_type: true, extras: { setup: {}, <tipo de coexistência> } })`, escutando `message` de origem `*.facebook.com` com `type === "WA_EMBEDDED_SIGNUP"`. Nome de provider e domínio da Meta só dentro de `lib/channels/meta/` (`scripts/lint-channels.ts`).
- Front envia `{ code, evento, waba_id, phone_number_id? }` a `POST /api/v1/channels/official/cadastro-incorporado` (rota nova). Guardas: `requireSupportWrite` + `requireRole("admin")`, Zod, rate limit.
- Servidor, em `lib/channels/meta/cadastro-incorporado.ts`:
  1. troca o `code` (30 s); valida o token com `debug_token` (app e escopo esperados);
  2. resolve o `phone_number_id` por `GET /{waba}/phone_numbers` quando não vier, confere `is_on_biz_app` para coexistência;
  3. evento `FINISH` (número novo, sem coexistência): `POST /{phone}/register` com PIN gerado e guardado cifrado; evento de coexistência: **não registra**;
  4. reaproveita o caminho do POST oficial atual: `validateMetaCredentials`, `conferirNumeroDaConta`, cifra (`encryptWebhookSecret`, recusa sem cifra), `reactivateChannelSession`/insert, `assinarWebhookDaConta` (com `override_callback_uri` por sessão), `metadata.webhook_da_conta`;
  5. coexistência: chama `smb_app_data` (contatos, depois histórico) e grava em `channel_sessions.metadata.coexistencia` `{ onboarding_em, pedidos: { contatos: request_id|erro, historico: request_id|erro }, historico: { fase, progresso } }`;
  6. arquiva a sessão WAHA ativa da mesma org com o mesmo número (a Meta já a desconectou), sem apagar conversas;
  7. `audit` (`channel.official_connected_es`, sem token nem PIN).
- Falha no passo 5 não desfaz a conexão: a aba mostra "Importação do histórico não foi pedida — tentar de novo (até HH:MM)" com botão que chama `POST …/cadastro-incorporado/sincronizar` (admin), respeitando o prazo de 24 h.
- Erros conhecidos da Meta viram mensagens em português na tela: 3441030, 3441041 (número preso em outra WABA — o caso da tentativa de 23/09), 3441042, 3441045, 2655093/3441049/2655094 (ligado a outro parceiro: desconectar no app e esperar 15 min), 4563015 (app desatualizado).

### 3. Webhooks da coexistência

Entram pelo webhook existente (`app/api/v1/webhooks/meta/[token]`, HMAC já validado). O parser puro (`lib/channels/meta/webhook.ts`) ganha os campos novos; o envelope continua loose.

- **`smb_message_echoes`** → mensagem `direction: "outbound"`, `metadata.origem = "celular"`, idempotente por `(organization_id, external_id)`. Caminho próprio no ingest que **não** chama `aplicarEfeitosPosEntrada` (sem IA, sem lead) e aplica o mesmo silêncio do envio manual (`bot_silenced_until = now + HUMAN_REPLY_SILENCE_MS`, extraído para um helper compartilhado com `messages/_handler.ts`). Atualiza a atividade da conversa sem marcar como não lida.
- **`history`** → a rota só grava o pedaço cru numa fila (`event_log` com `event_type = "meta.history_chunk"`, payload referenciando a sessão) e responde 200; um worker processa: direção pela origem (`from` = número do negócio → outbound), `sent_at` do timestamp original, idempotente por `external_id`, sem IA, sem lead, sem automação, sem notificação, sem mexer em `last_inbound_at` (não pode abrir janela de 24 h). Mídia dos últimos 14 dias pede `media.persist_requested`; mais antiga vira "mídia não disponível". Atualiza `metadata.coexistencia.historico` com `fase`/`progresso`. Erro 2593109 registra "o celular não compartilhou o histórico".
- **`smb_app_state_sync`** → upsert de contato: preenche nome só quando vazio no CRM; nunca sobrescreve nome editado.
- **`account_update` (`PARTNER_REMOVED`) / `account_offboarded`** → sessão vai a `failed` via `sincronizarSaudeDaConexao`, com motivo legível do `disconnection_info.reason`, e abre aviso na Central (`agent_inbox_items`). **`account_reconnected`** → volta a conectada e fecha o aviso.
- `fields` exibidos/assinados (`official/route.ts:187`) passam a incluir os novos.

### 4. Capacidades

`lib/channels/capabilities.ts`: a sessão `meta_cloud` em coexistência declara grupos indisponíveis (já é verdade para `meta_cloud`) e nada mais muda na matriz; a coexistência é **metadado da sessão**, não provider novo. Teste da matriz continua cobrindo.

### 5. Doutrina

ADR `docs/adr/0002-cadastro-incorporado.md` revisa `docs/doctrine/restricao-de-canal.md:199-230` ("Embedded Signup não cabe em self-host"): no EvaLink a instalação usa o app de Tech Provider da Meta do EvaLink; o caminho BYO segue como reserva e como padrão do produto aberto quando `es_config_id` está vazio. A doutrina ganha o apontamento para o ADR.

## Erros e bordas

- Sem cifra disponível → recusa gravar (como hoje).
- Número já ativo em outra organização → recusa (índice único `meta_phone_number_id` ativo).
- Segunda conexão na mesma org → reaproveita a sessão oficial existente (uma por org, como hoje).
- `resolveMetaCreds` **não** cai no `.env` quando a sessão tem token próprio e a decifra falha: lança (evita enviar pela conta errada).
- Webhook fora do ar durante a sincronização perde o histórico (limitação da Meta); por isso o PR do histórico entra em produção **antes** da conexão real.

## Testes

- Unit: troca do código (sucesso, código vencido, token de outro app), escolha `register` × coexistência, pedido `smb_app_data` e prazo de 24 h, parser dos campos novos, echo (outbound, sem IA, silencia a conversa), histórico (idempotente, sem IA/lead/automação, não abre janela), contato que não sobrescreve nome, desconexão → `failed` + aviso, reconexão.
- Invariante (`test:db`): coluna nova de `platform_meta_app` sem grant a anon/authenticated.
- E2E: a aba com o botão, `FB` simulado devolvendo `code` + evento de coexistência, rota de troca com Graph simulado → "Conectado" e "Importando histórico".
- Prova real: conexão do número da clínica com o André (tester do app), conferida no inbox.

## Entrega

1. **PR 1 (até ~08/10)**: configuração (1), botão + troca (2), echoes + desconexão (3, parcial), ADR (5).
2. **PR 2 (antes da conexão real)**: histórico + contatos (3), barra de progresso.
3. **Dia da conexão**: backup do banco; conferir/remover o número da WABA "Instituto Eva" (`1042637105315427`, Offline desde 23/09) se der 3441041; André com o celular da clínica e o app aberto até o histórico terminar; configurar no App Dashboard o `config_id` e os campos de webhook novos (passo a passo guiado).
