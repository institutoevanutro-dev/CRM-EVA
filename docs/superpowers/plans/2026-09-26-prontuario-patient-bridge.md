# Ponte de pacientes do prontuário EVA — plano do CRM

**Base:** `origin/main` em 26/09/2026; worktree `feat/prontuario-patient-bridge`. Contrato aprovado em `prontuario-eva/docs/superpowers/specs/2026-09-26-pacientes-prontuario-crm-design.md`.

## 1. Leitura limitada e permissão exclusiva

- Estado local: rota de leitura, escopos visíveis e bypass ancorado do proxy implementados e testados; a permissão de escrita ainda não possui rota.
- Acrescentar `prontuario:contacts:read` e `prontuario:contacts:write` ao seletor de tokens. Não conceder `mcp:*`, `contacts:*` ou agenda implicitamente.
- Abrir no `public-paths.ts` somente as três rotas de integração, cada uma ancorada; autenticação Bearer e escopo ficam dentro da rota.
- `GET /api/v1/prontuario/contacts?search=...&limit=10`: organização da linha de `api_tokens`; resposta apenas `id,name,birthdate,phone_number,email,updated_at`, com `name` preenchido pelo nome exibido quando o nome cadastral estiver vazio. Buscar por nome/nome exibido/telefone/e-mail, excluir anonimizados/fundidos, limitar a 10. Testar 401/403, isolamento por organização e campos retornados.

## 2. Identidade e escrita atômica

- Adicionar migration `0284` (confirmar maior número antes de criar) para `prontuario_contact_links`: `organization_id`, `source_patient_id` opaco, `contact_id`, timestamps, chave única por `(organization_id,source_patient_id)` e `(organization_id,contact_id)`. RLS conforme `fn_user_org_ids()` e escrita reservada ao `service_role`. Migration + apêndice idempotente em `baseline.sql` + linha no MANIFEST + tipos gerados.
- Criar função transacional com `SECURITY DEFINER` restrita ao `service_role`: criar contato e vínculo com chave idempotente, ou devolver o vínculo existente; outra função aplica PATCH condicional usando `updated_at` esperado e retorna conflito sem gravação parcial. Revogar `EXECUTE` de `public, anon, authenticated`. A organização vem do Bearer validado e é conferida em todos os predicados.
- `POST /api/v1/prontuario/contacts` e `PATCH /api/v1/prontuario/contacts/[id]` aceitam só os quatro campos, ID opaco e chave idempotente/revisão esperada. Não aceitar organização, conteúdo clínico, CPF, tags, consentimentos ou campos livres do cliente. Auditar mutações bem-sucedidas e aplicar limite de taxa.
- Testar idempotência, chamada concorrente, colisão de vínculo, contato de outra organização, anonimização e atualização concorrente. Rodar `pnpm test:db` para RLS, instalação e reaplicação do baseline.

## 3. Conexão no prontuário e entrega

- No Site, usar segredo exclusivo para as rotas novas, nunca o token de agenda. Implementar prévia de candidatos e diferenças antes de vínculo/criação. Exigir confirmação explícita para dados reais.
- Enviar apenas o outbox do paciente vinculado, com revisão/chave de tentativa; sucesso só depois de resposta válida do CRM. Em 401/403, 409 ou falha de rede manter pendência visível e permitir reenvio manual.
- Testar ponta a ponta com contato fictício nos dois sistemas; publicar sem credencial, depois configurar a chave diretamente na interface segura. Antes de qualquer lote real, conferir backup, exclusões dos dois pacientes/21 atendimentos e prévia de vínculos.

## Gates

`pnpm typecheck`, `pnpm lint`, testes de rota, `pnpm test:db`, build e QA visual das telas tocadas. O trabalho local não prova deploy, token em produção ou sincronização real.
