---
impacto: nada_mudou
secao: corrigido
titulo: O agendamento de quem veio do anúncio da Meta para o WhatsApp chega à Meta
---
Quando o paciente veio de um anúncio clique-para-WhatsApp, o aviso de
agendamento e o de sinal pago saíam com os nomes `Schedule` e
`CompleteRegistration`, e a Meta recusa esses nomes em conversa
(código 100, subcódigo 2804066). Nenhum aviso desse caminho chegava.
Agora o agendamento vai como `QualifiedLead` e o sinal pago como
`InitiateCheckout`, os dois sem valor, como antes. Quem não tem o clique do
anúncio segue com os nomes de antes.
