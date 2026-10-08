# Trava de dono da conversa — Fase 2, item 7

> Especificação para aprovação antes de codar. Medida na `origin/main` em 2026-10-05.
> Nada foi alterado no repositório.

## Resumo para o André (5 linhas)

1. Hoje o botão "Assumir" só impede que **outra pessoa clique em Assumir**. Ele não impede que ela **escreva** na conversa: qualquer atendente que enxerga a conversa responde ao cliente sem assumir.
2. Proposta: no sistema, quem não é o dono da conversa **não consegue enviar**. A caixa de texto mostra "Esta conversa é da Fulana" e oferece o caminho certo (assumir, ou pedir transferência).
3. Gerente e admin continuam podendo intervir. Cada mensagem já aparece com o nome de quem enviou.
4. Ao assumir (ou receber por transferência), a pessoa vira também o **Responsável do card** no funil, para a conversa e o card contarem a mesma história.
5. A mensagem digitada **no celular** do número não pode ser travada: ela já saiu quando chega ao CRM. Ela continua registrada como "Celular", como hoje.

Você precisa decidir **3 coisas** (seção 5). Cada uma vem com a minha recomendação.

---

## 1. Problema, medido no código

### 1.1 O envio não confere o dono

- A rota `POST /api/v1/messages` exige só o papel `agent`: `app/api/v1/messages/route.ts:29-34`.
- O ator da sessão é montado **sem o papel**: `lib/api/auth-dual.ts:126` (`actor: { type: "user", id: authz.user.id }`).
- `sendMessageHandler` (`app/api/v1/messages/_handler.ts:290`) carrega a conversa em `:314-347`, e o select **nem pede** `assigned_to_user_id` (`:315`). A partir daí só confere bloqueio do contato (`:384`), mídia, citação e canal. Em nenhum ponto pergunta quem é o dono.
- O insert grava `sent_by_user_id = ator` (`:553-554`). Depois o handler só estende o silêncio da IA por 5 minutos (`:276`, `:1019-1022`). A conversa continua sem dono, ou com o dono antigo.
- A RLS também não segura: `messages_insert` exige só pertencer à org (`supabase/baseline.sql:5596-5599`).
- O que a pessoa enxerga depende de `fn_can_view_conversation` (`baseline.sql:28415-28437`): manager e admin veem tudo, e o agent vê as próprias conversas mais as sem dono (padrão `own_and_unassigned`), ou todas (`visibility_mode='all'`). O resultado é este:

| Quem tenta enviar | `own_and_unassigned` (padrão) | `all` |
|---|---|---|
| agent, conversa **sem dono** | envia sem assumir | envia sem assumir |
| agent, conversa **de colega** | não vê (404) | **envia** |
| manager/admin, conversa de colega | **envia** | **envia** |

### 1.2 A tela também não trava

- `components/inbox/InboxLayout.tsx:605-618`: o `Composer` só fica `disabled` quando `status === "closed"`. O dono não é considerado.
- `components/inbox/ConversationHeader.tsx:87-88,260-279`: "Assumir" aparece só quando `isOpen`. Numa conversa de colega, então, não há na tela nem como assumir, e mesmo assim a caixa de texto está liberada.

### 1.3 Há duas portas laterais que contornam qualquer trava

- **Transferir não confere quem transfere.** `app/api/v1/conversations/[id]/transfer/route.ts:82-89` chama a RPC com `p_enforce_expected: false`, sem checar se quem chama é o dono ou gerente. O agent B (em modo `all`) pode transferir a conversa da A **para si mesmo** e responder.
- **"Assumir" aceita tomar a conversa de outro.** `app/api/v1/conversations/[id]/claim/route.ts:63-72`: com `expected_assignee = <dono atual>`, qualquer agent faz o *takeover* pela API, porque a RPC só compara o valor esperado (`baseline.sql:32845-32847`). A tela não oferece esse caminho, mas a API aceita.
- Já "Liberar" está certo: só o dono libera (`release/route.ts:80-96`).

### 1.4 Assumir não toca o card

`fn_conversation_assign` (versão vigente em `baseline.sql:32801-32884`) atualiza só `conversations`. Nenhuma linha toca `crm_leads.owner_user_id`. O card do funil segue com o Responsável antigo, ou vazio.

### 1.5 Celular (WAHA `fromMe`)

