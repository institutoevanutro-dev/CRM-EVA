# Comentários do Instagram no CRM

## 1. Objetivo

Que nenhum comentário nos vídeos do Instituto Eva fique sem resposta, e que o comentário certo vire paciente.

Duas coisas, na mesma tela:

- **Palavra combinada vira lead.** "Comente CARDÁPIO neste vídeo" → o CRM manda a mensagem privada, responde o comentário em público com uma frase curta, e a pessoa vira card no funil **quando responder** o Direct.
- **Comentário solto ganha resposta.** Quem comenta qualquer outra coisa recebe uma resposta pública escrita no jeito do André, para o vídeo engajar — mas só quando o comentário é obviamente seguro. O resto espera o toque dele.

Sucesso, medido: um vídeo com chamada para comentar produz conversas no Direct sem ninguém digitar, e a aba de comentários fecha o dia vazia.

## 2. Decisões já tomadas (26/09/2026, com o dono)

1. O card no funil nasce **quando a pessoa responde o Direct**, não quando comenta. Um vídeo que viraliza não pode encher o funil de quem nunca respondeu. Isto não exige código novo: o Direct de entrada já cria o card (`lib/channels/pos-entrada.ts`).
2. Quando o CRM manda o privado, ele **também responde em público** com uma frase curta ("te mandei no direct 💚"), escrita junto com a regra. Sem isso, parte das pessoas não acha a mensagem, que cai em "Solicitações" para quem não segue.
3. A IA só publica sozinha no que é **obviamente seguro** (elogio, emoji, "top!"). Qualquer coisa que pareça pergunta clínica, preço, medicação, agendamento ou reclamação vira **sugestão esperando um toque**. É uma IA assinando como médico num perfil público: o erro não é constrangimento, é exposição.
4. O jeito de escrever é aprendido dos **comentários que o André já respondeu** nos próprios posts, não de exemplos digitados à mão. Ele pode corrigir o perfil de voz depois.
5. Os comentários moram numa **aba própria dentro do Inbox**, ao lado de "Conversas".
6. **A IA nunca chama o dono de nutrólogo, especialista ou qualquer título de especialidade** (26/09/2026). Ele não tem RQE, e anunciar especialidade sem registro é infração do CFM — aqui, publicada em público e no nome dele. O termo é "médico". A trava é na geração (§5.5), não só no prompt: prompt é pedido, trava é garantia.

## 3. Fora de escopo

- **Facebook/Messenger.** Só Instagram nesta spec. A etapa 4 do Direct já prevê o Messenger; comentário de Facebook entra junto de lá, se entrar.
- **Comentários de Live** (`live_comments`). Outro campo de webhook, outra janela (só durante a transmissão).
- **Moderação** (esconder, apagar, bloquear). Nada é escondido nem apagado nesta versão: o CRM só lê e responde.
- **Responder menção** (@ em post de terceiro). A Meta entrega menção pelo mesmo webhook, mas responder na casa dos outros é outra decisão de marca.
- **Métrica de desempenho por regra.** Quantos comentaram, quantos responderam, quantos viraram paciente — fica para depois de a coisa rodar.

## 4. Regras da Meta que o produto respeita

Confirmado na documentação em 26/09/2026 (não de memória):

- **Resposta privada:** `POST https://graph.instagram.com/<versão>/<IG_ID>/messages` com `recipient: {"comment_id": "<id>"}`. **Uma única** por comentário, dentro de **7 dias** do comentário. Depois dela, só continua a conversa se a pessoa responder, e aí vale a janela de 24h — que `lib/channels/janela.ts` já sabe tratar desde a etapa 2.
- **Permissões:** o webhook `comments` e a resposta privada pedem `instagram_business_basic` + **`instagram_business_manage_comments`**. Hoje a conexão pede `instagram_business_basic,instagram_business_manage_messages` (`lib/channels/instagram/oauth.ts:18`): o escopo novo entra ali e **os dois perfis precisam ser reconectados**, porque escopo novo exige consentimento novo.
- **A resposta privada NÃO usa a permissão de mensagens.** É a de comentários. Isso importa porque a instalação pode ter uma sem a outra.
- **Acesso Avançado é obrigatório** para receber `comments`. Ver §10.

