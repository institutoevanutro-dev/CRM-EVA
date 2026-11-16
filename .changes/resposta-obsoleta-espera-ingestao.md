---
impacto: nada_mudou
secao: corrigido
titulo: O agente não responde duas vezes quando o cliente manda a segunda mensagem no mesmo segundo do envio
---

Quando o cliente mandava uma segunda mensagem bem no instante em que o agente começava a responder à primeira, a resposta desatualizada saía e a segunda mensagem ganhava outra resposta, às vezes com um novo cumprimento. Agora, antes de enviar, o agente espera alguns segundos a mensagem nova terminar de ser registrada e responde às duas de uma vez.

A espera tem teto (`RESPOSTA_OBSOLETA_ESPERA_INGESTAO_MS`, padrão 5000 ms; 0 desliga) e não exige nada à mão na atualização.
