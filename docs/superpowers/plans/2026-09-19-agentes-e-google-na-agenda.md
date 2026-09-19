# Agentes e Google na Agenda Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que Cintia IA e Isadora IA agendem, remarquem e cancelem com evidência do pedido do paciente, mantendo Google e equipe informados.

**Architecture:** Reutilizar as ferramentas MCP e os handlers de agenda existentes. Acrescentar evidência obrigatória para mutações por IA, revisão humana abaixo de 24 horas e propagação de unidade/sala; o CRM grava primeiro e o Google continua como espelho assíncrono com pendência visível.

**Tech Stack:** MCP, Vercel AI SDK, Next.js 16, Supabase, Google Calendar OAuth, Vitest 4, Playwright 1.

**Spec:** `docs/superpowers/specs/2026-09-19-agenda-equipe-permissoes-design.md`

## Global Constraints

- Cintia IA e Isadora IA podem consultar, agendar, remarcar e cancelar.
- Cancelamento exige pedido claro do paciente e motivo auditável.
- Remarcação com 24 horas ou mais preserva o sinal.
- Remarcação abaixo de 24 horas cria revisão humana e não confirma novo horário automaticamente.
- A IA nunca promete devolução, dispensa ou redução do sinal.
- Falha no Google não apaga o compromisso; cria pendência para o gerente.
- Nenhuma IA exclui histórico.

---

### Task 1: Exigir evidência de mensagem nas mutações por IA

**Files:**
- Modify: `lib/mcp/tools/agendamento.ts`
- Modify: `app/api/v1/agenda/agendamentos/_handler.ts`
- Create: `lib/agenda/evidencia-do-paciente.ts`
- Modify: `lib/audit/actions.ts`
- Test: `tests/unit/agenda-ia-exige-pedido-do-paciente.test.ts`
- Test: `tests/invariants/agenda-mcp-nao-alcanca-contato-alheio.test.ts`

**Interfaces:**
- Produces: `validarEvidenciaDoPaciente({ organizationId, appointmentId, messageId, action }): Promise<EvidenciaValida>`.
- Produces: campos MCP `customer_request_message_id` em remarcação e cancelamento.
- Produces: audit metadata `{ evidence_message_id, patient_requested: true }`.

- [ ] **Step 1: Escrever testes de recusa e sucesso**

```ts
expect(await cancelarSemMensagem()).toMatchObject({ cancelado: false, motivo: "agenda_pedido_do_paciente_obrigatorio" });
expect(await cancelarComMensagemDeOutroContato()).toMatchObject({ cancelado: false, motivo: "agenda_evidencia_invalida" });
expect(await cancelarComMensagemInboundDoPaciente()).toMatchObject({ cancelado: true });
```

- [ ] **Step 2: Confirmar a falha**

Run: `pnpm vitest run tests/unit/agenda-ia-exige-pedido-do-paciente.test.ts tests/invariants/agenda-mcp-nao-alcanca-contato-alheio.test.ts`

Expected: FAIL porque as tools aceitam apenas compromisso, horário e motivo.

- [ ] **Step 3: Implementar validação estrutural da evidência**

A mensagem deve ser `inbound`, pertencer à organização, ao contato do compromisso e à conversa associada. O helper não interpreta clinicamente o texto; a frase fica preservada no audit para revisão.

- [ ] **Step 4: Exigir evidência apenas quando `ctx.actor.type === "ai"`**

Usuários humanos continuam podendo operar pela tela. IA sem mensagem válida recebe recusa de negócio e orientação para encaminhar à equipe.

- [ ] **Step 5: Rodar os testes**

Run: `pnpm vitest run tests/unit/agenda-ia-exige-pedido-do-paciente.test.ts tests/invariants/agenda-mcp-nao-alcanca-contato-alheio.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/mcp/tools/agendamento.ts app/api/v1/agenda/agendamentos/_handler.ts lib/agenda/evidencia-do-paciente.ts lib/audit/actions.ts tests/unit/agenda-ia-exige-pedido-do-paciente.test.ts tests/invariants/agenda-mcp-nao-alcanca-contato-alheio.test.ts
git commit -m "feat(agenda): exige pedido do paciente para a IA"
```

### Task 2: Criar revisão humana para remarcação abaixo de 24 horas

