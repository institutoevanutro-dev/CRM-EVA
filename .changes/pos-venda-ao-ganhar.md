---
impacto: capacidade_nova
secao: adicionado
titulo: Negócio ganho pode abrir um card de pós-venda em outro funil
---

As automações ganham o gatilho "Quando um negócio for ganho". Com a ação "Criar/mover
lead no funil" apontando para outro funil e etapa, cada venda ganha abre um card novo
nesse funil, com título, descrição, contato, valor, responsável, tags e campos
personalizados da venda. A venda continua ganha, na etapa dela, e segue contando nos
relatórios. Cada venda abre um card só: o mesmo ganho reprocessado, a venda reaberta e
ganha de novo ou a troca do funil da regra depois não abrem um segundo. Os dois cards
recebem uma linha na linha do tempo e a abertura fica na auditoria. Nada é enviado ao
cliente por causa disso. Contato bloqueado, anonimizado ou juntado a outro cadastro não
ganha card, e apontar a regra para o mesmo funil da venda é recusado, com o motivo na
aba Atividade.

Você não precisa fazer nada: sem uma regra com esse gatilho, nada muda.

Porte do projeto original (PR 2787 de @webtecnica, issue 2769 lá).
