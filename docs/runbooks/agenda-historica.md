# Importar histórico de agenda

Use `scripts/importar-agenda-historica.ts` com o ambiente administrativo da instalação. A aplicação exige a migration 0320; a prévia também funciona antes dela. O script não lê arquivos `.env` automaticamente. Nunca publique o arquivo de pacientes nem o relatório em Git.

Arquivo JSON: `organization_id`, `owner_user_id`, `actor_user_id` (gestor ativo da organização) e `rows`. Cada linha contém `key` (SHA256 da identidade na origem), `contact_id` já conferido, `title` (procedimento), `starts_at`, `ends_at` (ISO com fuso) e `status` (`pending`, `confirmed`, `completed`, `no_show`, `cancelled`). Fuso de apresentação: America/Sao_Paulo. Só horários com fim anterior ao relógio do banco. Cancelamentos sem data exata usam o instante de importação como carimbo técnico, com motivo explícito.

```sh
pnpm tsx scripts/importar-agenda-historica.ts /caminho/privado/agenda.json --destino HOST
pnpm tsx scripts/importar-agenda-historica.ts /caminho/privado/agenda.json --destino HOST --aplicar SHA256_DA_PREVIA
```

Prévia não grava. Aplicação relê o destino sob trava: conflito aborta o arquivo inteiro. Chave já importada só é aceita se o conteúdo coincidir. Outra consulta no mesmo intervalo exige conferência, inclusive quando o nome parece igual. Nada é apagado ou sobrescrito. Corrija o arquivo e repita a prévia. Saída contém números de linhas e IDs, sem nomes ou telefones.

O histórico aparece na Agenda existente e na leitura MCP usada pelo prontuário. É somente leitura para horários e status; correção exige reconciliação administrativa. Não possui tipo de atendimento vivo, conversa, convidado, Meet ou vínculo Google. Não gera eventos de criação/remarcação/falta, pedidos de confirmação nem expiração de pendentes. A classificação de cliente recalcula sem disparar `contact.tag_added`. Auditoria registra cada inclusão na mesma transação.

Conferência final: compare quantidades, datas, duração, responsável e contato na Agenda e no prontuário; execute novamente a prévia (somente `existente`); confira `agenda.historico_importado` na Auditoria. Se a origem não trouxer horário atual ou identidade suficiente, mantenha a linha pendente. Não transforme ausência de confirmação em falta ou atendimento realizado.