## 5. Arquitetura

### 5.1 O que entra (webhook)

O webhook do Instagram já existe (`app/api/v1/webhooks/instagram/route.ts`, assinatura HMAC conferida). O que muda:

- `lib/channels/instagram/webhook.ts` hoje lê **só** `entry[].messaging[]` (linha 23). Comentário chega em `entry[].changes[]` com `field: "comments"` — o parser passa a aceitar os dois, e o que não reconhece continua sendo ignorado em silêncio, como hoje.
- Eco do próprio perfil (o `from.id` é a conta conectada) é descartado antes de qualquer coisa: responder o próprio comentário seria um laço.
- Reentrega da Meta é esperada: o `id` do comentário é a chave de idempotência (índice único por organização), e a segunda entrega não repete ação nenhuma.

### 5.2 Banco (migration 0279 + apêndice idempotente no `baseline.sql` + linha no MANIFEST)

Uma tabela e uma de regras. Ambas `organization_id not null` com RLS `tenant_isolation_*`, como toda tabela do repo.

- **`instagram_comments`** — o comentário e o que o CRM fez com ele. `external_id` (o id da Meta) + `organization_id` únicos; `channel_session_id` (de qual perfil), `media_id`, `texto`, `autor_igsid`, `autor_handle`, `comentado_em`, `contact_id` (quando já conhecemos a pessoa), e o desfecho: `situacao` (`novo` | `respondido_pela_regra` | `respondido_pela_ia` | `esperando_voce` | `ignorado`), `regra_id`, `resposta_publica_id`, `private_reply_message_id`, `sugestao_de_resposta`, `motivo_do_toque`.
- **`instagram_comment_rules`** — a regra. `channel_session_id`, `media_id` (o vídeo), `palavra`, `texto_do_direct`, `frase_publica`, `ativa`, `criada_por`.

`situacao` é `text` + CHECK, nunca enum (doutrina do `CLAUDE.md`).

**Sem coluna de contagem.** Quantos comentários a regra atendeu é `count(*)` sobre a tabela — DIRC-C, calcular em vez de duplicar.

### 5.3 A regra (palavra + vídeo)

Puro, testável sem banco, em `lib/comentarios/regra.ts`: recebe o texto do comentário e as regras ativas daquele `media_id`, devolve a regra que casa ou `null`.

- Comparação **sem acento e sem caixa** ("cardápio" casa "CARDAPIO"), por **palavra inteira** — "cardápio" não casa "cardápios da vovó" só por conter as letras. Palavra inteira evita o falso positivo que faria o CRM mandar Direct para quem não pediu.
- Duas regras do mesmo vídeo casando o mesmo comentário: vence a de palavra mais longa (a mais específica), e o empate vence a mais antiga. Determinismo importa mais do que a escolha em si.

Ao casar, nesta ordem, cada passo com desfecho gravado:
1. **Resposta privada** (`recipient: {comment_id}`). É a que tem prazo de 7 dias e é única — vai primeiro, porque se algo falhar depois, o que importava já saiu.
2. **Resposta pública** com a frase da regra.
3. `situacao = 'respondido_pela_regra'`.

O card do funil **não** nasce aqui. Nasce quando a pessoa responde, pelo caminho que já existe.

### 5.4 Comentário sem palavra-chave

Um classificador decide entre **obviamente seguro** e **precisa de você**. Ele é conservador por construção: na dúvida, é "precisa de você".

- **Precisa de você**, sempre: preço, plano, valor, desconto; nome de medicação ou dose; sintoma, efeito colateral, "posso tomar", "serve para mim"; agendamento, consulta, horário; reclamação, ironia, ofensa; qualquer coisa que termine em pergunta e não seja sobre o vídeo em si.
- **Obviamente seguro**: elogio, emoji, "top", "amei", "parabéns" — e nada mais.

