# Cadastro administrativo: CRM como origem

O cadastro administrativo nasce na agenda/ficha do CRM e é importado pelo servidor do Prontuário. Nome, nascimento, contato, CPF e endereço são mantidos no CRM; os registros clínicos permanecem no Prontuário. A leitura protegida e a ordem de publicação estão descritas abaixo.

## Compatibilidade com a integração anterior

POST/PATCH de `/api/v1/prontuario/contacts` aceitam, além de nome/nascimento/telefone/e-mail, os campos opcionais `cpf` e `address`. O CPF aceita pontuação e valida dígitos verificadores. `address` aceita somente `cep`, `logradouro`, `numero`, `complemento`, `bairro`, `cidade`, `uf`. Dados clínicos e organization_id do cliente são recusados. Organização e token vêm da autenticação, com os escopos exclusivos existentes.

A migração 0328 adiciona RPCs v2, preservando as assinaturas antigas. POST continua exigindo confirmação de ausência de correspondente; vínculo existente continua exigindo confirmação humana. Nenhum matching por telefone ou CPF e nenhuma fusão automática são feitos.

CPF usa `encrypt_cpf`/`cpf_indice`, já existentes, como par inseparável. Falha na cifra reverte a transação. CPF diferente de um já cadastrado gera 409 e exige conferência. Listagem e GET sem inclusão explícita retornam apenas `cpf_available`, nunca o número, cifra ou hash. Audit armazena somente identificadores/revisão; retorno de mutação não contém dados pessoais.

Partes vazias de endereço preservam os valores anteriores em `custom_fields.endereco_estruturado`; `custom_fields.endereco` é a projeção exibida pela ficha atual. Outras chaves de custom_fields são mantidas. Endereço livre legado divergente, ou texto alterado na tela CRM em relação à última projeção estruturada, retorna 409: a integração não tenta adivinhar componentes nem apaga complementos. Para resolver, confira os dados completos e concilie o texto na ficha CRM com o endereço do prontuário antes de repetir. Campos básicos vazios no PATCH v2 também preservam os dados do CRM. Exclusão precisa ocorrer no cadastro de origem com fluxo próprio, não por campo vazio dessa integração.

Idempotência inclui HMAC do CPF e o endereço recebido; o CPF puro não entra no hash simples do payload. Conflitos de revisão continuam impedindo sobrescrita silenciosa. A instalação existente fornece a chave do CRM; não há variável nova no CRM.

## Leitura protegida pelo servidor do Prontuário

**CONFIRMADO no código:** `GET /api/v1/prontuario/contacts/{id}?include=demographics` exige simultaneamente `prontuario:contacts:read` e `prontuario:contacts:demographics:read` no Bearer. O novo escopo pode ser escolhido em Configurações › Tokens de API; escopos genéricos de MCP/agenda não o substituem. `include` desconhecido ou repetido retorna 422. O GET básico acrescenta apenas `organization_id` ao contrato público anterior, inclusive com `appointment_id`, para conferir vínculos existentes sem exigir o escopo sensível. POST/PATCH antigos continuam disponíveis para compatibilidade durante a publicação coordenada; o novo consumidor não deve usá-los para editar o cadastro mestre.

A resposta `{data: {...}}` mantém os campos públicos e acrescenta:

| Campo | Contrato |
| --- | --- |
| `organization_id` | Organização autenticada do token, também presente no GET básico |
| `name` | Com opt-in, somente `contacts.name` sem espaços externos, ou vazio se ausente/identificador técnico legado; nunca o apelido `display_name` como nome cadastral. O GET básico mantém seu rótulo de exibição |
| `cpf` | Onze dígitos validados ou `null` quando não cadastrado |
| `address` | Texto atual de `custom_fields.endereco`, sem inferir componentes |
| `address_structured` | `null` ou objeto com `cep`, `logradouro`, `numero`, `complemento`, `bairro`, `cidade`, `uf`; todas strings, partes ausentes vazias |

