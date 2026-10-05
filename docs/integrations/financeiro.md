# Integração opcional com o financeiro Eva

## O que muda
O dossiê do contato (`/app/contacts/[id]`) ganha a aba **Financeiro** para gerente/admin. O resumo consulta propostas, vendas e saldo de recebimentos do financeiro ao abrir a aba ou clicar Atualizar. Erro remoto aparece como indisponibilidade, nunca como ausência de dívida. Até 100 propostas e 100 vendas recentes; o histórico completo permanece no financeiro.

**Abrir no financeiro** abre outra aba com login próprio. Na primeira abertura, uma pessoa confirma o vínculo do contato com um paciente existente ou cadastra um novo. A partir do paciente vinculado, usa Nova proposta, propostas/vendas existentes e recebimentos, sob as permissões do financeiro. Não há criação de venda ou baixa por mudança de funil, mensagem ou clique de consulta.

## Configuração no servidor
Variáveis opcionais (o compose já usa `env_file: .env`):
- `FINANCEIRO_URL`: origem HTTPS do financeiro, sem caminho (por exemplo `https://financeiro.institutoevavix.com.br`).
- `FINANCEIRO_ORGANIZATION_ID`: UUID da organização que será vinculada. Outras organizações não consultam esse financeiro.
- `FINANCEIRO_TOKEN`: segredo exclusivo de leitura do resumo, igual ao `CRM_RESUMO_TOKEN` no financeiro. Pelo menos 32 caracteres; gerar localmente e transferir fora do chat.

O financeiro precisa também de um token de API do CRM, restrito à organização configurada, com `mcp:read` e role agent. Guardá-lo somente como `CRM_TOKEN` no servidor financeiro. Nunca usar service_role, NEXT_PUBLIC_ ou token em URL.

A exportação mínima de contato fica em `GET /api/v1/integrations/financeiro/contacts/[id]`: Bearer existente, organização derivada do token e comparada com a configurada, scope de leitura, limite de 120/min por org. Não exporta contato anonimizado. Os cinco campos são id, organization_id, name, phone, email.

A consulta do resumo pelo navegador passa por `/api/v1/contacts/[id]/financeiro`: sessão, MFA/role manager do gate existente, organização ativa e contato não anonimizado. Só o servidor chama o financeiro. `Cache-Control: no-store`; timeout de 8s; sem redirects. Limite de 120/min por org.

## Implantação e verificação
1. Aplicar a migration 0035 no financeiro e publicar suas duas novas telas/rotas com as variáveis do guia dele.
2. Publicar esta versão do CRM pelo fluxo habitual e configurar os três valores acima. Sem configuração, a aba informa a pendência.
3. Com um contato de teste, vincular ao paciente e criar uma proposta no financeiro. Atualizar a aba do CRM e conferir o número e valor.
4. Registrar pagamento parcial e estorno em dados de teste; confirmar que a consulta acompanha o saldo.
5. Confirmar que outra organização, usuário sem perfil e contato anonimizado não acessam o resumo.

Não há migração de schema no CRM. O banco financeiro continua separado. Login único e prontuário não fazem parte desta etapa. Nenhuma credencial foi criada ou implantada por este patch.

## Living System Checklist
Entrada: registro de contato autenticado. Saída: paciente e telas comerciais do financeiro; resumo de volta à aba do contato. Registro: vínculo auditado em `crm_customer_links` no financeiro; nenhuma mutação contábil no CRM. Porta: aba Financeiro em Contatos. Configuração ausente: aviso na própria aba. Falha: aviso e botão Atualizar, sem mostrar saldo anterior como atual. Continuidade: equipe humana usa o fluxo financeiro existente; IA não recebe autorização financeira por esta integração. Leitura não demanda fila ou cron; não há envios pendentes que dependam de alguém abrir outra tela.

A análise de campanhas usa uma segunda leitura agregada do Financeiro, limitada aos contatos vinculados e ao período: `POST /api/integracoes/crm/vendas-campanhas` (migration 0036). O protocolo e a ativação estão em [marketing-financeiro.md](marketing-financeiro.md).
