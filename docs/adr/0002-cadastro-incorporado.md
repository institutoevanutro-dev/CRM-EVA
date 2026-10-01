# ADR-0002 — Cadastro Incorporado da Meta, com coexistência

- **Status:** aceito
- **Data:** 2026-10-01
- **Revisa:** a seção "Embedded Signup não cabe em self-host" de
  [`docs/doctrine/restricao-de-canal.md`](../doctrine/restricao-de-canal.md)
- **Mapa vivo:** [`docs/architecture/cadastro-incorporado.architecture.json`](../architecture/cadastro-incorporado.architecture.json)

---

## Contexto

Em 2026-07-30 a doutrina de canal registrou que o Cadastro Incorporado (Embedded Signup) não
cabe em self-host: ele é a ferramenta de quem onboarda OUTRAS empresas (Tech Provider), e exigir
isso de cada instalação, ou centralizar o projeto como Tech Provider, quebra o modelo. A resposta
foi o BYO: o self-hoster cria o próprio app e cola as credenciais.

O argumento continua valendo para o produto aberto. O que mudou é que existe uma instalação que
**já é** Tech Provider: no EvaLink, a instalação usa o app de Tech Provider do próprio EvaLink
(app `1054112660758768`). Para ela, pedir ao cliente que crie app e cole token é atrito sem
motivo — e o cliente típico (clínica) quer manter o número no WhatsApp Business do celular, que
é exatamente o que a coexistência da Meta permite.

## Decisões

### D1 — O botão é opcional e ligado pelo banco; o BYO continua sendo o padrão

A configuração mora em `platform_meta_app` (migration 0296): `app_id` e `es_config_id`, ao lado
do par de segredos que já estava ali. `es_config_id` vazio = o botão não aparece, e o formulário
manual (BYO) segue como sempre. Nada muda para quem não configura.

### D2 — Identificadores públicos caem no `.env` um a um; o par de segredos não

`appDaMeta()` (`lib/channels/meta/app.ts`) serve o PAR `app_secret`/`verify_token` inteiro de
uma fonte só (banco, ou `.env` inteiro), porque meio par é um app que não existe. Já `appId` e
`esConfigId` **caem no `.env` cada um sozinho**: são públicos, não formam par, e App ID no banco
com Configuration ID só no `.env` é configuração válida. É desvio consciente do "mesmo padrão de
par" da spec §1 (ruling P15e).

`META_ES_CONFIG_ID` e `META_GRAPH_BASE_URL` existem só em `.env.example` e são lidos de
`process.env`, como `META_APP_SECRET` — não entram em `lib/env.ts`. `META_GRAPH_BASE_URL` só é
honrado em loopback em produção (`lib/channels/meta/graph-base.ts`): existe para o e2e.

### D3 — Coexistência é metadado da sessão, não provider novo

A sessão continua `meta_cloud` e é gravada pelo MESMO `conectarCanalOficial` do formulário
manual. A coexistência fica em `channel_sessions.metadata` (`cadastro_incorporado`,
`coexistencia`). Em coexistência a rota **não** chama `/register` — o número continua registrado
no aplicativo do celular; pede contatos e histórico por `smb_app_data`, e falha nesse pedido não
desfaz a conexão (há 24 h para repetir, rota `/sincronizar`).
Enquanto `SINCRONIZACAO_TEM_CONSUMIDOR` (`lib/channels/meta/coexistencia.ts`) for `false` — a
Parte A, em que o webhook ainda responde "ignorado" a `history`/`smb_app_state_sync` — **nenhum**
`smb_app_data` é enviado: os pedidos ficam nulos e a tela avisa para não conectar o número em uso.
O histórico é um pedido único de 24 h; pedi-lo sem consumidor o perderia. Para conferir:
`grep -n 'SINCRONIZACAO_TEM_CONSUMIDOR' lib/channels/meta/coexistencia.ts`.

A sessão por QR do mesmo número é arquivada **só no banco** antes da gravação (o índice
`(organization_id, phone_number)` exige) e desarquivada se a gravação falhar; logout/delete no
transporte legado só depois da oficial gravada.

### D4 — O que o celular faz chega pelo webhook

- Resposta dada pelo celular (`smb_message_echoes`) entra como mensagem de saída `external_device`
  (a bolha diz Celular) e silencia a IA por `pausarIaPorAtendimentoManual` — a mesma regra de 5 min do
  `fromMe` do WAHA.
- Desconexão pelo celular (`account_update`) passa por `aplicarEventoDaConta`
  (`lib/channels/meta/saude-da-conta.ts`) e abre aviso na Central.
- O histórico importado chega em lotes e é processado por `event_log` + worker, nunca dentro do
  webhook.

## Consequências

- **Limite da Meta:** sem verificação de negócio do Tech Provider, 10 clientes novos por janela
  de 7 dias.
- **Webhook fora do ar perde histórico:** o histórico chega pelo webhook; o que a Meta não
  conseguir entregar não é reconstruído pelo CRM.
- **A sessão por QR do mesmo número cai:** a Meta desconecta os aparelhos vinculados no
  onboarding. A rota arquiva a sessão legada do número antes de gravar a oficial.
- Quando a credencial gravada na sessão não decifra, a mensagem fica na fila (`queued`) e nunca
  sai pela conta do `.env`; o problema aparece no aviso de saúde do canal (Task 9).

## Recusados

| Recusado | Por quê |
|---|---|
| Provider novo `meta_coex` | duplicaria envio, saúde, templates e webhook para um comportamento que cabe em metadado |
| Extrair um segundo helper de silêncio para o eco | `pausarIaPorAtendimentoManual` já é a regra; duas regras divergem |
| Chamar `/register` em coexistência "por garantia" | registraria o número na Cloud API e o tiraria do aplicativo do celular — o contrário do que o cliente pediu |
