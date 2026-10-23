---
impacto: capacidade_nova
secao: corrigido
titulo: Automação "contato ganhou telefone" passa a rodar também na ingestão do canal Zernio e no cron de telefones
---

A automação que dispara quando um contato passa a ter telefone só rodava quando o número era preenchido na tela ou pela captura automática na conversa. Outros caminhos tiravam a ficha do vazio sem avisar. Agora emitem o gatilho a ingestão de mensagens do canal Zernio (nos dois pontos em que ela grava o número) e o cron que descobre o número por trás da identidade opaca do WhatsApp, cada um uma única vez e só quando o contato estava mesmo sem número. Quem já tinha número não gera evento nenhum. O cadastro de contato feito pela ingestão do WhatsApp por QR ainda não emite o gatilho nesta versão. A junção de dois cadastros continua sem gerar o evento, de propósito: as duas fichas já existiam e o número já estava no CRM.

Portado do projeto original (DeskcommCRM, PR #3317 de @webtecnica), só a parte que não muda o banco.

**Para quem tem regras próprias:** Se alguma regra sua usa o gatilho "Quando um contato ganhar um telefone", ela passa a disparar também quando o número chega por esses caminhos, inclusive para contatos antigos sem telefone que o cron ainda vai encontrar. Antes de atualizar, confira o que essa regra faz.
