# Biblioteca de mídias: a IA e o follow-up enviando imagem e vídeo

> Fase 2, item 3. Especificação para aprovar **antes** de codar.
> Medida contra a `origin/main` em `5b2e640f3` (2026-10-05). Produto genérico: serve para
> clínica, imobiliária, loja, curso. "Caso por sexo e objetivo" é só um exemplo de etiqueta.

## Resumo para o André (5 linhas)

1. Hoje a IA **só manda texto** no WhatsApp. Não existe lugar para guardar "o vídeo do médico" ou "o antes e depois de mulher, emagrecimento, 3 meses".
2. Proposta: uma tela **Biblioteca de mídias**. Você sobe o arquivo uma vez, dá um nome, diz *quando usar* e marca etiquetas (ex.: `mulher`, `emagrecimento`, `etapa: proposta`).
3. A IA ganha o poder de **mandar uma mídia da biblioteca**, e o follow-up ganha um passo **"Enviar mídia"**. Trocar o arquivo depois não exige mexer em nenhuma automação.
4. Toda mídia que mostra uma pessoa só sai se tiver **termo de uso de imagem** válido (data, para quê, até quando). Revogou o termo, para de sair na hora — para todo mundo.
5. Tamanho: médio (~2 a 3 semanas de uma pessoa). Você precisa decidir 3 coisas, no fim deste documento.

---

## 1. O problema, medido no código

| # | Fato | Onde |
|---|---|---|
| P1 | A tool que a IA usa para falar com o lead só aceita `body` (texto). Não há campo de mídia. | `lib/agent-engine/agent/inbound-turn.ts:193-198` (definição) e `:2730` (execução) |
| P2 | A tool MCP aceita `type: image\|video` mas **não recebe o arquivo**: o `parse` repassa só `conversation_id, type, body, media_mime`. `media_storage_path` nunca chega ao handler. Um `type:"image"` sem arquivo vira mensagem sem imagem. | `lib/mcp/tools/messages.ts:17-31` e `:47-52` |
| P3 | A IA nem pode usar a tool MCP: ela está bloqueada para o agente de propósito ("enviar é SEMPRE `send_message`"). | `lib/agent-engine/edge/crm/mcp-tools.ts:12` e `:38` |
| P4 | O envio de mídia **já funciona** no handler comum: recebe `media_storage_path`, assina URL de 10 min no bucket `whatsapp-media` e passa a URL ao canal (nunca base64). É a regra do repo, já cumprida. | `app/api/v1/messages/_handler.ts:823-845` |
| P5 | Mas o handler só aceita arquivo **dentro da pasta da conversa** (`org/conversa/arquivo`). Um arquivo de biblioteca, compartilhado por todas as conversas, é recusado com `invalid_media_path`. | `lib/messaging/media/upload-validation.ts:24-29`, chamado em `_handler.ts:394-405` |
| P6 | O upload de anexo de saída é **descartável**: reserva vale 24 h, teto de 20 pendentes/100 MB por organização, e o caminho é obrigatoriamente `org/conversa/out-*`. Não serve para guardar acervo. | `supabase/baseline.sql:29034-29068` (migration 0300); rota `app/api/v1/conversations/[id]/media/route.ts` |
| P7 | **Armadilha de LGPD:** ao anonimizar um contato, o banco recolhe TODO `messages.media_storage_path` das conversas dele e manda apagar do Storage. Se uma mensagem apontasse direto para o arquivo da biblioteca, anonimizar **um** paciente apagaria o vídeo do médico **para todos**. | `supabase/baseline.sql:352-358` (coleta) e `:475-481` (fila de apagar) |
| P8 | O passo "ação" do follow-up tem três modos — `text`, `ai_message`, `template` — todos só texto. A tabela `message_templates` só tem `body`. | `lib/followup/graph-schema.ts:213-227`; `lib/agent-engine/agent/followup-turn.ts:552-574`; `supabase/baseline.sql:7573` |
| P9 | Não existe registro de consentimento de **imagem**. O que existe é `contacts.consent` (marketing/transacional/perfilamento) — é do lead, não de quem aparece na foto. | `supabase/baseline.sql:1342` |
| P10 | Já existe sorteio determinístico de variante por lead (mesmo lead sempre cai na mesma). Serve para o A/B sem inventar nada. | `lib/agent-engine/agent/reentry-template.ts:108` |
| P11 | O Storage de um self-host é ~1 GB, dividido com `whatsapp-media`. Copiar um vídeo de 30 MB a cada envio esgota a cota em ~30 envios. | `CLAUDE.md` (seção Audit log, retenção) |

