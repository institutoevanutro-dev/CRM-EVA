---
impacto: nada_mudou
secao: corrigido
titulo: A IA só mexe na ficha do paciente com quem está conversando
---

Quando a IA anota algo num negócio durante uma conversa (valor, etapa, campos), ela informa qual negócio é, e às vezes informava errado. Se o código fosse de um negócio de **outro** paciente, no mesmo funil, a anotação era aceita e ia para a ficha errada, sem erro nenhum para alguém perceber.

Agora toda anotação da IA numa conversa é conferida contra os negócios do paciente daquela conversa. Se o negócio é dele, segue. Se não é e ele tem um único negócio aberto, a anotação vai para esse. Com nenhum ou com vários abertos, a IA recebe a recusa com o motivo, que fica registrada na auditoria, e segue a conversa em vez de escolher por palpite. Anotações feitas pela equipe, pela API ou por automações não mudam.

Porte do projeto original (DeskcommCRM), trabalho de Paulo Lima Jr, jmpo e Rafael Melgaço.
