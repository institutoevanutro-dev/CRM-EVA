---
impacto: nada_mudou
secao: corrigido
titulo: A gravação de sessão do diagnóstico de erros passa pelo mesmo filtro de URL do resto da telemetria
---

Para quem ligou o Sentry com o próprio DSN: a gravação de sessão (Replay) que acompanha os relatórios de erro passa a aplicar às URLs o mesmo filtro que o resto da telemetria já aplicava. Valores de parâmetro e segmentos de credencial no caminho saem redigidos, e o cabeçalho `Referer` e a origem e o destino das trocas de página também. Nas páginas que trazem credencial na própria URL, como o link de convite, a gravação de sessão não acontece. O relatório de erro dessas páginas continua sendo enviado. Com a telemetria desligada, que é o padrão, nada muda. Não é preciso fazer nada na instalação.

Portado do projeto original (DeskcommCRM PR 2186 de @melgarafael).
