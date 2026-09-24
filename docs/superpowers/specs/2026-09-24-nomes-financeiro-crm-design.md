# Nomes de pacientes vinculados no CRM

## Objetivo

Preencher automaticamente o nome de contatos do CRM cujo campo `name` esteja vazio, usando o nome do paciente do Financeiro ao qual o contato foi explicitamente vinculado. A correção vale para vínculos existentes e futuros, mesmo sem propostas ou vendas. Nenhuma identidade será inferida por telefone, e-mail ou semelhança de nome.

## Contrato entre sistemas

O Financeiro incluirá `paciente_nome` na resposta autenticada de `/api/integracoes/crm/resumo` quando `crm_customer_links` contiver o par `(organization_id, contact_id)`. O valor virá de `customers.name`, sem CPF, dado clínico ou outros campos. A versão do contrato será incrementada e os dois clientes serão atualizados em conjunto. Sem vínculo, a resposta continuará nula. A autorização existente de leitura e o limite de requisições serão preservados.

## Atualização no CRM

Uma rotina agendada no CRM selecionará em lotes pequenos contatos ativos com `name` nulo ou vazio. A coluna `financeiro_name_lookup_at` ordenará a varredura pelo contato há mais tempo sem consulta, para que cadastros sem vínculo não bloqueiem os demais. Para cada contato, consultará o Financeiro pelo ID. Se a resposta trouxer um paciente vinculado e um nome válido, atualizará somente `contacts.name`, condicionando a gravação a o campo ainda estar vazio e à mesma organização. Não alterará `display_name`, nomes preenchidos manualmente, contatos anonimizados, nem outros dados. A atualização será auditável como origem `financeiro` e idempotente. Um vínculo novo será processado em uma execução subsequente; não será necessária uma credencial de escrita do Financeiro no CRM.

## Falhas e operação

A rotina seguirá o padrão de autenticação dos crons internos já existentes. Falhas de rede, resposta inválida e limite de chamadas não apagarão nem substituirão dados; o contato permanecerá elegível para a próxima execução. O processamento será limitado por lote e registrará contagens, sem registrar nomes, telefones ou tokens. A frequência e o tamanho do lote respeitarão o limite de 120 consultas por minuto da API atual.

## Validação

Testes de contrato e integração cobrirão: vínculo confirmado sem venda; mesmo telefone em dois pacientes; contato sem vínculo; nome já existente; contato anonimizado; mudança concorrente de nome; falha temporária do Financeiro; repetição da rotina. Após implantação, verificar a ficha de Cristiano e uma amostra de contatos, incluindo a permanência dos nomes já preenchidos.