**Conclusão:** o canal sabe mandar mídia (P4). O que falta é (a) um acervo que não seja descartável nem apagável por LGPD de terceiro, (b) uma porta da IA e do follow-up até ele, e (c) o termo de imagem como trava no servidor.

---

## 2. Comportamento proposto

### 2.1 O que o usuário vê

**Tela nova `Biblioteca de mídias`** (grupo IA › "Ensinar o agente", ao lado de "Perguntas frequentes"; papel mínimo `manager`; entra no `lib/navigation/catalogo.ts`).

Cada item tem:
- **Nome** ("Vídeo do Dr. — apresentação") e **Quando usar** (frase que a IA lê: "quando o lead perguntar quem é o médico").
- **Etiquetas** livres (`mulher`, `emagrecimento`, `etapa:proposta`, `localizacao`).
- **Arquivo** (imagem ou vídeo; trocar = subir outro no mesmo item; o item, o id e as automações continuam iguais).
- **Variantes A/B** (opcional): até 2 arquivos no mesmo item. Cada lead sempre recebe a mesma variante (P10); a mensagem grava qual saiu.
- **Mostra pessoa identificável?** Se sim, bloco **Termo de uso de imagem**: nome do titular, data da assinatura, escopo (texto livre: "WhatsApp comercial da clínica"), validade (data ou "sem prazo"), arquivo do termo assinado (PDF/foto, opcional), botão **Revogar**.
- **Situação** visível: `Pronta` / `Sem termo` / `Termo vencido` / `Revogada` / `Arquivo ausente`. Só `Pronta` é enviável.
- **Prazo real** do caso ("resultado em 90 dias") é só texto no "Quando usar"/legenda — não precisa de campo (DIRC: é texto do operador, ninguém calcula com ele).

### 2.2 A IA enviando

- Nova tool do agente **`send_media`** `{ media_id, caption? }`, irmã de `send_message`. Mesmo caminho: guardrails → `sendTurnMessage` → handler → ledger (idempotência por `job_id+seq` já existente). Conta no mesmo teto de envios por turno.
- A IA descobre o que existe por uma lista curta no prompt do agente: `id · nome · quando usar · etiquetas`, só itens `Pronta` e, opcionalmente, filtrada pelas etiquetas do lead. Sem tool de busca nova enquanto o acervo for pequeno (dezenas de itens).
- A legenda (`caption`) passa pela **mesma cadeia de guardrails** do texto (`lib/agent-engine/guardrails/before-send.ts`): promessa, vocabulário interno, opt-out, janela de horário.
- Recusa vira **erro de ensino** ao modelo, nunca exceção: `media_not_found`, `media_consent_invalid`, `media_not_ready`.

### 2.3 O follow-up enviando

- Novo modo no passo "Ação": `{ mode: 'media', media_id, caption? }` em `actionConfigSchema`. Sem LLM, como o modo `text`.
- Publicar o fluxo **avisa** (não bloqueia) se a mídia está sem termo; na hora de rodar, mídia não enviável → o passo falha com motivo legível no histórico do enrollment e aviso na Central, igual aos outros vetos.
- Trocar o arquivo na biblioteca **não** republica fluxo: o passo guarda o `media_id`, não o arquivo.

### 2.4 Como o arquivo chega ao WhatsApp (o técnico)

- Arquivo mora em bucket privado **novo** `media-library`, caminho `org/<item>/<variante>-<uuid>.<ext>`. Separado do `whatsapp-media` para a anonimização nunca alcançá-lo (P7).
- Mensagem ganha a coluna `messages.media_library_item_id uuid references media_library_items(id) on delete set null` (+ `metadata.media_variant`). **`media_storage_path` fica nulo** nesses envios — por isso a LGPD (que só recolhe `media_storage_path`) não apaga o acervo, e o gatilho de anexo (`fn_attach_outbound_media`) não interfere.
- No handler, novo ramo ao lado do de `media_storage_path` (`_handler.ts:823`): resolve o item **filtrando `organization_id` da conversa**, revalida o termo **no momento do envio**, assina URL de 10 min no `media-library` e chama o mesmo `adapter.send({ kind, media })`. Zero código de canal novo.
- A tela da conversa mostra a mídia enviada resolvendo pelo item (rota `messages/[id]/media`). Se o item for apagado depois, a mensagem mostra "mídia removida da biblioteca" — o histórico de que saiu fica.

