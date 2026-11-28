# Paciente confirma pelo lembrete — plano de implementação

> **Para quem executa:** use superpowers:subagent-driven-development. Os passos usam caixas `- [ ]`.

**Objetivo:** o paciente responde SIM ao lembrete, e o CRM marca "Presença confirmada" no compromisso, sem mudar o status nem responder sozinho.

**Arquitetura:**
- Colunas `patient_confirmed_*` em `calendar_appointments`, gravadas só pelo RPC `fn_appointment_patient_confirm`.
- O lembrete carimba o id do compromisso na mensagem.
- Um efeito novo em `pos-entrada` lê a resposta isolada e chama o RPC.
- A recepção também marca pelo painel.
- A grade e o painel mostram a marca.

**Stack:** Next.js 16, Supabase/Postgres, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-28-paciente-confirma-pelo-lembrete-design.md`. É a autoridade: leia antes de qualquer tarefa.

## Restrições globais

- Migration **0441** (reservada), com o arquivo `supabase/migrations/<timestamp>_0441_paciente_confirma_presenca.sql`, apêndice idempotente no fim de `supabase/baseline.sql`, entre `-- ---- paciente confirma a presença (migration 0441) ----` e `-- ---- fim: … ----`, e linha no `supabase/migrations/MANIFEST.md`.
- O RPC novo termina com `revoke execute … from public, anon;` e `grant execute … to service_role;`.
- Nada de `console.log`. Use o logger do repo. Zod em todo input externo. A rota mutante audita.
- A chave `calendar_event_types.reminder_asks_confirmation` vem **desligada** por padrão.
- A frase fica numa constante única: `FRASE_PEDIDO_DE_CONFIRMACAO = "Para confirmar sua presença, responda SIM."`, em `lib/agenda/confirmacao-do-lembrete.ts`.
- A origem fica gravada como `'mensagem' | 'equipe'`. Vocabulário em constante compartilhada.
- Nunca use `git stash`, `reset --hard` nem `add -A`. Os commits terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Gates por tarefa: `pnpm typecheck`, `pnpm lint` e os testes tocados. Antes da revisão final: `pnpm test:unit` inteiro, com exit code conferido.

## Foco de revisão (o que os testes de cada tarefa têm de cobrir)

1. "sim" depois de OUTRA mensagem da clínica posterior ao lembrete não confirma.
2. Remarcar (`starts_at` muda) apaga a confirmação.
3. Compromisso passado, pendente, cancelado ou de revisão antiga não é confirmado, nem pelo RPC nem pela tela.
4. "sim, mas…", "não", "remarcar", "1 hora" e "sim?" não confirmam. "SIM!", "Sim.", "👍" e "confirmo" confirmam.
5. O efeito novo nunca impede `pedirDespachoDoAgente`: ele falha aberto.

---

### Tarefa 1: banco

**Arquivos:**
- migration 0441 nova;
- apêndice no `supabase/baseline.sql`;
- `supabase/migrations/MANIFEST.md`;
- `lib/database.types.ts`: só os campos novos, à mão, no padrão do arquivo;
- invariante nova `tests/invariants/paciente-confirma-presenca.test.ts`, no padrão das irmãs (ex.: as de `fn_appointment_change`).

**Conteúdo:**
- As colunas da spec (seção Banco), com `add column if not exists`.
- `reminder_asks_confirmation boolean not null default false` em `calendar_event_types`.
- `fn_appointment_stamp`: ao mudar `starts_at` em UPDATE, zera as 4 colunas `patient_confirmed_*`. Use `create or replace`, copiando a função atual e acrescentando só isso.
- `fn_appointment_patient_confirm(p_appointment_id uuid, p_expected_revision int, p_source text, p_message_id uuid, p_user_id uuid) returns text`, `security definer`, `set search_path = public`. Devolve:
  - `'confirmado'` quando grava;
  - `'ja_confirmado'` quando já havia confirmação;
  - `'nao_se_aplica'` quando o status não é `confirmed`, `starts_at <= now()` ou a revisão não bate.

  Ela trava a linha com `for update`. Não incrementa `revision`: não é mudança de horário nem de status, e o trigger só incrementa nos campos listados (confira).
- **Invariante:** as 5 situações do Foco de revisão 2 e 3, mais o grant (anon não executa).

**Prova:** `pnpm test:db` local, se houver Postgres; senão, explique o que deixou de rodar. Faça também o install e o update do baseline num `pgvector/pgvector:pg15` descartável, como manda o CLAUDE.md.

### Tarefa 2: leitor da resposta + efeito na entrada

**Arquivos:**
- novo `lib/agenda/confirmacao-do-lembrete.ts` e o teste ao lado;
- `lib/channels/pos-entrada.ts`;
- `tests/unit/pos-entrada-efeitos-do-canal.test.ts`.

**Conteúdo:**
- `ehConfirmacaoDePresenca(texto: string): boolean`, pura.
  - Normaliza com o `normalizarTexto` do `lib/opt-out/deteccao.ts` (reuse; não copie).
  - Aceita a lista da spec (decisão 4); a mensagem inteira tem de ser a confirmação.
  - Frases de controle positivas e negativas no teste (Foco 4).
- `lerConfirmacaoDoLembrete({ organizationId, conversationId, messageId, body, admin })`:
  1. Só segue se `ehConfirmacaoDePresenca(body)` aprovar.
  2. Busca a última mensagem outbound da conversa.
  3. Se ela não tiver `metadata.agenda_lembrete`, para: o "sim" responde a outra coisa (Foco 1).
  4. Chama o RPC com `appointment_id` e `revision` do carimbo, `source='mensagem'` e `p_message_id` igual à mensagem do paciente.
  5. Se der `'confirmado'`: grava atividade na timeline do lead, no padrão das atividades da agenda, e auditoria `agenda.paciente_confirmou` (ator sistema, metadata com `appointment_id` e `source`).
  6. Filtra `organization_id` em todas as queries (admin client).
- **Em `pos-entrada.ts`:** chama logo depois do opt-out, sem `await` bloqueante do despacho. Siga o padrão de efeito fire-and-forget que já existe no arquivo, com `.catch` registrando no logger (Foco 5).

### Tarefa 3: lembrete carimba + frase + chave no tipo

**Arquivos:**
- `app/api/v1/cron/agenda-reminder/route.ts` e testes;
- `lib/agenda/texto-do-lembrete.ts` e teste;
- `app/api/v1/agenda/tipos/route.ts`: Zod e PATCH aceitam `reminder_asks_confirmation`;
- `app/app/settings/tenant/agenda/_client.tsx`: chave "Pedir confirmação no lembrete", com prévia que mostra a frase acrescentada.

**Conteúdo:**
- `montarLembrete` acrescenta `FRASE_PEDIDO_DE_CONFIRMACAO` (com um espaço ou quebra de linha antes) quando o tipo tem a chave, inclusive no texto padrão e no modelo legado.
- O envio passa `metadata: { agenda_lembrete: { appointment_id, revision } }` à mensagem outbound.
  - Confira como `sendMessageHandler` aceita `metadata`. Se não aceitar, acrescente o campo opcional sem mudar os outros chamadores.
  - O carimbo vai em todo lembrete, com ou sem a chave.
- O select do cron passa a trazer `reminder_asks_confirmation`.

### Tarefa 4: equipe marca + leituras + bloco do agente

**Arquivos:**
- `app/api/v1/agenda/agendamentos/route.ts` + `_handler.ts`: ação `paciente_confirmou`.
  - Pode ser um campo `patient_confirmed: true` no `alterarSchema`; escolha o que casar com o schema atual e registre a escolha.
  - Papel ≥ `agent`. Chama o RPC com `source='equipe'` e `p_user_id`. Audita.
  - Erros: `nao_se_aplica` vira 409 com código canônico. Crie em `lib/api/errors.ts` se faltar.
- `app/api/v1/agenda/agendamentos/[id]/route.ts` e `hooks/agenda/useAgendamentos.ts` (com a rota de lista que ele usa): trazem `patient_confirmed_at`, `patient_confirmed_source` e `reminder_sent_at`.
- `lib/agent-engine/agent/compromissos-do-contato.ts`: a linha do compromisso ganha "presença confirmada pelo paciente em DD/MM HH:mm", no fuso da org, quando houver. Teste do bloco.

### Tarefa 5: telas + e2e + documentação

**Arquivos:**
- `components/agenda/GradeDaAgenda.tsx` e `situacao-do-bloco.ts`, se for o lugar:
  - ícone de check (Phosphor, mesmo kit dos outros ícones de canto) com `aria-label` e `title` "Presença confirmada";
  - ícone "Lembrete sem resposta" quando `reminder_sent_at` existe, não há confirmação e o compromisso é futuro e `confirmed`;
  - os dois entram na legenda.
- `components/agenda/DetalheDoCompromisso.tsx`:
  - etiqueta abaixo do estado: "Presença confirmada · pelo WhatsApp em 26/11 às 14:32" ou "· pela equipe";
  - botão "Paciente confirmou", só em `confirmed` e antes do início, que faz PATCH, mostra toast de sucesso e atualiza a marca.
- Testes unitários dos componentes.
- Spec e2e nova `tests/e2e/agenda-paciente-confirma.spec.ts`, incluída em `SPECS_PARTE_*` do `.github/workflows/e2e.yml` (há teste que reprova spec esquecida):
  - liga a chave no tipo pela tela;
  - semeia um compromisso confirmado;
  - roda o cron de lembrete pelo endpoint, com o segredo do e2e;
  - injeta um "SIM" pela rota de ingestão de teste que as specs irmãs usam;
  - confere a marca no cartão e no painel;
  - confere o botão "Paciente confirmou" em outro compromisso.
- Fragmento `.changes/paciente-confirma-pelo-lembrete.md` (`capacidade_nova`).
- `docs/testing/user-journey-map.md` (casos novos da J14), marcado "NÃO MEDIDO em tela local" se não rodar aqui.
