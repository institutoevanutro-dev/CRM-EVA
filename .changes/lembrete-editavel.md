---
impacto: capacidade_nova
secao: adicionado
titulo: O texto do lembrete da agenda pode ser escrito por tipo de agendamento
---

Em Configurações › Agenda, cada tipo de agendamento com o lembrete ligado ganha
um campo para o texto da mensagem, com a lista de variáveis e uma prévia que
mostra exatamente o que o paciente vai receber.

As variáveis são `{{primeiro_nome}}`, `{{nome}}`, `{{quando}}` (que vira "hoje",
"amanhã" ou o dia da semana com a data), `{{data}}`, `{{hora}}`,
`{{dia_semana}}`, `{{unidade}}`, `{{endereco}}`, `{{profissional}}` e `{{tipo}}`.
Variável sem valor some do texto sem deixar chaves. Uma variável escrita errado,
como `{nome}` ou `{{primeiro nome}}`, é recusada ao salvar.

Em branco, o lembrete continua com a frase de sempre. Quem não mexer no campo
não percebe diferença nenhuma.

Portado e estendido do projeto original (DeskcommCRM, de Ian Couto).
