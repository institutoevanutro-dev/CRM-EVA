---
impacto: capacidade_nova
secao: adicionado
titulo: Resposta rápida com imagem, sincronização do Google que termina em agendas grandes e etiquetas de regras simultâneas que não se apagam
---

Portado do projeto original (DeskcommCRM), com três mudanças de banco
(migrations 0383, 0385 e 0386):

- a resposta rápida aceita até 5 imagens (JPG ou PNG, até 5 MB cada),
  carregadas pela própria equipe em Respostas rápidas. Ao escolher a resposta
  no atendimento, as imagens aparecem em prévia com o texto como legenda, e
  saem pelo mesmo envio de mídia de sempre (janela, ritmo e opt-out valem).
  As imagens ficam no armazenamento privado do sistema; uma resposta só pode
  apontar para imagens dela mesma. Respostas só de texto não mudam (PR #2704
  de @webtecnica; a trava de caminho no banco é acréscimo nosso);
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
