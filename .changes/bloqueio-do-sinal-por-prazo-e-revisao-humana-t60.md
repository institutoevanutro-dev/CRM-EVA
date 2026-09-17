---
impacto: capacidade_nova
secao: adicionado
titulo: O lembrete de cobrança de sinal respeita o prazo real da reserva, e quem vencer sem comprovante vira revisão humana
---
O executor de follow-up agora sabe, quando o fluxo está amarrado a uma reserva de agenda,
que tipos de compromisso exigem sinal/depósito e até quando o lembrete pode sair: o prazo
é contado da criação real da reserva (nunca do disparo do fluxo), encurtado quando a
consulta começa antes disso, e o lembrete nunca sai depois do prazo nem depois do início
da consulta. Fora do horário comercial configurado, se a próxima abertura já cair depois
do prazo, o lembrete é suprimido — nunca adiado para depois de vencido. Cada reserva
aceita só uma tentativa deste fluxo.

Quando o prazo vence sem que o comprovante tenha sido tratado, um novo aviso na Central
("revisão de sinal") avisa a equipe — sem nunca liberar o horário, cancelar a consulta ou
marcar falta sozinho; isso continua exigindo uma decisão humana.

Nasce desligado: exige que o tipo de compromisso seja marcado como "exige sinal" e que o
fluxo publicado amarre a inscrição à reserva — nenhuma instalação existente muda de
comportamento sozinha.
