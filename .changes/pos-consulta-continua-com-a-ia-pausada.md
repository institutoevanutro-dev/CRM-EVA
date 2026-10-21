---
impacto: nada_mudou
secao: corrigido
titulo: Pós-consulta continua com a IA pausada (só as mensagens fixas)
---

A sequência de acompanhamento de consulta (gatilho "presença confirmada" ou
"falta") acabava inteira, com o aviso "uma pessoa da equipe está atendendo
esta conversa", sempre que a IA estava pausada na conversa: depois de passar
para atendimento humano, de alguém clicar em "Assumir" ou da pausa que vem
depois da resposta de uma pessoa. As mensagens de 7, 15, 30, 45 e 75 dias
nunca chegavam ao paciente.

Agora, nos fluxos com gatilho de consulta e "Permitir durante handoff":

- texto fixo, modelo de mensagem e mídia da biblioteca saem mesmo com a IA
  pausada;
- o passo "mensagem da IA" é pulado, com o motivo no histórico da inscrição, e
  a sequência segue para o próximo passo;
- continuam valendo como antes: pedido para não receber mensagens (STOP),
  contato anonimizado ou ocultado, janela de envio, ritmo anti-banimento e
  "cancelar quando o contato responder".

Não muda nada para os outros fluxos: o follow-up de lead (silêncio, etapa,
manual) continua parando quando uma pessoa assume a conversa, e os fluxos em
"Pausar durante handoff" ou "Cancelar durante handoff" continuam pausando ou
encerrando, também os de consulta.

Não há mudança de banco nem nada a fazer na atualização.
