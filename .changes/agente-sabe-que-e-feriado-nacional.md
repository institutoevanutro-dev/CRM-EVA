---
impacto: capacidade_nova
secao: adicionado
titulo: Opção por agente para não atender em feriado nacional
---

Em Agentes › (agente) › Horário de funcionamento há a nova opção **Não atender em feriado nacional**, desligada de fábrica. Desligada, nada muda: o agente atende no horário de sempre e o prompt dele é exatamente o de antes.

Ligada, três coisas mudam juntas. Num feriado nacional o agente não responde: quem escrever recebe a mensagem de fora do horário (se ela estiver configurada) e a resposta da IA sai na abertura do próximo dia útil (no Carnaval, na quarta). O agente também passa a receber, a cada resposta, se hoje ou amanhã é feriado nacional, na data do fuso da clínica, e deixa de prometer atendimento nesses dias ou marcar compromisso neles sem confirmar com a equipe. O calendário é o mesmo do prazo da LGPD e conta segunda e terça de Carnaval e Corpus Christi como feriado; por isso a opção vem desligada, para não travar a marcação de quem abre nesses dias. Feriados estaduais e municipais não entram. Sem mudança no banco. Portado do projeto original (DeskcommCRM, PRs #3894 e #4469, este com o #4169 de @webtecnica).
