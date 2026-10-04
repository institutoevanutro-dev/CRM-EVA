# Cadastro administrativo do prontuário

POST/PATCH de `/api/v1/prontuario/contacts` aceitam, além de nome/nascimento/telefone/e-mail, os campos opcionais `cpf` e `address`. O CPF aceita pontuação e valida dígitos verificadores. `address` aceita somente `cep`, `logradouro`, `numero`, `complemento`, `bairro`, `cidade`, `uf`. Dados clínicos e organization_id do cliente são recusados. Organização e token vêm da autenticação, com os escopos exclusivos existentes.

A migração 0313 adiciona RPCs v2, preservando as assinaturas antigas. POST continua exigindo confirmação de ausência de correspondente; vínculo existente continua exigindo confirmação humana. Nenhum matching por telefone ou CPF e nenhuma fusão automática são feitos.

CPF usa `encrypt_cpf`/`cpf_indice`, já existentes, como par inseparável. Falha na cifra reverte a transação. CPF diferente de um já cadastrado gera 409 e exige conferência. GET retorna apenas `cpf_available`, nunca o número, cifra ou hash. Audit armazena somente identificadores/revisão; retorno de mutação não contém dados pessoais.

Partes vazias de endereço preservam os valores anteriores em `custom_fields.endereco_estruturado`; `custom_fields.endereco` é a projeção exibida pela ficha atual. Outras chaves de custom_fields são mantidas. Endereço livre legado divergente, ou texto alterado na tela CRM em relação à última projeção estruturada, retorna 409: a integração não tenta adivinhar componentes nem apaga complementos. Para resolver, confira os dados completos e concilie o texto na ficha CRM com o endereço do prontuário antes de repetir. Campos básicos vazios no PATCH v2 também preservam os dados do CRM. Exclusão precisa ocorrer no cadastro de origem com fluxo próprio, não por campo vazio dessa integração.

Idempotência inclui HMAC do CPF e o endereço recebido; o CPF puro não entra no hash simples do payload. Conflitos de revisão continuam impedindo sobrescrita silenciosa. A instalação existente fornece a chave do CRM; não há variável nova no CRM.

## Publicação coordenada

1. Claude publica a versão do CRM com a migração/rotas após os checks do PR.
2. Depois, o prontuário aplica sua migração 0014 e configura `PATIENT_DATA_KEY` como segredo para a cifra local.
3. Publicar o prontuário e validar com um colaborador autorizado. Sem teste de escrita em pacientes reais nesta entrega.

## Continuidade e verificação

Entrada: edição confirmada na ficha do prontuário. Saída: contato previamente vinculado do mesmo tenant. Audit: `prontuario.contact_created/updated`. Superfície: ficha CRM existente e status de sincronização no prontuário. Falha mantém a pendência no prontuário; revisão humana/reenvio fecham o ciclo. Nenhuma nova navegação nem agente de mensagens é criado.

`tests/invariants/prontuario-demographics.test.ts` mede as RPCs no PostgreSQL com a cifra real, preservação, repetição e isolamento. `app/api/v1/prontuario/contacts/write.test.ts` mede validação/auth na borda. Referência: https://supabase.com/docs/guides/database/functions (search_path e grants explícitos).