A estrutura só é exportada se passar pelo schema e sua projeção (logradouro, número, complemento, bairro, cidade, UF, CEP, separados por vírgula e espaço) coincidir com o texto atual. Caso a ficha CRM tenha alterado só o texto, o consumidor recebe esse texto e `address_structured: null`, sem restaurar a estrutura antiga.

O contato precisa estar ativo e pertencer à organização do token antes de chamar `decrypt_cpf` com service role. Cada tentativa de decifra emite `contact.cpf_viewed` com `actorApiTokenId`, identificadores e sucesso; nunca CPF, cifra, telefone, e-mail ou endereço. CPF existente mas indecifrável/inválido gera 503 sem dados. Depois da decifra a rota relê o contato ativo e compara `updated_at` e a cifra; qualquer alteração gera 409 e o cliente deve repetir a leitura, sem aplicar o resultado parcial. Sucesso e erros usam `Cache-Control: no-store`.

`appointment_id` continua opcional e exige também o Bearer exclusivo da agenda em `X-Agenda-Authorization`, da mesma organização. A inclusão demográfica não relaxa essa autorização. Não há exportação de CPF na listagem, no GET comum nem em mensagens de erro.

Nos detalhes do compromisso, `appointment.description` devolve a observação
preenchida no formulário da agenda, enquanto `appointment.notes` conserva a
anotação interna. Ambos podem ser nulos e só são enviados quando o compromisso
pertence ao contato e à organização autorizados. O consumidor exibe os campos
separadamente; a listagem MCP não recebe esses textos por esta mudança.

O CPF claro serve somente à comunicação entre servidores por HTTPS: o Prontuário precisa cifrá-lo imediatamente com `PATIENT_DATA_KEY`, sem enviá-lo ao navegador ou registrá-lo em logs. Esse comportamento do consumidor depende da entrega correspondente no repositório Prontuario-EVA.

## Publicação coordenada

1. Publicar este CRM após os checks, sem migration ou variável nova no CRM.
2. Emitir no CRM um token com os dois escopos de leitura e os escopos de vínculo ainda necessários; cadastrar o valor exclusivamente no segredo existente `CRM_PATIENT_TOKEN` do Sites, sem enviar em chat ou logs. Manter o token separado da agenda sem alteração.
3. Publicar o consumidor do Prontuário com o fluxo CRM → Prontuário após aplicar sua migration `0017_crm_patient_source`; manter a migration `0016_patient_demographics` e o segredo `PATIENT_DATA_KEY` já configurados, sem criar variável nova.
4. Validar os dois lados com cadastro autorizado após a publicação; testes locais usam somente fixtures sintéticas.

## Continuidade e verificação

Entrada: cadastro da ficha/agenda do CRM. Saída: servidor do Prontuário, pelo contato identificado na mesma organização. Audit: `prontuario.contact_read` e `contact.cpf_viewed`, consultáveis na auditoria existente. Configuração: tela `/app/settings/api-tokens`; o consumidor mostra a falta de escopo ou credencial. A rota é leitura sob demanda, portanto não cria fila/cron nem requer mecanismo de retomada próprio; conflito exige nova consulta e demais falhas ficam visíveis no consumidor. Dados clínicos permanecem no Prontuário. Não há agente de mensagens nem nova navegação. O mapa `docs/architecture/prontuario-cadastro.architecture.json` registra as duas pontas e a auditoria.

As rotas legadas de escrita continuam emitindo `prontuario.contact_created/updated`; o fluxo novo não depende de alterações nelas.

`tests/invariants/prontuario-demographics.test.ts` mede as RPCs no PostgreSQL com a cifra real, preservação, repetição e isolamento. `app/api/v1/prontuario/contacts/write.test.ts` mede validação/auth na borda. Referência: https://supabase.com/docs/guides/database/functions (search_path e grants explícitos).

Os testes de `app/api/v1/prontuario/contacts/[id]/demographics.test.ts` cobrem escopos, filtros de tenant/atividade, CPF ausente, erro de decifra, auditoria sem valores e snapshots concorrentes; os testes de agenda e escrita legada continuam rodando. `ApiTokensClient.test.tsx` confirma a seleção explícita da permissão sensível.
