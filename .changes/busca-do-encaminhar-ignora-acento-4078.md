---
impacto: nada_mudou
secao: corrigido
titulo: A busca da janela Encaminhar acha o contato digitado sem acento
---

Na janela **Encaminhar**, a busca ignorava maiúsculas, mas não acento: digitar `joao` não achava "João", e quem atendia rolava a lista inteira atrás do contato. Agora `joao` acha "João" e `conceicao` acha "Conceição", e letras como ñ, ü, ø e ß também caem para a letra base. O nome mostrado na lista não muda.

Portado do projeto original (DeskcommCRM, PR #4078 de @bfs2021).
