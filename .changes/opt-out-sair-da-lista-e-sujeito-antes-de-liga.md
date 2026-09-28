---
impacto: nada_mudou
secao: corrigido
titulo: "Sair da lista de espera" e "meu filho não me liga mais" deixam de virar bloqueio
---

Duas frases de rotina gravavam `is_blocked` sem que a pessoa tivesse pedido
descadastro. A primeira é o falso positivo que o freio do #1805 consertou em
"me tira/remove da lista" — só que o irmão dela, "sair da lista", ficou de fora:
"quero sair da lista de espera" é paciente querendo ser chamado, e "lista de
presentes" é compra. As duas regras leem hoje a mesma lista de listas de envio,
de modo que "sair da lista de transmissão" continua bloqueando.

A segunda é `liga`, que é imperativo informal ("não me liga mais" = ordem) e
também 3ª pessoa do indicativo ("meu filho não me liga mais" = relato). O que
separa as duas é o sujeito, e ele vem antes de "não me": havendo sujeito
explícito de 3ª pessoa — pronome (`ele`), ou nome com determinante (`meu filho`,
`a doutora`, `meu antigo chefe`) — a frase deixa de ser tratada como pedido.
Sem sujeito, a ordem continua bloqueando como antes, e "a partir de amanhã não
me mande mais" também, porque ali vem uma preposição, não um sujeito. O
sujeito precisa abrir a mensagem ou a frase: numa mensagem sem pontuação como
"vou bloquear o numero não me liga mais", o pedido continua bloqueando.

Contribuição de @webtecnica (#1825)
