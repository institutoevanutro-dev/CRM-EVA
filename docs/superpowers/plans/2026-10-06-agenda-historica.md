# Importação histórica da agenda

Objetivo aprovado: importar agendamentos passados, com prévia, sem sobrescrever existentes nem enviar avisos. Entrada operacional: JSON privado com identidades e horários conferidos. Não criar pacientes por semelhança de nome.

- [x] Criar importador transacional em `lib/agenda/importar-historico.ts` e comando `scripts/importar-agenda-historica.ts`. Zod valida o arquivo; exigir organização, ator ativo, responsável e destino explícitos. Prévia padrão; aplicação exige hash do arquivo conferido.
- [x] Migration 0320 + baseline + MANIFEST: origem histórica, chave única por organização, proteção de alterações e exclusão das automações Google/presença/classificação. Ajustar expiração de pendentes.
- [x] Provar em Postgres: prévia sem escrita, replay sem duplicação, conflito sem escrita parcial, isolamento, preservação dos status e nenhuma fila/aviso/Google. Rodar typecheck, lint, unit e banco.
- [ ] Conferir dados atuais de origem e alvo. Aplicar só linhas verificadas e conferir agenda e auditoria após importação. Pendências ficam no relatório privado.

Sistema Vivo: arquivo conferido → importador → `calendar_appointments` → Agenda existente e prontuário via MCP. `api_audit_log` registra lote/IDs, sem nomes. Prévia mostra conflitos para correção humana. Histórico não abre demanda nem follow-up. Não há tela nova nem configuração permanente.