Seguro → a IA escreve e publica no jeito do André (§5.5). O resto → `situacao = 'esperando_voce'` com `motivo_do_toque` dizendo qual gatilho pegou, e a sugestão já escrita, para o toque ser um toque.

A decisão do classificador é gravada na linha: quando ele errar, dá para medir onde.

### 5.5 O jeito de escrever

**Correção (revisão final, 2026-09-26): esta seção descrevia um cron diário com uma linha
editável na tela, e NADA disso foi construído — a frase envelheceu antes do PR fechar.** O
que existe (`lib/comentarios/voz.ts`, `perfilDeVoz`) é cálculo NA HORA, dentro da própria
rodada do worker: lê as respostas públicas que o dono já deu nos comentários daquela sessão
(`admin.respostasAnterioresDoDono`, Graph API), e monta o perfil só com o que dá pra derivar
sem opinião — emoji mais usados, tratamento predominante ("você"/"senhor") e até 20 frases
típicas. Cacheado em memória POR RODADA (`workers/comentarios-worker.ts`, `perfilCache`), não
em banco: a próxima rodada recalcula do zero. Sem sessão ou sem nenhuma resposta anterior,
`perfilDeVoz` devolve `null` e o comentário cai em `esperando_voce` — nunca escreve "no jeito
dele" sem amostra nenhuma.

Não tem cron, não tem tabela, não tem tela de edição, e não deriva "tamanho médio" nem "o que
ele nunca faz" — só o que está listado acima. Editar o perfil (corrigir o que a máquina
entendeu errado) é trabalho de outra sessão: persistência (migration + coluna/tabela), tela e,
se fizer sentido, um cron que recalcule fora do caminho do worker. Ver §10.

O agente que escreve é o sistema de agentes que o CRM já tem, com o perfil de voz no prompt. Nada de motor novo.

**Teto de tamanho, sem link, sem título de especialidade.** Resposta pública é curta e nunca leva link, preço, nem as palavras `nutrólogo`, `nutrologia`, `especialista` ou `especializado` — mesmo que o perfil de voz as tenha aprendido de um comentário antigo. A resposta que as contiver é recusada e o comentário cai em "esperando você".

### 5.6 Tela

Aba **Comentários** no Inbox, ao lado de Conversas, com o mesmo contador e os mesmos filtros:

- lista por situação, com o vídeo, o texto, quem escreveu e o que o CRM fez;
- **"esperando você"** primeiro, com a sugestão pronta e dois botões: *Publicar* e *Editar*;
- de cada comentário dá para abrir a conversa do Direct, quando existir;
- **Regras**: lista dos vídeos com regra ativa, e o formulário para criar (escolher o vídeo, a palavra, o texto do Direct, a frase pública).

Texto novo de tela tem espanhol (`lib/i18n/dicionario.ts`) — o guard de i18n reprova sem.

## 6. Erros e o que o usuário vê

| Falha | O que acontece |
|---|---|
| Sem `instagram_business_manage_comments` na sessão | a aba explica que falta reconectar, com o botão que leva a Conexões |
| Resposta privada recusada (perfil fechado, bloqueou) | `situacao = 'esperando_voce'` com o motivo; a resposta pública ainda sai |
| Passou dos 7 dias do comentário | não tenta o privado; publica só a frase pública e diz na linha por que o privado não foi |
| Comentário apagado pelo autor antes da resposta | a Meta recusa; a linha registra e segue, sem alarme |
| A IA não conseguiu escrever | vira `esperando_voce` sem sugestão — nunca publica vazio |
| Meta fora do ar | a linha fica `novo` e a próxima rodada tenta de novo |

## 7. Testes e prova

