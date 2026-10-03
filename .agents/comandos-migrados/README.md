# Comandos de sessão migrados

Dois comandos de sessão que existiam **só no disco de uma máquina**, em
nenhum commit. Estão aqui para não se perderem.

**Não são skills embutidas, e é de propósito que não estão em
`.agents/skills/`.** Aquele diretório é o que chega a quem instala, monta um
cliente ou analisa métricas — e ele tem orçamento: o Codex lista skills em no
máximo 2% da janela e, quando estoura, apaga as descrições de todas
(`tests/unit/skills-embutidas.test.ts`, defeito 4). Gastar esse orçamento com
comando de mantenedor cobra o preço de um leigo.

| arquivo | o quê | onde mora a doutrina |
|---|---|---|
| `deskcomm-gov-loop.md` | roda UMA sessão do gov-loop | `loop/LOOP.md`, neste repositório |
| `triagem-de-pr.md` | tria um PR de contribuidor | `triagem/TRIAGEM.md`, que **não existe aqui** |

A segunda linha é a que importa para quem for usar: `triagem/TRIAGEM.md` vive
no repositório de ONDE este é fork (`melgarafael/DeskcommCRM`, 181 KB em
03/10/2026), não aqui. O comando manda ler `origin/main:triagem/TRIAGEM.md` —
e neste clone `origin` é o fork, então ele falha na primeira linha. Quem for
triar PR do upstream lê a doutrina lá, e o arquivo aqui é a cópia do comando,
preservada como estava.
