---
impacto: capacidade_nova
secao: corrigido
titulo: Aviso de mensagem só para quem vê a conversa, negócio do Instagram com a origem certa e agente que declara em quais números atende
---

Portado do projeto original (DeskcommCRM):

- o aviso de mensagem nova no celular e na bandeja do computador vai só para
  quem pode ver a conversa, pela mesma regra do Inbox (Configurações ›
  Atendimento). Quem atende a conversa continua sendo avisado; o profissional
  que só vê as conversas dele deixa de receber o nome e o começo da mensagem de
  outros pacientes (PR #2590 de @melgarafael);
- o negócio que nasce de uma conversa do Instagram passa a ter origem
  "instagram", e não "whatsapp". Os negócios que já nasceram assim são
  corrigidos na atualização; origem digitada, importada ou de anúncio não muda
  (PR #2199 de @paulolimajr77);
- cada agente de IA pode declarar em quais números atende. Sem declaração, ele
  atende em todos, como hoje: nada muda até alguém configurar. Com declaração,
  o roteador e o número deixam de oferecê-lo nos outros números, e um número de
  onde a declaração tirou todos os agentes fica sem resposta da IA. A mudança
  fica registrada na auditoria (PR #2854 de @webtecnica, adaptado).

Você não precisa fazer nada.
