# Instagram Direct no CRM (e, depois, Messenger)

Data: 2026-09-24 · Pedido: reunião de marketing de 23/09/2026 ("integrar Instagram Direct e Facebook Messenger ao CRM") · Aprovado em conversa com o dono do produto em 24/09/2026.

## 1. Objetivo

A equipe atende o Direct do Instagram **de dentro do CRM**, no mesmo Inbox, funil, campos e respostas rápidas do WhatsApp. Nenhum contato que chega pelo Instagram se perde, e a origem dele já nasce registrada para o relatório de conversão.

Critério de sucesso: uma mensagem enviada ao Direct de @dr.andreluisc ou de @instit.eva aparece no Inbox do org "Instituto EVA CRM" em segundos, vira card em "Novo lead – interagir" com a Origem preenchida, e a equipe responde dali sem abrir o Instagram.

## 2. Decisões já tomadas

| Decisão | Escolha | Por quê |
|---|---|---|
| Profundidade | Integração completa (ver e responder no CRM) | escolha do dono; o card-só-aviso foi recusado |
| Ordem | Instagram primeiro; Messenger por último | foco da estratégia nova é o perfil do Dr. André |
| Contas | @dr.andreluisc **e** @instit.eva, as duas no org "Instituto EVA CRM" | o perfil do Dr. André recebe muito lead, e quem atende é a equipe |
| Forma | Novo canal dentro da arquitetura de canais existente | reusa Inbox, funil, follow-up; caixa separada e intermediário pago foram recusados |
| Acesso Meta | Instagram API with Instagram Login, **Standard Access** | contas próprias não exigem App Review ([Send Messages](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/)) |

## 3. Fora de escopo

- Comentários, menções e Stories (só Direct).
- Mensagens para quem nunca escreveu ao perfil (a Meta não permite).
- Junção automática de contatos entre canais: a junção é manual, pelo "juntar contatos" que já existe.
- Embedded Signup / coexistência (outra frente).

## 4. Regras da Meta que o produto respeita

- **24h:** resposta livre até 24h depois da última mensagem da pessoa.
- **Etiqueta de atendimento humano:** depois de 24h e até 7 dias, só resposta de **pessoa**, marcada com a tag `HUMAN_AGENT`. Automação (agente de IA, follow-up) nunca usa essa tag.
- **Sem template:** o Instagram não tem template aprovado. Fora da janela não há fallback automático; o CRM avisa e para.
- Chave de acesso do Instagram Login vale 60 dias e é renovável.

## 5. Arquitetura

Segue a doutrina de `docs/doctrine/restricao-de-canal.md`: nenhum código fora de `lib/channels/` nomeia o provider; as features perguntam por **capacidade**.

### 5.1 Provider novo

`meta_instagram` no vocabulário de `lib/channels/types.ts`, com adapter, linha na matriz de capacidades e entrada em todos os registros que o compilador cobra (`index.ts`, `templates-fonte.ts`, `session-ref.ts`, `inbound.ts`, `connect.ts`) e na regex de `lint:channels`.

Capacidades novas ou ajustadas na matriz (declaradas para **todos** os providers, falha fechada):

- `janelaDeResposta`: `24h` para os canais da Meta (WhatsApp oficial, Instagram, Messenger); sem janela no WAHA, como hoje.
- `foraDaJanela`: `template` (WhatsApp oficial) | `etiqueta_humana_7d` (Instagram, Messenger) | `livre` (WAHA). Restrição imposta **pela plataforma**: mudar a forma ou escalar para humano, nunca adiar.
- `exigeTelefone`: `true` para WhatsApp, `false` para Instagram. É o que desliga telas e validações que hoje assumem telefone.
- Sem voz opus, grupos, aquecimento nem limite diário de WhatsApp.

### 5.2 Banco (migration nova + apêndice idempotente no `baseline.sql` + linha no MANIFEST)

1. `channel_sessions`:
   - provider CHECK aceita `meta_instagram`;
   - colunas `ig_account_id text`, `ig_username text`, `ig_token_encrypted bytea`, `ig_token_expires_at timestamptz`;
   - `channel_sessions_provider_ref_check` exige `ig_account_id` quando o provider é `meta_instagram`;
   - índice único parcial (organization_id, ig_account_id) nas sessões ativas.
2. `conversations.channel` CHECK passa a aceitar `instagram` (hoje só `whatsapp`).
3. Tabela nova `contact_channel_identities`: `organization_id` (FK, cascade), `contact_id` (FK), `channel text` (CHECK `instagram`, e depois `messenger`), `external_id text` (IGSID), `handle text` (@usuário), `display_name`, `avatar_url`, timestamps; `unique (organization_id, channel, external_id)`; RLS `tenant_isolation_contact_channel_identities_all` via `fn_user_org_ids()`.
   Identidades de WhatsApp (`phone`, `wa_lid`) **não migram** para cá nesta entrega: nada muda para quem já usa.