**Files:**
- Create: `supabase/migrations/20260919160000_0271_revisao_de_remarcacao.sql`
- Modify: `supabase/baseline.sql`
- Modify: `supabase/migrations/MANIFEST.md`
- Create: `lib/agenda/politica-de-remarcacao.ts`
- Modify: `lib/mcp/tools/agendamento.ts`
- Modify: `app/api/v1/agenda/agendamentos/_handler.ts`
- Modify: `app/app/agenda/_client.tsx`
- Test: `tests/unit/agenda-politica-de-remarcacao.test.ts`
- Test: `tests/invariants/agenda-revisao-de-remarcacao.test.ts`

**Interfaces:**
- Produces: `calendar_change_reviews` com ação, compromisso, horário proposto, evidência, motivo, status e decisão humana.
- Produces: `avaliarRemarcacao(agora, inicioAtual): "preserva_sinal" | "revisao_humana"`.

- [ ] **Step 1: Escrever o limite exato de 24 horas**

```ts
expect(avaliarRemarcacao(agora, mais24h)).toBe("preserva_sinal");
expect(avaliarRemarcacao(agora, mais23h59)).toBe("revisao_humana");
```

- [ ] **Step 2: Confirmar a falha**

Run: `pnpm vitest run tests/unit/agenda-politica-de-remarcacao.test.ts tests/invariants/agenda-revisao-de-remarcacao.test.ts`

Expected: FAIL porque não existe dossiê de revisão.

- [ ] **Step 3: Criar schema, RLS e audit da revisão**

IA pode criar proposta; `agent+` humano pode decidir; somente a decisão aprovada chama o mesmo handler de remarcação. Uma proposta não ocupa o novo horário e informa isso explicitamente ao paciente.

- [ ] **Step 4: Implementar a política no handler MCP**

Com 24 horas ou mais, remarcar normalmente e registrar `signal_policy = preserved`. Abaixo disso, criar revisão e responder `{ remarcado:false, requer_revisao_humana:true }`, sem cancelar nem mover o compromisso atual.

- [ ] **Step 5: Mostrar pendência na Agenda**

Exibir proposta, mensagem do paciente, horário atual e horário pretendido, com botões Aprovar e Recusar. A decisão emite atividade e fica no audit.

- [ ] **Step 6: Rodar testes**

Run: `pnpm vitest run tests/unit/agenda-politica-de-remarcacao.test.ts tests/invariants/agenda-revisao-de-remarcacao.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260919160000_0271_revisao_de_remarcacao.sql supabase/baseline.sql supabase/migrations/MANIFEST.md lib/agenda app/api/v1/agenda/agendamentos app/app/agenda tests/unit/agenda-politica-de-remarcacao.test.ts tests/invariants/agenda-revisao-de-remarcacao.test.ts
git commit -m "feat(agenda): revisa remarcacao em menos de 24 horas"
```

### Task 3: Levar unidade, sala e duração pelas tools MCP

**Files:**
- Modify: `lib/mcp/tools/agendamento.ts`
- Modify: `lib/agenda/consulta.ts`
- Modify: `app/api/v1/agenda/agendamentos/_handler.ts`
- Test: `tests/unit/a-ferramenta-que-consulta-e-marca.test.ts`
- Test: `tests/unit/agenda-mcp-recursos.test.ts`

**Interfaces:**
- Produces: slot MCP `{ inicio, quando, unit_id, unit_name, duration_minutes }`.
- Produces: resposta de marcação `{ compromisso, unit_name, room_name, aguarda_confirmacao }`.

- [ ] **Step 1: Escrever teste de travessia completa**

Consultar horários de um serviço presencial deve retornar unidade e duração. Marcar o slot deve reservar uma sala compatível e devolver seus nomes sem expor detalhes internos desnecessários.

- [ ] **Step 2: Confirmar a falha**

Run: `pnpm vitest run tests/unit/a-ferramenta-que-consulta-e-marca.test.ts tests/unit/agenda-mcp-recursos.test.ts`

Expected: FAIL porque os payloads atuais não carregam recurso físico.

- [ ] **Step 3: Acrescentar os campos à resposta de horários**

Não permitir que o modelo invente `room_id`: ele escolhe serviço, profissional, unidade e um `starts_at` retornado; o servidor escolhe a sala.

- [ ] **Step 4: Ensinar recusas acionáveis**

