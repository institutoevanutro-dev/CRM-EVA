---
impacto: nada_mudou
secao: corrigido
titulo: Contatos com CPF voltam a ser importados e cadastrados
---
Importar uma planilha com a coluna CPF fazia quase todas as linhas falharem, e criar ou editar um contato com CPF pela tela dava erro: a proteção do CPF (cifra) que o sistema usava não existia no banco. A atualização cria essa proteção usando a chave de cifra que a instalação já tem, sem nenhum passo manual. Se a proteção ainda assim estiver indisponível, o import grava o contato sem o CPF e avisa linha por linha, e o cadastro unitário explica o motivo em vez de mostrar um erro genérico.
