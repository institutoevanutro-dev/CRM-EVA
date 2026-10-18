---
impacto: capacidade_nova
secao: adicionado
titulo: Resposta rápida com imagens da biblioteca, sincronização do Google que termina em agendas grandes e etiquetas de regras simultâneas que não se apagam
---

Portado do projeto original (DeskcommCRM), com três mudanças de banco
(migrations 0383, 0385 e 0386):

- a resposta rápida pode levar até 5 imagens da Biblioteca de mídia (a mesma
  dos agentes e dos acompanhamentos). Em Respostas rápidas, quem é gerente
  escolhe as imagens da biblioteca ou envia uma nova, que entra na biblioteca.
  No atendimento, ao escolher a resposta, as imagens aparecem em prévia com o
  texto como legenda e saem pelo envio de mídia da biblioteca, que confere o
  termo de uso de imagem: imagem sem termo válido é pulada com aviso e as
  outras seguem. Uma mídia em uso por resposta rápida não pode ser apagada da
  biblioteca até sair da resposta. Respostas só de texto não mudam (PR #2704
  de @webtecnica, adaptado para a biblioteca);
- a sincronização com o Google Agenda termina em agendas grandes: cada página
  é gravada de uma vez, o cache guarda só os próximos 90 dias e a leitura da
  lista de agendas que falha espera 15 minutos antes de tentar de novo. A
  sincronização passa a rodar a cada minuto enquanto houver página pendente.
  Na primeira atualização a agenda do Google é relida do zero uma vez: até
  terminar, aparece o aviso "Ocupação do Google ainda não verificada neste
  período". A regra que barra horário em conflito com o Google não muda (PR
  #2978 de @melgarafael, que incorpora o #2866 de @omayklourenco);
- duas regras automáticas que põem etiqueta no mesmo negócio ao mesmo tempo
  não apagam mais a etiqueta uma da outra (PR #2967 de @webtecnica).