### 2.5 Termo de imagem — a regra

- Enviável = `contains_person = false` **ou** (`consent_signed_at` preenchido **e** `consent_revoked_at` nulo **e** (`consent_expires_at` nulo ou futuro)).
- A regra mora numa função pura (`lib/midias/termo.ts`) usada pela tela, pelo prompt e pelo handler. **O handler é a trava**; tela e prompt são conveniência.
- Revogar é imediato e **auditado** (`media_library.consent_revoked`). O que já foi enviado não volta (WhatsApp não permite) — a tela diz isso em uma linha ao revogar.
- Auditoria: `media_library.item_created|file_replaced|consent_recorded|consent_revoked|item_deleted`. Envio já é auditado pelo handler.

### 2.6 Schema (uma migration `0326`, idempotente, + apêndice no `baseline.sql` + linha no MANIFEST)

```sql
create table if not exists public.media_library_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  title text not null, when_to_use text not null default '',
  tags text[] not null default '{}',
  variants jsonb not null default '[]',      -- [{key:'A', storage_path, mime, size_bytes}], máx 2, schema Zod central
  contains_person boolean not null default true,
  consent_subject text, consent_scope text,
  consent_signed_at date, consent_expires_at date, consent_revoked_at timestamptz,
  consent_document_path text,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
-- RLS tenant_isolation_media_library_items_all via fn_user_org_ids(); GIN em tags.
alter table public.messages add column if not exists media_library_item_id uuid
  references public.media_library_items(id) on delete set null;
-- bucket privado 'media-library' (file_size_limit 50 MB; allowlist image/*, video/mp4, video/3gpp, application/pdf p/ o termo)
```

`contains_person` nasce `true` de propósito: quem esquece de marcar fica protegido, não exposto.

---

## 3. Alternativas

| Onde guardar e como enviar | Prós | Contras | Veredito |
|---|---|---|---|
| **A. Copiar o arquivo para a pasta da conversa a cada envio** (reusa 100% o fluxo atual) | Nenhuma mudança no handler | Cota de 1 GB some em dezenas de vídeos (P11); teto de 100 MB pendentes (P6) | Não |
| **B. Mensagem aponta direto para o arquivo da biblioteca** em `media_storage_path` | Diff mínimo | Recusado pelo guard (P5); **anonimizar um lead apaga o acervo de todos** (P7) | Não — é bug de LGPD |
| **C. Bucket próprio + `messages.media_library_item_id`** | Sem cópia, sem colisão com LGPD, trocar arquivo é trivial, conta envios por item | Um ramo novo no handler e na rota de visualização | **Recomendado** |

| Porta da IA | Veredito |
|---|---|
| Liberar `crm_send_whatsapp_message` para o agente | Não: quebra a doutrina "enviar é sempre `send_message`" (P3) e pula ledger/guardrails |
| `send_message` ganhar `media_id` opcional | Possível, mas mistura dois contratos numa tool que já tem muita regra |
| **Tool irmã `send_media`** | **Recomendado**: mesmo caminho por baixo, contrato limpo para o modelo |

| Follow-up | Veredito |
|---|---|
| `media_id` opcional dentro do modo `text` | Menos linhas, mas toda tela/legenda que lê `mode` passa a ter dois significados |
| **Modo novo `media`** | **Recomendado**: fluxos antigos intocados, um consumidor a mais em `engine.ts:245-256` e `eventos-legiveis.ts` |

Também consertar de carona o P2 (MCP repassar `media_storage_path`): 3 linhas, mas é **outro PR** — não depende desta feature.

---

## 4. Decisões que o André precisa tomar

> **Decidido pelo André em 07/10/2026:** todas as recomendações desta seção foram aceitas.

