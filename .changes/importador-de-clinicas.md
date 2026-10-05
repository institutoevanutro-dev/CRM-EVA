---
impacto: capacidade_nova
secao: adicionado
titulo: Importar clínicas de uma planilha, por comando
---

`pnpm tsx scripts/importar-clinicas.ts planilha.xlsx --destino <host>` lê uma
planilha com as abas Clínicas, Perguntas frequentes e Atendentes e mostra o que
faria. Com `--aplicar --ator <e-mail>`, cria ou atualiza cada clínica: empresa,
funil de clínica, perguntas frequentes (a função continua desligada), agente
"Recepção" em rascunho, regras da casa na memória e acesso dos atendentes, sem
enviar e-mail. `--convidar` envia o convite aos atendentes novos. Rodar a mesma
planilha de novo não duplica nada, e o comando recusa empresa que não criou.
`--gerar-modelo modelo.xlsx` gera a planilha em branco com uma linha de exemplo.
