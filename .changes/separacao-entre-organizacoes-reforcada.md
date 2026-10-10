---
impacto: nada_mudou
secao: corrigido
titulo: Separação entre organizações reforçada em nove consultas internas
---

Nove consultas internas do sistema buscavam ou alteravam um registro só pelo identificador dele, confiando que a leitura anterior já tinha conferido a organização. Em todas elas a conferência anterior existia, então nenhuma permitia hoje que uma organização alcançasse dado de outra. Agora cada uma também exige a organização de quem fez o pedido, e um teste automático reprova qualquer consulta nova que volte a esse formato.

Você não precisa fazer nada, e nenhuma tela mudou.
