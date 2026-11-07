---
impacto: nada_mudou
secao: corrigido
titulo: O roteador de agentes lê o áudio que veio antes da última mensagem
---

Quando o cliente mandava um áudio e, logo depois, um emoji ou um "ok", o roteador escolhia o agente olhando só a última mensagem. O texto do áudio ficava de fora da escolha, e a conversa ia para o agente padrão em vez do assunto certo, mesmo com o agente respondendo depois ao conteúdo do áudio. Agora o roteador lê todas as mensagens do cliente que ainda não tiveram resposta, com a transcrição dos áudios já prontos, da mais antiga para a mais nova. A espera pela transcrição continua a mesma, com o mesmo teto: se o áudio não for transcrito a tempo, o roteador segue com o que tiver.
