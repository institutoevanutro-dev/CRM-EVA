---
impacto: capacidade_nova
secao: adicionado
titulo: O agente sabe quando hoje ou amanhã é feriado nacional, e pode não atender nele
---

O agente de IA passa a receber, a cada resposta, se hoje ou amanhã é feriado nacional (na data do fuso da clínica; o calendário é o mesmo do prazo da LGPD). Num feriado ele deixa de prometer o expediente normal e não convida o paciente a vir à clínica sem confirmar com a equipe; nos dias comuns recebe a frase de que hoje e amanhã não são feriados. Feriados estaduais e municipais não entram.

Em Agentes › (agente) › Horário de funcionamento há a nova opção **Não atender em feriado nacional**, desligada de fábrica. Ligada, num feriado nacional o agente não responde: quem escrever recebe a mensagem de fora do horário (se ela estiver configurada) e a resposta da IA sai na abertura do próximo dia útil (no Carnaval, na quarta). Desligada, nada muda além do que o agente passa a saber. Sem mudança no banco. Portado do projeto original (DeskcommCRM, PRs #3894 e #4469, este com o #4169 de @webtecnica).