- **Unit:** o casador de palavra (acento, caixa, palavra inteira, duas regras no mesmo vídeo, palavra dentro de outra palavra); o classificador (a lista inteira de "precisa de você", e que a dúvida cai para o lado seguro); o parser do webhook com payload real de `comments` e com payload de `messages` no mesmo formato (um não pode quebrar o outro); a janela de 7 dias.
- **Invariantes (`pnpm test:db`):** RLS das duas tabelas entre 2 organizações; unicidade de `external_id` por organização; CHECK de `situacao`.
- **E2E (Playwright, banco fresco do baseline):** webhook assinado com um comentário que casa a regra → a aba mostra o comentário como atendido, o Direct sai no receptor local e a frase pública é postada; um comentário com "quanto custa" → cai em "esperando você" e **nada é publicado**.
- **Prova real:** o dono comenta de outra conta num vídeo com regra, e confere os três efeitos.

## 8. Entrega

Um PR, com migration + apêndice do baseline + linha no MANIFEST, fragmento `.changes/` (`exige_acao`: o escopo novo pede reconexão dos perfis), mapa vivo em `docs/architecture/` e o Living System Checklist respondido.

Configuração na Meta, com o dono: acrescentar `instagram_business_manage_comments` ao app "CRM - EVA", assinar o campo `comments` no webhook que já existe, e reconectar os dois perfis.

## 9. Living System Checklist

- **Entrada e saída:** entra pelo webhook `comments`; sai como resposta privada, resposta pública e linha na aba.
- **Atividade e log:** cada desfecho fica na linha do comentário e na auditoria (`comment.replied`, `comment.private_reply_sent`, `comment.waiting_human`).
- **Tela:** aba Comentários no Inbox, com porta em `lib/navigation/catalogo.ts`.
- **Anti-morte:** comentário `novo` que passou de 1 hora sem desfecho abre aviso na Central — senão um webhook perdido some sem ninguém notar.
- **Laço de retorno:** quando o classificador erra, o toque do dono (publicar, editar ou descartar) fica gravado na linha; é dali que sai a medição de quanto ele erra, e é o que justifica mexer nele.
- **Configuração com superfície:** as regras são editáveis na tela, não em variável de ambiente.
  **Correção (revisão final): o perfil de voz NÃO é** — ele é calculado na hora, a cada
  rodada do worker, sem tela nem persistência (§5.5). Enquanto isso não existir, a única
  configuração possível é indireta: a lista de gatilhos e radicais de especialidade
  (`lib/comentarios/seguranca.ts`, `lib/comentarios/especialidade.ts`) é editável sem
  deploy, e um perfil que está saindo ruim se corrige mandando o comentário para
  `esperando_voce` (fila humana) — nunca editando o perfil em si. Ver §10.

## 10. Riscos

1. **Acesso Avançado da Meta é pré-requisito, e a App Review está parada nos vídeos.** Sem ele o webhook `comments` não chega. Isto não impede construir — e inverte a ordem a favor: o vídeo que a Meta pede para aprovar a permissão é a gravação desta tela funcionando. Construir destrava a submissão. **Mas nada disso funciona em produção antes da aprovação, e a spec não finge o contrário.**
2. **A IA assina como médico em público.** Mitigado pelo classificador conservador (§5.4), pelo teto de tamanho e pela proibição de link e preço. Resta o risco de o classificador deixar passar algo: por isso a decisão dele é gravada e medida, e a lista de gatilhos é editável sem deploy.
3. **O perfil de voz aprende os dias ruins.** Ele é lido de comentários reais, incluindo respostas secas ou irônicas. **Correção (revisão final): NÃO é editável** — é calculado na hora, sem tela nem persistência (§5.5). Mitigado só por a publicação automática valer apenas no que é obviamente seguro; um perfil ruim não tem hoje outra saída além da fila humana (`esperando_voce`). **Próximo passo:** persistir o perfil (migration + tabela/coluna) e dar uma tela de edição — sem isso, "o perfil aprendeu um dia ruim" só se resolve esperando os comentários recentes mudarem de assunto, ou publicando à mão pela fila.
4. **Volume.** Um vídeo que viraliza traz centenas de comentários num minuto. O processamento é assíncrono e com teto por rodada, como a renovação do token — nunca no caminho do webhook, que precisa responder rápido para a Meta não reenviar.