4. RPCs `security definer` com os dois `revoke` (public e anon): `fn_upsert_contato_por_identidade(org, canal, external_id, handle, nome, avatar)` e o equivalente para a conversa. Idempotentes, sem seletor vindo do corpo.
5. `fn_mesclar_contatos` passa a mover as linhas de `contact_channel_identities` do contato absorvido para o que fica.
6. Mensagens: `unique (organization_id, external_id)` já existente cobre o `mid` do Instagram.

### 5.3 Conectar (etapa 1)

- Credenciais da instalação: `Instagram App ID` e `Instagram App Secret` (produto "Instagram" do app Meta) em `/admin/meta`, cifradas como as outras. Sem elas, o botão aparece desabilitado com o passo a passo.
- Conexões › **Conectar Instagram** → Business Login for Instagram (escopos `instagram_business_basic`, `instagram_business_manage_messages`) → callback `/api/v1/channels/instagram/callback` troca o code por token longo, lê `ig_account_id` e `username`, cria a `channel_session` no org ativo (organization_id da sessão do usuário, nunca do corpo) e assina o webhook da conta.
- **Origem padrão por conexão**: campo opcional na tela da conexão, "preencher o campo X do contato novo com o valor Y" (aqui: Origem = "Instagram Dr. André" / "Instagram Instituto Eva"). Genérico para qualquer instalação.
- **Renovação da chave:** cron diário renova tokens com menos de 15 dias. Falha abre aviso na Central (`agent_inbox_items`, kind `channel_token_expiring`) com o botão "Reconectar". Rodada sem efeito não audita.

### 5.4 Receber (etapa 1)

- Rota `POST /api/v1/webhooks/instagram` (callback **do app**, único para todas as contas; `GET` responde o desafio com o verify token da instalação).
- Valida `X-Hub-Signature-256` com o Instagram App Secret (`timingSafeEqual`). Assinatura inválida: 401 **e log estruturado** (hoje a rota do WhatsApp oficial recusa sem registrar, e isso custou uma manhã de diagnóstico em 24/09).
- `object: "instagram"`, `entry[].messaging[]`. Roteia por `entry.id` (= `ig_account_id`) para a `channel_session` ativa; conta desconhecida: 200 e log (a Meta não deve reenviar).
- Para cada mensagem: upsert do contato por identidade (busca nome, @ e foto na primeira vez), upsert da conversa (`channel = 'instagram'`), insert da mensagem (`23505` = já recebida, ignora), `event_log` `message.received`. Ecos de mensagens enviadas pelo próprio perfil (app do Instagram) entram como `outbound` sem duplicar.
- Contato novo: card em "Novo lead – interagir" do funil padrão, com a Origem padrão da conexão aplicada.
- Mídia recebida (imagem, áudio): baixada para o Storage `whatsapp-media` (bucket já existente e privado), como o WhatsApp faz.

### 5.5 Responder (etapa 2)

- O caminho de envio é o mesmo (`app/api/v1/messages/_handler.ts` → `getAdapter(provider)`). `resolveRecipient` passa a aceitar a identidade de canal além do telefone.
- Antes de enviar: dentro de 24h, envia livre; entre 24h e 7 dias, **só se o autor é pessoa**, com `tag: HUMAN_AGENT`; depois de 7 dias, bloqueia com mensagem clara na tela ("A Meta só permite responder até 7 dias depois da última mensagem dessa pessoa").
- Texto e imagem nesta etapa. Áudio fica para depois (o Instagram não aceita opus).
- Tela: o compositor mostra o relógio da janela (já existe `lib/channels/janela.ts`) com a regra de 7 dias para humanos.

### 5.6 Follow-ups, agente e junção (etapa 3)

- Envio automático (follow-up, agente) em conversa de canal com `foraDaJanela = etiqueta_humana_7d`: só dentro de 24h. Fora disso, o passo é pulado com `skipped: 'fora_da_janela_automatica'` visível no dossiê, e a sequência segue (não trava).
- A validação de publicação do fluxo (`long_wait_needs_template`) passa a considerar o canal: para Instagram, espera longa não exige template, mas o passo é marcado "só dentro de 24h".
- Junção: `fn_mesclar_contatos` já cobre (5.2 item 5). A ficha do contato mostra os canais que ele tem.

### 5.7 Tela (etapas 1 e 2)

