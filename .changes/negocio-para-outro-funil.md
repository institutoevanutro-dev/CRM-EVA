---
impacto: capacidade_nova
secao: adicionado
titulo: Levar um negócio aberto para outro funil
---

Negócio que começou no funil errado, ou que muda de natureza no meio do caminho,
não tinha por onde sair: quem tentava pela API recebia "clone o negócio",
apontando para um clone que não existia.

Agora a troca existe, por enquanto pela API (`POST /api/v1/leads/[id]/clone`); o
botão no quadro vem depois. O negócio é criado no funil de destino com os mesmos
dados e a origem é encerrada como perdida. Os dois lados registram a troca na
linha do tempo, em vez de aparecer como perda comum.

Negócio já encerrado não é clonado, e trocar de etapa dentro do mesmo funil
continua sendo o arrastar de sempre.
