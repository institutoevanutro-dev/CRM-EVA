# Instagram Direct, etapa 2: responder pelo CRM

Data: 25/09/2026. Continua `docs/superpowers/specs/2026-09-24-instagram-direct-no-crm-design.md` (§5.5 e §5.7). A etapa 1 está no ar desde 25/09/2026 (PR #28): os dois perfis (@dr.andreluisc e @instit.eva) recebem no Inbox.

## 1. O que o André pediu

1. Responder o Direct pelo CRM, só a equipe. A IA continua sem responder no Instagram.
2. Deixar evidente, na lista e na conversa, o que é Instagram e o que é WhatsApp.
3. Mostrar o nome da pessoa, não "Contato do Instagram".

Sucesso é: a equipe responde um Direct pelo Inbox, a pessoa recebe no Instagram, e ninguém confunde canal nem vê "Contato do Instagram" quando a Meta devolve nome ou @.

## 2. Responder

### 2.1 Envio

- `capabilities.meta_instagram.canSend` passa a `true`. O caminho continua o mesmo: `app/api/v1/messages/_handler.ts` → `getAdapter(provider).send`.
- `instagramAdapter.send` chama `POST {BASE_DO_INSTAGRAM}/{graphVersion}/{ig_account_id}/messages` com o token da sessão (`resolveInstagramToken`, já existe), corpo `{ recipient: { id: IGSID }, message: {...} }`.
- Destinatário: o IGSID vem de `contact_channel_identities` (canal `instagram`, conta da sessão da conversa). `resolveRecipient` do adapter resolve a partir dele. Sem identidade → erro `instagram_sem_destinatario`.
- Texto: `message: { text }`. A API aceita até 1000 caracteres; acima disso a tela recusa antes de enviar.
- Foto: `message: { attachment: { type: "image", payload: { url } } }`, com a URL assinada do Storage (validade curta, gerada na hora). Só imagem (jpeg/png). Áudio, vídeo e documento ficam recusados na tela com "Por enquanto o Instagram aceita só texto e foto pelo CRM".
- Resposta ok devolve `message_id`, que vira o `external_id` da mensagem. Assim o eco que o webhook traz depois é reconhecido como a MESMA mensagem (dedupe por `organization_id, external_id`) e não duplica.

### 2.2 Janela

| Tempo desde a última mensagem da pessoa | Envio |
|---|---|
| até 24h | normal |
| de 24h a 7 dias | com `messaging_type: "MESSAGE_TAG"`, `tag: "HUMAN_AGENT"` |
| mais de 7 dias | bloqueado |

- A regra mora em `lib/channels/janela.ts` (o provider não aparece fora de `lib/channels/`). O estado ganha um tipo novo, `humana`, com o restante até os 7 dias. A capability `meta_instagram` declara a janela estendida para humano (`janelaHumanaMs: 7 dias`).
- O envio pelo CRM nesta etapa é sempre humano (a IA não responde no Instagram), então a tag vale para todo envio entre 24h e 7 dias.
- A decisão é repetida no servidor, na hora do envio. A tela só explica.
- Mais de 7 dias: o servidor recusa com `instagram_fora_da_janela`. O compositor mostra "A Meta só deixa responder até 7 dias depois da última mensagem dessa pessoa. Responda pelo app do Instagram se ela escrever de novo."

### 2.3 IA fora do Instagram

- O agente de IA não responde em conversa de canal `instagram`. Hoje ele já não responde (o gate da sessão está em `allowlist` com lista vazia), mas a garantia passa a ser explícita no despacho do agente, por capability (`aiReplies: false` para `meta_instagram`), para não depender de configuração.
- Follow-ups automáticos também não enviam por Instagram nesta etapa (a etapa 3 trata isso).

### 2.4 Erros da Meta

| Erro | O que acontece |
|---|---|
| Token vencido ou revogado (190) | mensagem `failed` + aviso na Central para reconectar o perfil (mesmo aviso da renovação da etapa 1) |
| Fora da janela (código de janela da Meta) | `failed` com o texto da regra dos 7 dias |
| Pessoa bloqueou ou conta indisponível (551) | `failed` com "Essa pessoa não pode receber mensagens deste perfil" |
| Outros | `failed` com o código, sem reenviar (envio em dobro é pior que não-envio) |

## 3. Instagram e WhatsApp na tela

- **Selo de canal no avatar**: canto inferior direito da foto, na lista e no cabeçalho. Instagram com o logo sobre o degradê rosa/roxo; WhatsApp com o logo sobre verde. O selo substitui o ponto roxo que hoje fica nesse canto quando não tem outro significado. Se o ponto roxo tiver significado, o selo vai no canto oposto.
- **Etiqueta "via @conta"**: ganha a cor do canal (fundo suave). A do WhatsApp com telefone ganha o verde.
- **Filtro**: o seletor "Todos os números" ganha, no topo, "Só Instagram" e "Só WhatsApp". O filtro usa `conversations.channel` e combina com os outros filtros.
- As cores entram como tokens em `app/globals.css` (`--canal-instagram`, `--canal-whatsapp`), em claro e escuro, sem hex solto no componente.
- A tela decide o selo por um helper em `lib/channels/` (por exemplo `aparenciaDoCanal(provider)` → `"instagram" | "whatsapp"`), para o nome do provider não sair de `lib/channels/`.

## 4. Nome da pessoa

- Causa medida em produção: 3 de 6 contatos do Instagram ficaram sem nome. Todos nasceram de uma mensagem ENVIADA pelo celular (eco), e a busca de perfil só acontecia quando a identidade não existia. Depois de criada, o CRM nunca mais tentava.
- Correção na ingestão (`lib/channels/instagram/ingest.ts`): busca o perfil quando a identidade é nova OU o contato está sem `display_name`, em mensagem recebida ou eco. Limite: no máximo uma tentativa por contato a cada 24h, marcada em `source_metadata.perfil_tentado_em`, para não chamar a Meta a cada mensagem de quem não tem perfil acessível.
- Preenchimento: a busca só preenche o que está vazio (`display_name`, handle, foto). Nunca sobrescreve nome editado pela equipe.
- Contatos já existentes sem nome: um script de uma vez (`scripts/instagram-preencher-nomes.ts`), idempotente, que roda a mesma função para cada contato do Instagram sem `display_name`.
- Exibição: nome; se não houver, `@handle`; só sem os dois aparece "Contato do Instagram".

## 5. Fora desta etapa

- IA respondendo no Instagram.
- Áudio, vídeo, documento, figurinha, reação pelo CRM.
- Follow-ups por Instagram e junção de contatos (etapa 3).
- Messenger (etapa 4).
- Pendências anotadas na etapa 1 que continuam fora: assinatura na Meta ao desconectar, redirect de mídia sem reconferir host, texto genérico "este canal".

Entram nesta etapa, por estarem no caminho: o título do aviso de falha que ainda diz "WhatsApp" para o Instagram, e a rota de ritmo da IA que lista o Instagram.

## 6. Testes

- Unidade: `send` monta o corpo certo para texto, foto, com e sem tag; decisão de janela nas três faixas (limites exatos em 24h e 7 dias); recusa acima de 1000 caracteres; mapeamento dos erros 190/551/janela; busca de perfil só quando falta nome e respeitando as 24h; exibição nome → @ → "Contato do Instagram".
- Dedupe: envio grava `external_id`; o eco com o mesmo id não cria segunda mensagem.
- IA: o despacho do agente pula conversa `instagram`.
- e2e (`tests/e2e/instagram-responder.spec.ts`): no Inbox, conversa do Instagram mostra o selo, o compositor envia texto (Graph API respondida por um receiver local), a mensagem aparece como enviada; conversa com mais de 7 dias mostra o bloqueio; filtro "Só Instagram" esconde as de WhatsApp.
- Prova real depois do deploy: a equipe responde um Direct de teste pelo CRM nos dois perfis, dentro de 24h, e confere no app do Instagram.

## 7. Riscos

- **Tag HUMAN_AGENT**: se a Meta exigir aprovação da tag para o app, o envio entre 24h e 7 dias falha com erro de permissão. Nesse caso a tela passa a bloquear depois de 24h (a capability troca para 24h) até a aprovação. Conferir no primeiro envio real fora das 24h.
- **URL da foto**: a Meta baixa a imagem da URL assinada; validade curta demais faz falhar. Usar 10 minutos.
- **Selo e ponto roxo**: o ponto roxo atual precisa ter o significado conferido antes de mexer no canto do avatar.