`lib/waha/ingest.ts:737-916` (`handleOutboundFromUserPhone`): a mensagem digitada no celular chega **depois** de enviada. Ela é gravada como `sent_via='external_device'` (`:837`), e a IA é pausada se não for eco do próprio envio (`:886-892`). Não existe "quem" (o número é compartilhado) nem como recusar.

---

## 2. Comportamento proposto

### 2.1 Regra única (função pura)

Arquivo novo: `lib/inbox/trava-de-dono.ts`

```ts
// ponytail: regra pura; quem decide 403/409 é o handler.
export function podeResponder(a: { atorId: string; papel?: string; donoId: string | null }):
  "pode" | "precisa_assumir" | "de_outro" {
  if (a.donoId === a.atorId) return "pode";
  if (roleAtLeast(a.papel, "manager")) return "pode";       // decisão 2
  return a.donoId === null ? "precisa_assumir" : "de_outro"; // decisão 1
}
```

`roleAtLeast` já existe (`lib/auth/types.ts:43`). Papel ausente conta como agent, então a regra falha **fechada**.

### 2.2 Servidor (onde a regra vale de verdade)

1. `lib/api/auth-dual.ts:126`: passar `role: authz.org.role` no ator da sessão (o tipo já aceita, `lib/api/handlers/types.ts:17`).
2. `_handler.ts:315`: incluir `assigned_to_user_id` no select da conversa.
3. Logo depois de `:384` (bloqueio do contato) e **antes do insert**:
   - **só para `ctx.actor.type === "user"`**. IA, follow-up, automação, lembrete de agenda e token (`ai_agent`, `webhook_source` e `api_token`, ver `lib/api/handlers/types.ts:16-58`) **não mudam**: eles já são governados pelo silêncio da IA, e o lembrete de agenda tem de sair mesmo com a conversa assumida;
   - `"precisa_assumir"` devolve 409 `claim_required` ("Assuma a conversa para responder.");
   - `"de_outro"` devolve 409 `conversation_owned_by_other` ("Esta conversa está com {nome}. Peça a transferência.");
   - a recusa acontece **antes** de criar a linha `queued`, então não sobra mensagem fantasma.
4. A nota interna **não** passa pela trava. Ela segue o padrão que o Composer já usa para janela fechada (`Composer.tsx:39-46`): barra a resposta e deixa a nota livre.
5. Quando gerente ou admin envia na conversa de outro, o audit `message.sent` (`_handler.ts:1043-1052`) ganha `metadata.fora_do_dono: true`. A bolha já mostra o nome do colega que enviou (`MessageBubble.test.tsx:101`).

### 2.3 Fechar as portas laterais

- **Transferir** (`transfer/route.ts`): permitido quando quem chama é o dono, quando a conversa está sem dono, ou quando quem chama é manager ou admin. Fora disso, 403 `forbidden`. A regra é a mesma `podeResponder`.
- **Assumir com takeover** (`claim/route.ts`): se `expected_assignee` não é nulo e é diferente de quem chama, exigir manager ou admin. O claim de conversa livre segue igual.
- Nada disso precisa de migration. As duas checagens ficam nas rotas, onde `authz.org.role` já existe.

### 2.4 Tela

- `InboxLayout.tsx:605`: calcular `podeResponder` com `user.id`, o papel e `selectedConversation.assigned_to_user_id`, e repassar ao Composer uma prop no formato de `janelaFechada` (barra a resposta, deixa a nota):
  - `precisa_assumir`: faixa "Assuma para responder", com o botão **Assumir e responder** (chama o `useClaimConversation` que já existe; depois o envio segue);
  - `de_outro`: faixa "Esta conversa está com {assigned_to_user_name}", com o botão **Pedir transferência** (abre o `ReassignDialog` que já existe, só para manager+, ou mostra só o texto para agent).
- `ConversationHeader.tsx`: para manager ou admin, numa conversa de outro, mostrar "Assumir" (takeover, com `expected_assignee` = dono atual), conforme a decisão 2.

### 2.5 Responsável do card

Na `registrarTrocaDeComando` (`lib/inbox/atividade-de-comando.ts:74`), que já roda nas três rotas e **já resolve o negócio ativo** do contato com `resolveActiveLeadForContact` (`:103-122`, admin client filtrado por org):