1. **Mídia sem pessoa precisa de termo?** (vídeo da fachada, mapa de localização)
   *Recomendo:* não. Um interruptor "Mostra pessoa identificável" (ligado por padrão). Exigir termo de fachada só gera atrito e itens mortos.
2. **A IA escolhe sozinha a mídia, ou só manda quando um passo/regra mandar?**
   *Recomendo:* sozinha, a partir do "Quando usar" — mas com teto de **1 mídia por turno** e só itens `Pronta`. Quem quiser controle total desliga a tool no agente (interruptor por agente, padrão ligado só se a biblioteca tiver itens).
3. **A/B entra agora ou depois?**
   *Recomendo:* o **campo** entra agora (até 2 variantes, sorteio fixo por lead, gravado na mensagem); o **painel comparando conversão A vs B** fica para depois. Sem o registro desde o primeiro dia não há o que comparar depois.

---

## 5. Riscos

| Risco | Mitigação |
|---|---|
| Vídeo grande demais para o WhatsApp (o canal recusa depois de aceitar) | Validar tamanho/formato no upload da biblioteca, não no envio; mostrar "pode não chegar" acima do limite do canal. Medir o limite real no WAHA NOWEB antes de fixar número |
| URL assinada de 10 min expira antes do canal baixar vídeo grande | Mesmo prazo que já funciona hoje para anexo (`_handler.ts:828`); medir com vídeo de 30 MB no teste real |
| Termo revogado no meio de um follow-up agendado | Checagem é no handler, na hora do envio, não no agendamento |
| Vazamento entre organizações | Item resolvido sempre com `organization_id` da conversa (service role); teste de isolamento com 2 orgs |
| IA mandando mídia em excesso (cara de robô, risco de banimento) | 1 mídia por turno; conta no teto de envios e no throttle anti-banimento existentes |
| Cota de Storage | Mostrar uso da biblioteca na tela; sem cópia por envio (alternativa C) |
| Apagar item com histórico | `on delete set null`: a conversa preserva que houve envio |

---

## 6. Plano de testes

- **Unit:** regra do termo (`lib/midias/termo.ts`: sem pessoa, assinado, vencido, revogado, sem data); sorteio A/B estável por lead; schema do modo `media` no `actionConfigSchema`; tool `send_media` devolvendo erro de ensino nos três casos.
- **Invariantes (`pnpm test:db`):** RLS de `media_library_items` com 2 organizações; anonimizar um contato que recebeu mídia da biblioteca **não** enfileira o arquivo do acervo para apagar (prova direta do P7); apêndice do baseline idempotente (install com `ON_ERROR_STOP=1` + update); `media_library_item_id` de outra org recusado.
- **E2E pela tela (P0 da doutrina de QA visual):** em banco fresco do `baseline.sql`, o leigo sobe um vídeo, marca termo, cria passo "Enviar mídia" no follow-up, dispara; troca o arquivo sem tocar no fluxo; revoga o termo e vê o passo recusar com motivo legível.
- **Receiver real:** WAHA local recebendo imagem e vídeo de verdade; conferir que a URL entregue é assinada e do bucket `media-library`, nunca base64.
- `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` (sem caminho), `pnpm test:db`, `pnpm test:e2e`.

---

## 7. Tamanho estimado

| Fatia (cada uma é um PR que fica de pé sozinho) | Tamanho |
|---|---|
| 1. Schema + bucket + tela da biblioteca com termo | M (4-5 dias) |
| 2. Ramo no handler + rota de visualização + teste LGPD | P-M (2-3 dias) |
| 3. Tool `send_media` no agente + lista no prompt + guardrails da legenda | M (3-4 dias) |
| 4. Modo `media` no follow-up (schema, motor, formulário, legenda do histórico) | P-M (2-3 dias) |
| 5. E2E fresco + evidência + fragmento em `.changes/` (`capacidade_nova`) | P (2 dias) |

**Total: ~2,5 a 3 semanas.** Fatias 3 e 4 são independentes depois da 2.

Fora de escopo agora: painel de resultado A/B, busca semântica na biblioteca (só quando passar de ~50 itens), mídia em templates oficiais da Meta (já existe rota própria em `app/api/v1/channels/partner/templates/media`), áudio e documento pela IA.
