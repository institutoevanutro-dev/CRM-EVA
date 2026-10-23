---
impacto: capacidade_nova
secao: corrigido
titulo: Automação "contato ganhou telefone" passa a rodar também na ingestão do canal Zernio e no cron de telefones
---

O gatilho "Quando um contato ganhar um telefone" passa a sair também quando o número chega pela ingestão do canal Zernio e pelo cron que descobre o número por trás da identidade opaca do WhatsApp, uma vez e só se a ficha estava sem número. O cadastro feito pela ingestão do WhatsApp por QR ainda não emite nesta versão, e a junção de dois cadastros continua sem emitir, de propósito.

Portado do projeto original (DeskcommCRM, PR #3317 de @webtecnica), só a parte que não muda o banco.

**Para quem tem regras próprias:** uma regra com esse gatilho passa a disparar nesses caminhos, inclusive para contatos antigos sem telefone que o cron ainda vai encontrar. Antes de atualizar, confira o que ela faz.