- adicionar `novoResponsavel?: string` à entrada. Claim e transfer passam o novo dono, e release não passa nada (o card mantém quem trabalhou o negócio);
- com `alvo.routed`: `update crm_leads set owner_user_id=<novo>, owner_agent_id=null, owner_kind='user', assigned_at=now()` filtrado por `organization_id` e `id`, respeitando `crm_leads_owner_kind_coherence` (`baseline.sql:8160-8165`), conforme a decisão 3;
- sem negócio, ou com negócios ambíguos (`no_open_lead` / `ambiguous_open_leads`): não toca nada e registra log, igual ao que a função já faz com a timeline (`:123-130`);
- o gatilho `fn_emit_event_on_lead_change` já emite `lead.assigned` (`baseline.sql:8173-8197`). As automações por "lead atribuído" passam a disparar no Assumir sem código novo.

Faço isso em TypeScript e não dentro de `fn_conversation_assign` porque a RPC também é chamada pelo rodízio (`reason='routing'`) e pelo handoff, e o pedido é só sobre o **ato humano**. Na RPC, o card trocaria de dono a cada distribuição automática, e a mudança exigiria migration 0320, apêndice no baseline e MANIFEST. O custo do caminho em TS: claim e card não ficam na mesma transação. Se o update do card falhar, a conversa fica assumida e o card fica com o dono antigo, com log. É o mesmo nível de garantia que a timeline já tem.

### 2.6 Celular

Não trava, porque não há como. A mensagem continua aparecendo como "Celular", e a IA continua pausando como hoje. A trava cobre o que passa pelo CRM. Isso precisa estar dito no texto de ajuda da faixa, para ninguém achar que o celular está bloqueado.

---

## 3. Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **Travar só na tela** (desabilitar o Composer) | A API e o próprio bundle continuam enviando. A doutrina do handler é "quem garante é aqui" (`_handler.ts:613-615`). |
| **Travar na RLS** (`messages_insert` exige dono) | O handler de sessão grava com RLS, mas o eco, o watchdog e o agente gravam com service role. Uma policy com papel e dono na hora do INSERT custa uma migration e testa mal o caso do gerente. Ganho pequeno sobre o handler. |
| **Responder = assumir automaticamente** | É a opção B da decisão 1. É viável, mas muda o efeito de responder: hoje responder cala a IA por 5 min (`_handler.ts:276`), e assumir cala para sempre (`baseline.sql:32872`). Um clique a menos que desliga a IA sem a pessoa perceber. |
| **Avisar e deixar enviar** (trava "mole") | Não atende "só quem assumiu responde". Duas pessoas respondendo o mesmo cliente é justamente o defeito. |
| **Card sincronizado dentro da RPC** | Ver 2.5: pegaria o rodízio e o handoff, e exigiria migration. |

**Recomendação:** trava no handler, mais as duas portas laterais fechadas nas rotas, mais a faixa na tela e o card via `registrarTrocaDeComando`. Sem migration.

---

## 4. Riscos

1. **Conversa presa com dono ausente** (férias, desligado). Se o membro for revogado, `fn_conversation_assign` não exige que o dono **atual** seja ativo, e a conversa fica com ele. Mitigação: manager ou admin intervém, assume ou transfere (decisão 2). Para não depender do gerente lembrar, um aviso automático de "dono revogado" fica fora de escopo; se doer, vira issue.
2. **Mudança de hábito em org `all`.** Quem respondia conversa de colega passa a receber 409. Isso precisa constar no fragmento `.changes/` (`capacidade_nova`) e na faixa da tela, com texto claro.
3. **Corrida** entre ler o dono e inserir a mensagem: questão de milissegundos. Pior caso, sai uma mensagem logo após a troca de dono, sem dano de dados. Não vale um lock.
4. **Card sobrescrito** (decisão 3): um vendedor designado manualmente perde o card para quem assumiu a conversa. Isso fica visível em `lead.assigned` e na timeline.
5. **Conflito com `fix/pacote-5-whatsapp-inbox`**: a branch mexe em `_handler.ts:137` (MSG_COLS) e no bloco pós-envio (`~:904`). Esta entrega mexe em `:315` e depois de `:384`. São hunks diferentes e o risco é baixo, mas **implementar depois que o pacote-5 entrar na main**, com merge da main antes de começar. O pacote-5 também mexe em `lib/waha/ingest.ts`, que esta entrega não toca.
6. **E2E existentes** que enviam sem assumir: rodar a suíte e ajustar quem enviava "de carona". Candidatos: `tests/e2e/queue-assign.spec.ts`, `escalacao-ciclo`, `inbox-*`.

---

## 5. Decisões do André (3)

> **Decidido pelo André em 07/10/2026:** todas as recomendações desta seção foram aceitas.

