---
impacto: nada_mudou
secao: corrigido
titulo: A contagem das abas do Inbox volta a mostrar número com um marcador filtrado
---

O Inbox tem um filtro por marcador, e ele enxerga tanto o marcador do contato
quanto o da conversa. Com um marcador filtrado, as abas de cima perdiam o
número: "Todas", "Fechadas" e "Arquivadas" ficavam sem contagem nenhuma, e o
atendente perdia a referência de quantas conversas havia em cada visão.

A lista de conversas sempre soube procurar o marcador nas duas caixas onde se
marca. A contagem das abas pedia outra coisa — igualdade numa coluna de marcador
que só existe dentro da conversa —, e o banco recusava a consulta inteira. Não
era um número errado: era nenhum número, em todas as abas, sempre que o filtro
por marcador estava ligado.

Agora a contagem pergunta do mesmo jeito que a lista: o marcador vale se estiver
no contato ou na conversa, e as abas voltam a estampar a contagem certa sob
qualquer marcador. Sem marcador filtrado, a contagem é a que já era.

Nada muda para quem opera: nenhuma variável nova, nenhum passo na atualização.
