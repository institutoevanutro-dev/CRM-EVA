---
impacto: capacidade_nova
secao: adicionado
titulo: O WhatsApp que fica conectado sem receber é reiniciado de novo até voltar, e o aviso chega ao celular
---

Quando a conexão do WhatsApp cai, volta sozinha e continua aparecendo como conectada mas sem receber mensagens, o CRM já reiniciava a conexão uma vez e abria um aviso na Central. Agora ele confere se o reinício adiantou: se em 45 minutos nenhuma mensagem chegar, reinicia de novo, até 2 vezes a cada 6 horas por conexão (ajustável em `CHANNEL_DEAF_RESTART_MAX` e `CHANNEL_DEAF_RESTART_WINDOW_HOURS`; `0` desliga o reinício e o CRM só avisa). O reinício passou a usar o reinício nativo do servidor do WhatsApp, a mesma chamada que resolve à mão, sem deslogar e sem QR. Quando as mensagens voltam, um aviso diz o intervalo em que algo pode não ter entrado no CRM, para conferir no celular; quando o CRM desiste, um aviso crítico pede para reconectar. Os três avisos vão também para o celular de quem ativou as notificações (a instalação precisa ter as chaves VAPID configuradas). O CRM não reinicia enquanto alguém está conectando o número nem durante uma atualização disparada pela tela, e cada tentativa fica na auditoria. Nada precisa ser feito ao atualizar.
