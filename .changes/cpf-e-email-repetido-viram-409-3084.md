---
impacto: nada_mudou
secao: corrigido
titulo: CPF ou e-mail já usado por outro contato responde 409, não "erro interno"
---

Ao criar um contato com um CPF que já pertencia a outro contato da mesma organização, a API devolvia 500 com `duplicate key value violates unique constraint "uniq_contacts_org_cpf"` e a tela mostrava "Erro interno" para um simples duplicado. O mesmo acontecia ao editar um contato com o e-mail (ou o telefone) de outro. Agora o CPF, o e-mail e o telefone respondem igual, na criação e na edição: 409 `contact_exists` com o `contact_id` de quem já tem o dado, e a tela mostra "Já existe um contato com este CPF." (ou e-mail, ou telefone). Nada a fazer na atualização.

Portado do projeto original (DeskcommCRM, PR #3197 de @webtecnica).
