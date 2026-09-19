# Recursos e Durações da Agenda Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer a agenda reservar profissional, unidade e sala, usando duração do Catálogo de Produtos e grade de cinco minutos.

**Architecture:** `catalog_products` recebe a duração operacional opcional e `calendar_event_types` pode apontar para um produto do catálogo. Unidades e salas são recursos genéricos da organização; cada compromisso guarda as referências e uma cópia da duração usada. O motor de disponibilidade bloqueia sobreposição de sala e mantém a exceção de simultaneidade da Isadora como regra configurável, sem nomes da clínica no código.

**Tech Stack:** PostgreSQL/Supabase RLS, TypeScript 6, Zod 4, Next.js 16, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-09-19-agenda-equipe-permissoes-design.md`

## Global Constraints

- Grade de cinco minutos.
- Um profissional não ocupa dois compromissos simultâneos, salvo regra explícita de simultaneidade.
- Uma sala nunca recebe dois compromissos no mesmo período.
- A duração dos demais serviços vem do Catálogo de Produtos.
- A duração usada fica copiada no compromisso e não muda retroativamente.
- Serviço sem duração não é oferecido automaticamente pela IA.
- Nenhum nome, endereço ou capacidade do Instituto Eva fica hardcoded no produto genérico.
- Toda migration sai em tripla: migration, baseline e manifesto.

---

### Task 1: Modelar unidades, salas e duração do catálogo

**Files:**
- Create: `supabase/migrations/20260919160000_0271_recursos_e_duracao_da_agenda.sql`
- Modify: `supabase/baseline.sql`
- Modify: `supabase/migrations/MANIFEST.md`
- Modify: `lib/database.types.ts`
- Test: `tests/invariants/agenda-recursos-e-duracao.test.ts`

**Interfaces:**
- Produces: `calendar_locations`, `calendar_rooms`.
- Produces: `catalog_products.duration_minutes integer null`.
- Produces: `calendar_event_types.catalog_product_id uuid null`.
- Produces: `calendar_appointments.location_id`, `room_id`, `scheduled_duration_minutes`.

- [ ] Escrever teste vermelho para isolamento por organização, duração mínima de 5 minutos, sala pertencente à unidade e cópia histórica da duração.
- [ ] Rodar o teste e confirmar ausência das colunas/tabelas.
- [ ] Criar tabelas, FKs, índices, RLS e constraints idempotentes.
- [ ] Atualizar baseline, manifesto e tipos gerados.
- [ ] Rodar o teste focado e `pnpm lint:role-rank`.
- [ ] Commit: `feat(agenda): adiciona unidades salas e duracoes`.

### Task 2: Administrar recursos e duração pelas telas existentes

**Files:**
- Modify: `lib/schemas/produtos.ts`
- Modify: `app/api/v1/products/route.ts`
- Modify: `app/api/v1/products/[id]/route.ts`
- Modify: `app/app/products/_client.tsx`
- Create: `app/api/v1/agenda/recursos/route.ts`
- Create: `app/api/v1/agenda/recursos/route.test.ts`
- Modify: `app/app/settings/tenant/agenda/_client.tsx`
- Test: `tests/unit/agenda-recursos-na-configuracao.test.tsx`

**Interfaces:**
- Consumes: tabelas e colunas da Task 1.
- Produces: CRUD de unidades/salas para gerente+ e campo de duração no catálogo.

- [ ] Escrever testes vermelhos de validação e autorização.
- [ ] Adicionar `duration_minutes` aos schemas e à tela de produtos.
- [ ] Criar rota de unidades/salas com desativação, sem exclusão de histórico.
- [ ] Adicionar configuração visual na Agenda.
- [ ] Rodar unitários, typecheck e lint.
- [ ] Commit: `feat(agenda): configura salas e duracao dos servicos`.

### Task 3: Reservar sala e preservar duração no compromisso

**Files:**
- Modify: `app/api/v1/agenda/agendamentos/_handler.ts`
- Modify: `lib/agenda/consulta.ts`
- Modify: `lib/agenda/horarios-livres.ts`
- Modify: `app/api/v1/agenda/horarios-livres/route.ts`
- Test: `tests/invariants/agenda-conflito-de-sala.test.ts`
- Test: `tests/unit/agenda-duracao-do-catalogo.test.ts`

**Interfaces:**
- Consumes: `location_id`, `room_id`, `scheduled_duration_minutes`.
- Produces: seleção automática de sala compatível e livre, com rechecagem transacional.

- [ ] Escrever testes vermelhos de dupla reserva e snapshot histórico.
- [ ] Fazer a consulta de horários considerar ocupação do profissional e da sala.
- [ ] Escolher deterministicamente a primeira sala livre compatível.
- [ ] Revalidar e gravar sala/duração na criação e remarcação.
- [ ] Rodar testes focados e banco completo.
- [ ] Commit: `feat(agenda): reserva sala e congela duracao`.

### Task 4: Regras configuráveis de simultaneidade

**Files:**
- Create: `supabase/migrations/20260919170000_0272_regras_de_simultaneidade.sql`
- Modify: `supabase/baseline.sql`
- Modify: `supabase/migrations/MANIFEST.md`
- Create: `lib/agenda/simultaneidade.ts`
- Modify: `lib/agenda/horarios-livres.ts`
- Modify: `app/api/v1/agenda/agendamentos/_handler.ts`
- Test: `tests/invariants/agenda-simultaneidade-configuravel.test.ts`

**Interfaces:**
- Produces: regra por profissional, unidade e par de categorias de serviço.
- Produces: limite simultâneo configurável sem referência nominal à Isadora.

- [ ] Escrever testes vermelhos para pares permitidos, pares iguais bloqueados e sala sempre exclusiva.
- [ ] Criar configuração genérica de simultaneidade e RLS manager+.
- [ ] Aplicar a regra no motor e na confirmação transacional.
- [ ] Rodar banco completo, typecheck e lint.
- [ ] Commit: `feat(agenda): configura simultaneidade por servico`.

### Task 5: Fechar a entrega e preparar dados da clínica

**Files:**
- Create: `docs/runbooks/configurar-recursos-agenda-instituto-eva.md`
- Create: `.changes/recursos-e-duracoes-da-agenda.md`
- Modify: `docs/superpowers/specs/2026-09-19-agenda-equipe-permissoes-design.md`

- [ ] Documentar Vitória, Serra, salas e durações confirmadas como configuração pós-deploy.
- [ ] Registrar que intravenosa = 30 minutos e intramuscular = 7 minutos.
- [ ] Rodar `pnpm typecheck`, `pnpm lint`, testes focados e `pnpm test:db`.
- [ ] Commit: `docs(agenda): registra recursos e duracoes`.
