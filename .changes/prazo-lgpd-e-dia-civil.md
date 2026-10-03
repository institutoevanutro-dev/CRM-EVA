---
impacto: nada_mudou
secao: corrigido
titulo: O prazo de uma solicitação LGPD sai no dia certo no e-mail ao DPO, e a lista não marca "Vencido" na véspera
---

O prazo é gravado como a meia-noite UTC do dia útil contado, e quem lia esse valor
redesenhava o instante no fuso de São Paulo, o que jogava o prazo um dia para trás. O
e-mail de alerta ao DPO mostrava a data do dia anterior e dizia "1 dia(s) em atraso" no
próprio dia do prazo; a lista de solicitações marcava "Vencido" a partir das 21h da
véspera. Agora o e-mail traz o dia contado e o selo da lista lê o dia, não o instante.
Nenhuma solicitação muda de prazo. As telas de detalhe, o painel da instalação e a lista
da administração da plataforma ainda seguem a régua antiga e ficam para um próximo
conserto. Portado do DeskcommCRM PR 2101 de @Tong-bit-art.
