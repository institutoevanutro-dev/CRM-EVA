---
impacto: nada_mudou
secao: corrigido
titulo: Campos diferentes gravados ao mesmo tempo no mesmo negócio não se apagam mais
---

Quando duas gravações dos campos personalizados de um mesmo negócio chegavam
juntas (quem atende salvando a ficha enquanto o assistente anotava outro campo
pelo MCP), a segunda gravava por cima da primeira e um dos campos sumia, sem
erro. Agora a soma dos campos acontece dentro do banco, numa única gravação, e
os campos de cada uma ficam. A ficha do dossiê ainda reenvia os campos que
mostrava ao abrir; esse ajuste do formulário segue à parte. Nada a configurar.

Portado do projeto original (DeskcommCRM PR 2009, de @paulolimajr77).
