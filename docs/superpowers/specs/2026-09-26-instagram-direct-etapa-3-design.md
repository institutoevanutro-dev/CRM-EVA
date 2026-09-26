# Instagram Direct, etapa 3: follow-ups e contato único

Data: 26/09/2026. Continua `docs/superpowers/specs/2026-09-24-instagram-direct-no-crm-design.md` (§5.6) e `docs/superpowers/specs/2026-09-25-instagram-direct-etapa-2-design.md`. Etapas 1 e 2 estão no ar (PRs #28 e #30).

## 1. O que o André decidiu

1. Follow-up automático no Instagram, só dentro das 24h da última mensagem da pessoa. Passo fora disso é pulado e o fluxo segue. Se na prática quase tudo for pulado, trocar por "lembrete para a equipe" (fora desta etapa).
2. O follow-up vai pelo WhatsApp sempre que o contato tiver WhatsApp. Instagram só para quem não tem. Motivo: leads chegam quase todos pelo WhatsApp; o Instagram é mais de amigos.
3. Mesmo @ nos dois perfis do Instagram junta sozinho num contato só. Instagram com WhatsApp só é sugerido em "Duplicados", quando o nome bate, para a equipe confirmar.
4. Juntar o cadastro não junta conversas: cada canal continua com sua conversa, e a resposta sai sempre pelo canal da conversa aberta. A ficha do contato lista os canais.

Sucesso: um lead do Instagram sem WhatsApp recebe o follow-up que cair nas 24h; ninguém recebe follow-up pelo Instagram quando tem WhatsApp; quem escreveu para os dois perfis aparece como uma pessoa só, com duas conversas; a ficha mostra por onde a pessoa fala.

## 2. Follow-ups

### 2.1 Qual conversa o follow-up usa

- Hoje a inscrição (`lib/followup/enroll.ts`, `lib/followup/retorno-crm.ts` → `beginServiceAtOrigin` → `fn_service_begin`) pega a conversa mais recente do contato, de qualquer canal.
- Passa a escolher explicitamente: a conversa 1:1 mais recente de canal `whatsapp`; se o contato não tiver nenhuma, a mais recente de `instagram`. A escolha vira o `p_session` que `fn_service_begin` já aceita. Uma função só, em `lib/followup/`, usada pelos dois pontos de inscrição.

### 2.2 Envio automático no Instagram

- A IA de atendimento continua sem responder no Instagram (`iaResponde: false`, worker pula com `canal_sem_ia`).
- O servidor de mensagens (`app/api/v1/messages/_handler.ts`) hoje recusa todo ator que não é `user` em canal com `iaResponde: false`. Passa a aceitar UMA exceção: envio de follow-up (marcado explicitamente pelo chamador, não deduzido pelo tipo de ator) quando a janela está `aberta` (menos de 24h desde a última mensagem da pessoa). Sem tag `HUMAN_AGENT`: a tag é só para gente.
- Envio automático que não é follow-up continua recusado (`envio_automatico_indisponivel`). Follow-up fora das 24h é recusado com `fora_das_24h_do_instagram`.
- A regra de janela para automático é a de 24h, não a de 7 dias da etapa 2.

### 2.3 Passo pulado, fluxo segue

- Antes de enviar um passo de ação (os dois caminhos: texto fixo em `lib/followup/enviar-texto-fixo.ts` e mensagem de IA em `lib/agent-engine/agent/followup-turn.ts`), o motor confere a conversa da inscrição. Se o canal tem janela de 24h para automático (capability do Instagram) e a janela não está aberta, o passo é pulado com o motivo `fora_das_24h_do_instagram` e a inscrição avança para o próximo nó. Não cancela a sequência, não reagenda.
- Se a janela de envio da organização (horário comercial) adiaria o passo para depois do fim das 24h, o passo é pulado na hora com o mesmo motivo, em vez de adiado (mesmo padrão do `fora_da_janela_sem_encaixe` que já existe).
- Se o servidor recusar com `fora_das_24h_do_instagram` (corrida entre a conferência e o envio), o motor trata como passo pulado, nunca como falha que reenvia.
- O histórico do lead e o dossiê do follow-up mostram "Passo pulado: fora das 24h do Instagram".
- `validateFlowForPublish` não muda: o fluxo não sabe o canal, e as esperas longas continuam exigindo modelo para o WhatsApp.

## 3. Contato único

### 3.1 Mesmo @ junta sozinho

- Quando o CRM descobre o @ de um contato do Instagram (busca de perfil em `lib/channels/instagram/perfil-do-contato.ts`), procura na mesma organização outra identidade de Instagram com o mesmo @ (comparação sem diferenciar maiúsculas) ligada a OUTRO contato. Achou: junta os dois com `fn_mesclar_contatos`, ficando o contato mais antigo como principal.
- A junção é auditada como as outras (ator de sistema) e aparece no histórico do contato.
- As conversas não colidem: cada perfil do Instagram é uma sessão diferente, e a trava `uniq_conversations_1to1_per_contact_session` é por sessão.
- Contatos já existentes: a rodada diária do cron do Instagram faz a mesma procura para todas as identidades com @, até 50 junções por rodada, e audita só quando juntou alguém.
- Falha ao juntar nunca quebra a ingestão (registra e segue).

### 3.2 Instagram com WhatsApp, sugestão

- `lib/contacts/duplicados.ts` ganha a chave "mesmo nome": um contato do Instagram (tem identidade de Instagram, sem telefone) e um contato com telefone cujo nome normalizado (minúsculas, sem acento, espaços colapsados) é igual. O par aparece em "Duplicados" com o motivo "Mesmo nome no Instagram e no WhatsApp". A equipe confirma e escolhe o principal, como hoje.
- Nomes com uma palavra só não entram (muito comuns para sugerir).

### 3.3 Ficha do contato mostra os canais

- `app/app/contacts/[id]/_client.tsx` ganha a seção "Canais": uma linha por conversa 1:1 do contato, com o selo do canal (o mesmo `SeloDoCanal` do Inbox), o identificador (telefone ou @) e o perfil/número por onde a pessoa fala ("via @instit.eva"). Cada linha abre aquela conversa no Inbox.

## 4. Fora desta etapa

- Lembrete para a equipe no lugar do follow-up (plano B do item 1).
- Juntar por nome sem confirmação.
- Messenger (etapa 4).
- "Liberar" devolvendo conversa do Instagram para "Automático" (pendência da etapa 2, segue anotada).

## 5. Testes

- Escolha da conversa: contato com WhatsApp e Instagram (Instagram mais recente) → WhatsApp; só Instagram → Instagram; só WhatsApp → WhatsApp.
- Servidor: follow-up no Instagram com 2h → envia sem tag; com 30h → `fora_das_24h_do_instagram`; envio automático que não é follow-up → `envio_automatico_indisponivel`; WhatsApp sem mudança.
- Motor: passo no Instagram fora das 24h é pulado e a inscrição avança para o próximo nó, com o evento legível; adiamento pela janela da organização que passaria das 24h vira pulo; recusa do servidor vira pulo, sem reenvio.
- Junção por @: dois contatos com o mesmo @ (maiúsculas diferentes) viram um, principal o mais antigo, duas conversas no principal; @ diferente não junta; falha na junção não quebra a ingestão; rodada diária junta os existentes e audita só com efeito.
- Duplicados: nome igual Instagram × WhatsApp sugere; nome de uma palavra não sugere; nomes diferentes não sugerem.
- Ficha: contato com WhatsApp e Instagram mostra as duas linhas com selo e link.
- e2e: ficha com os dois canais; follow-up de contato só Instagram dentro das 24h sai pelo receptor local.
- `pnpm test:db` se houver mudança de schema (a princípio não há).

## 6. Riscos

- **A Meta pode tratar follow-up automático como spam** mesmo dentro das 24h, se o conteúdo parecer promocional. Mitigação: só dentro das 24h, e o plano B (lembrete) está combinado.
- **Junção automática não tem desfazer.** Mitigação: só com @ igual, que é único no Instagram, e só entre identidades de Instagram.
- **Contato do Instagram que depois passa a ter telefone** (a equipe preenche) cai na regra do WhatsApp para follow-up e na detecção por telefone de "Duplicados", que já existe.
