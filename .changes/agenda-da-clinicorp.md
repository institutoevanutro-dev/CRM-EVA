---
impacto: capacidade_nova
secao: adicionado
titulo: A Agenda desconta o que já está ocupado na Clinicorp, e o dia aberto diz em que unidade
---
Quem marca as consultas na Clinicorp ganha, em Configurações › Tipos de agendamento,
a seção **Agenda da Clinicorp**, onde se cola o "Usuário API" e o "Token API" da Clinicorp.
O CRM copia dali só a ocupação (início, fim e profissional, sem nada do paciente) a cada
10 minutos ou no botão **Copiar agora**, e cada profissional da Clinicorp é ligado a uma
pessoa da Agenda. A partir daí a tela da Agenda mostra esses horários como
**Ocupado (Clinicorp)** e a IA deixa de oferecê-los. O token é guardado cifrado e nunca
volta à tela. Em **Dias fora da rotina**, abrir um dia agora pergunta **Onde** (a unidade)
e aceita várias datas de uma vez: lançar os dias do mês em outra unidade já fecha a
unidade de sempre naqueles dias. Quem não usa a Clinicorp não precisa fazer nada, e a
agenda ligada ao Google responde como antes (migration 0433).