`servico_sem_duracao` orienta a equipe a preencher o Catálogo; `agenda_sem_sala_compativel` informa que a equipe precisa confirmar. Nenhuma recusa deve virar promessa ao paciente.

- [ ] **Step 5: Rodar testes e commit**

Run: `pnpm vitest run tests/unit/a-ferramenta-que-consulta-e-marca.test.ts tests/unit/agenda-mcp-recursos.test.ts`

```bash
git add lib/mcp/tools/agendamento.ts lib/agenda/consulta.ts app/api/v1/agenda/agendamentos/_handler.ts tests/unit/a-ferramenta-que-consulta-e-marca.test.ts tests/unit/agenda-mcp-recursos.test.ts
git commit -m "feat(agenda): leva unidade e sala para os agentes"
```

### Task 4: Garantir CRM primeiro e Google com pendência visível

**Files:**
- Modify: `lib/agenda/google/evento.ts`
- Modify: `lib/agenda/google/sync-executor.ts`
- Modify: `lib/agenda/google/sync-store.ts`
- Modify: `app/api/v1/cron/agenda-google-push/route.ts`
- Modify: `app/api/v1/cron/agenda-google-sync/route.ts`
- Modify: `app/app/settings/tenant/agenda/_client.tsx`
- Test: `tests/unit/agenda-google-evento.test.ts`
- Test: `tests/e2e/agenda-google-sync.spec.ts`

**Interfaces:**
- Consumes: agendamento já gravado com unidade e sala.
- Produces: descrição Google com serviço, unidade e sala; falha grava `google_sync_error` e aparece como pendência.

- [ ] **Step 1: Escrever teste de falha do Google**

O teste grava o compromisso no CRM, força falha no adaptador Google e confirma que o compromisso permanece `confirmed`, com `google_sync_error` visível.

- [ ] **Step 2: Confirmar a falha do comportamento visual**

Run: `pnpm vitest run tests/unit/agenda-google-evento.test.ts`

Expected: FAIL enquanto unidade e sala não chegam ao evento e à pendência.

- [ ] **Step 3: Acrescentar recursos ao evento e preservar a escrita local**

O worker nunca desfaz o compromisso por falha externa. Retry usa a mesma fila existente e a tela oferece “Tentar sincronizar novamente”.

- [ ] **Step 4: Rodar unitário e E2E**

Run: `pnpm vitest run tests/unit/agenda-google-evento.test.ts`

Run: `pnpm playwright test tests/e2e/agenda-google-sync.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agenda/google app/api/v1/cron/agenda-google-push app/api/v1/cron/agenda-google-sync app/app/settings/tenant/agenda tests/unit/agenda-google-evento.test.ts tests/e2e/agenda-google-sync.spec.ts
git commit -m "feat(agenda): mostra pendencias do Google"
```

### Task 5: Validar Cintia e Isadora sem publicar

**Files:**
- Create: `tests/e2e/agentes-remarcam-e-cancelam.spec.ts`
- Create: `.changes/agentes-operam-a-agenda.md`

- [ ] **Step 1: Criar jornada E2E com agente publicado de teste**

Cobrir: consulta de vaga, marcação, remarcação acima de 24 horas, proposta abaixo de 24 horas, cancelamento com mensagem inbound e recusa sem evidência.

- [ ] **Step 2: Rodar os gates**

Run: `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:db && pnpm build`

Run: `pnpm playwright test tests/e2e/agentes-remarcam-e-cancelam.spec.ts tests/e2e/agenda-google-sync.spec.ts`

Expected: exit code 0 em todos.

- [ ] **Step 3: Sabotar a exigência de evidência**

Remover temporariamente a chamada a `validarEvidenciaDoPaciente`, rodar `agenda-ia-exige-pedido-do-paciente.test.ts` e confirmar vermelho. Restaurar e confirmar verde.

- [ ] **Step 4: Criar fragmento de release**

```markdown
---
impacto: capacidade_nova
secao: adicionado
titulo: Agentes operam a agenda com pedido comprovado do paciente
---
Agentes podem marcar, remarcar e cancelar compromissos, preservando histórico, regras de sinal, recursos físicos e revisão humana quando necessária.
```

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/agentes-remarcam-e-cancelam.spec.ts .changes/agentes-operam-a-agenda.md
git commit -m "test(agenda): cobre operacao segura pelos agentes"
```
