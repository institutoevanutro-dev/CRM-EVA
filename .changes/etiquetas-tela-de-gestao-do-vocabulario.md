---
impacto: capacidade_nova
secao: adicionado
titulo: Etiquetas ganham tela própria para renomear, juntar e excluir
---

Configurações agora tem a tela de Etiquetas: a lista das etiquetas em uso, com quantos
contatos, negócios, conversas e regras de agente cada uma alcança. De lá dá para renomear,
juntar duas numa só e excluir. No renomear e no juntar, a regra de marcação dos agentes que
escrevia a etiqueta é corrigida na mesma operação, numa transação só; no excluir, a tela avisa
quantas regras continuam escrevendo a etiqueta e não mexe nelas.

Era esse o defeito de origem: renomear a etiqueta sem corrigir a regra deixava o agente
escrevendo a grafia velha na próxima conversa. Quem instala não precisa fazer nada: o
`update.sh` aplica a migration e a tela aparece em Configurações para gerentes e
administradores.
