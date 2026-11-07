---
impacto: exige_acao
secao: alterado
titulo: Regra de automação e modelo de mensagem não leem o valor do CPF
---

Uma condição de regra sobre as colunas internas do CPF do contato (`contact.cpf_hash` ou `contact.cpf_encrypted`) passa a responder só a "está preenchido" e "está vazio"; com qualquer outro operador ela dá falso. Um modelo de mensagem ou automação que cite essas colunas sai com o trecho em branco. Quem tinha uma regra comparando essas colunas pelo valor precisa trocá-la por "está preenchido" ou "está vazio", senão ela deixa de disparar. Sem regra assim, não há o que fazer.

Portado do projeto original (DeskcommCRM, PR #4225 e PR #4202 de @melgarafael).