- Conexões: cartão "Instagram" com as contas conectadas, status, validade da chave, Origem padrão, reconectar e desconectar. Porta já existe em `lib/navigation/catalogo.ts` (Conexões).
- Inbox: ícone do canal e "via @conta" na lista e no cabeçalho; nome, @ e foto no lugar do telefone. Remover o `"??"` e o filtro que some com contatos sem telefone (`ConversationListItem.tsx:127`, `ContactPickerDialog.tsx:82`).
- Ficha do contato: lista de canais (telefone, @instagram).

### 5.8 Messenger (etapa 4)

Mesmo desenho com provider `meta_messenger`, `object: "page"`, identidade PSID, token de Página (via Facebook Login, permissão `pages_messaging`). Especificação curta própria quando chegar a vez.

## 6. Erros e o que o usuário vê

| Falha | O que acontece |
|---|---|
| Credencial do Instagram ausente | botão desabilitado com o passo a passo |
| Login cancelado ou recusado | volta para Conexões com a frase do motivo |
| Token vencendo / renovação falhou | aviso na Central com "Reconectar" |
| Assinatura inválida no webhook | 401 + log estruturado (visível no log do app) |
| Envio fora da janela | bloqueio antes de enviar, com a frase da regra |
| Erro da Meta no envio | mensagem `failed` com o motivo em português, como no WhatsApp |

## 7. Testes e prova

- Unit: parser do webhook do Instagram (payloads reais da documentação, incluindo eco e mídia), roteamento por conta com filtro de org, regra 24h/7d/humano, matriz de capacidades (todo provider declara as capacidades novas), lint de fronteira.
- Invariantes (`pnpm test:db`): RLS de `contact_channel_identities` entre 2 orgs, idempotência do upsert, CHECKs novos, `fn_mesclar_contatos` levando identidades, revogação das RPCs.
- E2E (Playwright, banco fresco do baseline): conectar com o OAuth simulado, webhook assinado simulando um Direct, conversa aparece no Inbox com @ e "via @conta", card no funil com Origem, resposta dentro da janela, bloqueio depois de 7 dias.
- Prova real no fim de cada etapa: o dono manda um Direct de outra conta para @instit.eva e @dr.andreluisc.

## 8. Entrega

Quatro PRs (etapas 1 a 4), cada um com migration + apêndice do baseline + MANIFEST quando houver schema, fragmento `.changes/` (`capacidade_nova`), mapa vivo em `docs/architecture/` e o checklist abaixo. Nenhuma variável de ambiente nova obrigatória: o canal fica desligado até alguém cadastrar a credencial.

Configuração única no painel da Meta (conduzida pelo Claude no Chrome, com o dono): adicionar o caso de uso Instagram ao app "CRM - EVA", cadastrar a URL de callback do login e do webhook, assinar o campo `messages`.

## 9. Living System Checklist

- **Quem me alimenta:** webhook do Instagram (`/api/v1/webhooks/instagram`), a partir de contas conectadas em Conexões.
- **Quem eu alimento:** Inbox, funil (card em "Novo lead – interagir"), campo Origem, follow-ups, relatório de conversão.
- **Atividade/log:** `event_log` `message.received`/`message.sent`; auditoria `channel.connected`, `channel.disconnected`, `channel.token_refreshed`; atividade no card.
- **Onde aparece na tela:** Inbox (lista, cabeçalho, conversa), ficha do contato, card do funil, Conexões.
- **Porta:** Conexões (já no catálogo); Inbox (já no catálogo).
- **Anti-morte:** conversa nova vira card em "Novo lead – interagir", que entra no follow-up de silêncio (dentro de 24h).
- **Configuração:** credencial em `/admin/meta`, contas e Origem padrão em Conexões; ausência mostra o passo a passo.
- **Continuidade IA↔humano:** a regra de 24h/7d separa o que a IA pode (24h) do que só a pessoa pode (até 7d); fora da janela automática, o dossiê diz que o passo foi pulado e por quê.
- **Laço de retorno:** token que falha abre aviso com "Reconectar"; assinatura inválida vira log; envio bloqueado explica a regra na tela.
- **Mapa vivo:** `docs/architecture/` ganha o nó do canal Instagram com as arestas Conexões → webhook → Inbox/funil.

## 10. Riscos

- **Etiqueta humana:** a documentação permite a tag para respostas humanas; se a Meta passar a exigir aprovação dela para contas próprias, a etapa 2 funciona só dentro de 24h até a aprovação. Conferir no primeiro envio real.
- **Duas contas, um webhook:** o callback é do app; roteamento por `entry.id` precisa estar certo desde o primeiro dia (teste de roteamento com duas contas).
- **Mudança de schema em tabela quente** (`conversations`): só troca de CHECK e colunas novas, sem reescrita de dados.
