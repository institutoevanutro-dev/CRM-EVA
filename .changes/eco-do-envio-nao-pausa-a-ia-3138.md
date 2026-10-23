---
impacto: nada_mudou
secao: corrigido
titulo: A mensagem que o CRM acabou de enviar não pausa mais a IA como se alguém tivesse respondido pelo celular
---
O WhatsApp devolve ao CRM uma cópia de cada mensagem que sai pelo número. Em dois casos essa cópia deixava de ser reconhecida como nossa e era lida como "uma pessoa respondeu pelo celular": a conversa ficava com "Automático pausado" pelo prazo configurado (5 minutos, por padrão) e ainda tentava nascer no funil como conversa começada pelo celular. O primeiro caso era a cópia que chega de novo depois que o envio já foi dado como enviado, mas sem o código da mensagem gravado. O segundo era a confirmação do envio chegar exatamente enquanto a cópia estava sendo processada. Agora as duas situações são reconhecidas como mensagem do próprio CRM. Mensagem digitada de verdade no aparelho continua pausando a IA, como antes. Nada a fazer na atualização.

Portado do projeto original (DeskcommCRM, PR #3162 e PR #3208 de @webtecnica).
