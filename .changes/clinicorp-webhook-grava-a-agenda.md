---
impacto: capacidade_nova
secao: adicionado
titulo: A agenda da Clinicorp chega pelo webhook, sem o módulo API Externa
---
Com o endereço do webhook cadastrado na Clinicorp (Gestão de Webhook, eventos de
agendamento), cada agendamento criado, alterado ou desmarcado lá passa a ocupar ou liberar o
horário na Agenda do CRM e na IA, na hora. Do evento entram só o início, o fim, o profissional,
a clínica, a situação e o id; nada do paciente. O nome do profissional não vem pelo webhook:
em **Quem é quem** ele aparece pelo número e pelo próximo horário dele, para você achá-lo na
Clinicorp e ligá-lo a uma pessoa da Agenda. Quando o webhook fala de um horário que veio pela
importação do relatório, esse horário sai da importação e não conta duas vezes; um desmarcado
volta a ficar livre. Fica uma exceção: se o primeiro evento de um horário importado for uma
remarcação, o horário antigo segue ocupado até a próxima importação.
