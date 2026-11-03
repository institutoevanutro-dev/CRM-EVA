---
impacto: nada_mudou
secao: corrigido
titulo: O agente espera a transcrição do áudio que chega logo depois da mensagem
---

Quando o paciente escrevia uma mensagem e mandava um áudio logo em seguida, a
resposta ao texto podia começar antes de o áudio virar texto. O agente lia o
áudio como "[audio]", e a resposta deixava de fora o que o paciente tinha dito.

Agora, antes de escolher o agente e de escrever a resposta, o sistema confere se
há áudio, foto ou documento da conversa ainda sendo transcrito e espera por ele,
dentro do mesmo teto de 2 minutos que já valia. Assim o agente certo responde ao
texto e ao áudio de uma vez.

Passado o teto, a resposta sai sem o texto, como antes, e o registro do worker
diz que a espera terminou no teto. Se a mídia que não ficou pronta tem a própria
resposta a caminho, a resposta desatualizada é descartada e só uma sai.

A primeira resposta pode demorar alguns segundos a mais numa conversa com áudio
recém-chegado. Nada precisa ser feito na instalação.

Portado do projeto original (DeskcommCRM, PR #3841 e PR #3846 de @webtecnica).