**D1. Conversa sem dono: o que acontece quando alguém tenta responder?**
- A) Precisa assumir. A caixa mostra o botão **Assumir e responder**, e um clique faz as duas coisas. *(recomendado)*
- B) Responder assume sozinho, sem botão.
- *Por que A:* fica explícito que a IA vai parar **de vez** nessa conversa (o efeito do Assumir desde a 0173). Com B, a IA desliga sem a pessoa ver.

**D2. Gerente e admin na conversa de outro atendente**
- A) Respondem sem assumir. A bolha mostra o nome, o audit marca `fora_do_dono`, e o dono continua dono. Ganham também o botão "Assumir" para tomar a conversa quando quiserem. *(recomendado)*
- B) Precisam assumir (tomar a conversa) antes de responder.
- *Por que A:* o gerente intervém em uma mensagem ("vou te passar o valor correto") sem tirar a conversa do atendente. Assumir continua à mão quando for para ficar.

**D3. Responsável do card quando alguém assume ou recebe transferência**
- A) Sempre passa a ser quem assumiu ou recebeu (inclusive se o card era de um agente de IA ou de outra pessoa). *(recomendado)*
- B) Só preenche se o card estiver sem responsável ou com agente de IA. Se já tiver uma pessoa, mantém.
- *Por que A:* é o que você pediu ("Assumir grava o Responsável") e mantém um dono só. A troca fica registrada (`lead.assigned`). Escolha B se, na sua operação, quem atende a conversa (SDR) não é quem é dono do negócio (closer).

Fixo sem precisar de decisão: "Liberar" **não** mexe no card, e a conversa com mais de um negócio aberto ambíguo **não** mexe no card (só registra log).

---

## 6. Plano de testes

**Unit (Vitest, `pnpm test:unit` inteiro):**
- `lib/inbox/trava-de-dono.test.ts`: a matriz da regra. Dono, sem dono, de outro; viewer, provider, agent, manager, admin; papel ausente falha fechado.
- `tests/unit/envio-respeita-dono.test.ts` (handler com supabase fake):
  - agent em conversa de outro: 409 `conversation_owned_by_other` e **nenhum insert**;
  - agent sem dono: 409 `claim_required`;
  - manager em conversa de outro: 201 com `fora_do_dono` no audit;
  - `ai_agent`, `webhook_source` e `api_token` em conversa assumida não são barrados pela trava (controle: as outras recusas continuam).
- Transfer: agent não-dono recebe 403; dono, manager e conversa sem dono passam. Claim com takeover: agent recebe 403, manager passa.
- `registrarTrocaDeComando` com `novoResponsavel`: atualiza o lead roteado com `owner_kind='user'` e `owner_agent_id=null`; com `ambiguous_open_leads` e `no_open_lead`, nenhum update.

**Invariantes (`pnpm test:db`):** não há mudança de schema. Mesmo assim, rodar uma vez, porque a doutrina pede isso para mudanças em atribuição. Não crio invariante novo, já que a regra mora no TS.

**E2E (Playwright, ambiente fresco estilo VPS, pela tela), spec nova `tests/e2e/trava-de-dono.spec.ts` incluída em `SPECS_PARTE_*`:**
1. Org em `all`, dois agents. A assume. B abre a conversa e vê a faixa "Esta conversa está com A", com a caixa de resposta barrada e a nota liberada.
2. B numa conversa sem dono: clica **Assumir e responder**, a mensagem sai e o card do funil mostra B como Responsável.
3. Manager responde na conversa de A: a bolha mostra o nome do manager e A continua dono.
4. A transfere para B: o card passa para B.
- Evidência em `.superpowers/evidence/`, e o mapa `docs/testing/user-journey-map.md` atualizado.

**Celular:** sem teste novo. `lib/waha/ingest-celular.test.ts` já cobre, e o comportamento não muda.

## 7. Tamanho estimado

- **Código:** cerca de 150 a 200 linhas. Regra pura (~20), handler (~20), auth-dual (1), transfer e claim (~25), `registrarTrocaDeComando` (~30), Composer, InboxLayout e Header (~60), mais i18n (pt/es).
- **Testes:** cerca de 300 linhas de unit, mais 1 spec E2E.
- **Sem** migration, baseline ou MANIFEST.
- **Fragmento `.changes/`:** `capacidade_nova`.
- **Esforço:** **M**, de 1 a 1,5 dia com a prova E2E. Começar só depois do merge do `fix/pacote-5-whatsapp-inbox`.
