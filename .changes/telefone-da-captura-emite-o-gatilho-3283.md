---
impacto: nada_mudou
secao: corrigido
titulo: O telefone gravado sozinho na ficha também aciona a regra "Quando um contato ganhar um telefone"
---

Quando o cliente informa o telefone na conversa e a ficha está sem número, o número entra sozinho no cadastro (com a opção da organização ligada), mas a regra "Quando um contato ganhar um telefone" não rodava por esse caminho. Agora ela roda, com o mesmo conteúdo da edição da ficha e só depois de o número estar gravado. Quem já tinha número, a corrida perdida e o número de outro contato seguem sem disparar.

Portado do projeto original (DeskcommCRM, PR #3307 de @webtecnica).

**Para quem tem regras próprias:** se uma regra usa esse gatilho e a opção "Telefone informado pelo cliente entra sozinho na ficha sem número" está ligada, ela passa a disparar também por esse caminho. Antes de atualizar, confira o que ela faz.
