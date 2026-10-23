---
impacto: nada_mudou
secao: corrigido
titulo: O telefone gravado sozinho na ficha também aciona a regra "Quando um contato ganhar um telefone"
---

Quando o cliente informa o telefone numa conversa e a ficha do contato está sem número, o número entra sozinho no cadastro (com a opção da organização ligada). Por esse caminho, a regra "Quando um contato ganhar um telefone" não rodava: nenhum envio de WhatsApp, nada na fila de automação, sem erro e sem aviso. Agora esse caminho emite o mesmo gatilho que a edição da ficha já emitia, com o número em formato internacional no conteúdo do evento, e só depois de o número estar gravado de fato. Quem já tinha número, quem perdeu a corrida e o número que pertence a outro contato continuam sem emitir nada. A proteção contra laço entre regras segue valendo. Nada a fazer na atualização.

Portado do projeto original (DeskcommCRM, PR #3307 de @webtecnica).

**Para quem tem regras próprias:** Se alguma regra sua usa o gatilho "Quando um contato ganhar um telefone" e a opção "Telefone informado pelo cliente entra sozinho na ficha sem número" está ligada em Configurações › Distribuição de atendimento, a regra passa a disparar também quando o número entra sozinho pela conversa. Antes de atualizar, confira o que essa regra faz.
