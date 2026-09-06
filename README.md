# Audio Transcriber

Audio Transcriber e uma aplicacao web para capturar audio no navegador, enviar o arquivo para um backend e gerar transcricoes com Whisper ou faster-whisper.

O objetivo do projeto e permitir uso direto pelo navegador, sem exigir que o usuario instale ferramentas locais de captura de audio como sounddevice, PipeWire, PulseAudio, ALSA ou pactl. A captura deve acontecer via APIs web apropriadas, e o processamento pesado deve ficar no backend.

## Visao geral

Fluxo planejado:

```text
Usuario
  -> Frontend web
  -> Captura de audio no navegador
  -> Gravacao
  -> Upload para API
  -> Backend
  -> Processamento e conversao
  -> Whisper / faster-whisper
  -> Transcricao
  -> TXT / SRT
  -> Download pelo usuario
```

## Principios de arquitetura

- A captura de audio nao depende do computador do usuario.
- O navegador e responsavel por gravar audio dentro das permissões disponiveis.
- O backend e responsavel por validacao, processamento, conversao e transcricao.
- A aplicacao deve buscar compatibilidade com Windows, Linux, macOS e navegadores modernos.
- Nao e possivel prometer compatibilidade absoluta com todo dispositivo ou navegador, porque as capacidades de captura dependem do navegador, do sistema operacional e das permissoes concedidas.

## Stack planejada

### Frontend

- HTML, CSS e JavaScript inicialmente, ou a tecnologia escolhida durante o desenvolvimento
- APIs nativas do navegador para captura de audio
- MediaRecorder e APIs relacionadas quando apropriado

### Backend

- Python
- API HTTP/REST
- faster-whisper para transcricao
- FFmpeg para processamento e conversao quando necessario

### Banco de dados

- PostgreSQL, quando a persistencia for implementada

### Infraestrutura

- Docker
- Docker Compose
- Deploy em producao posteriormente

## Estado atual

O projeto ainda esta no inicio. O historico registra a inicializacao do repositorio e experimentos tecnicos anteriores relacionados a captura local de audio. Esses experimentos ajudam a entender o ponto de partida, mas nao definem a arquitetura alvo do produto.

O direcionamento atual e web-first:

- a captura final deve acontecer no navegador;
- o backend deve receber o audio e processar a transcricao;
- a solucao nao deve depender de configuracoes locais de audio do usuario.

Neste momento, a aplicacao final ainda nao tem o fluxo completo de gravacao no navegador, upload, processamento e exportacao implementado.

## O que ja existe

- Inicializacao do projeto no Git.
- Historico de experimentacao tecnica com captura local de audio.

## O que ainda nao esta concluido

- Captura de audio pelo navegador
- Upload para a API
- Processamento com FFmpeg
- Transcricao com Whisper / faster-whisper
- Exportacao de TXT
- Exportacao de SRT
- Interface final
- Historico de transcricoes
- Autenticacao
- Limites de seguranca e uso
- Docker e deploy de producao

## Roadmap por sprints

### Sprint 1 - Estrutura do projeto

Objetivo: preparar a base da aplicacao web com frontend e backend.

- Organizar o repositorio
- Criar frontend
- Criar backend
- Configurar estrutura inicial
- Criar README
- Definir arquitetura inicial
- Configurar ambiente de desenvolvimento

Status: EM DESENVOLVIMENTO

### Sprint 2 - Captura de audio no navegador

Objetivo: permitir que o usuario grave audio diretamente pelo navegador.

- Interface inicial
- Botao para iniciar gravacao
- Solicitacao de permissao
- Captura de audio
- Botao para parar gravacao
- Armazenamento temporario da gravacao
- Tratamento de permissoes
- Tratamento de erros
- Testes em diferentes navegadores

Status: PLANEJADO

### Sprint 3 - Reproducao e exportacao

Objetivo: permitir que o usuario confira a gravacao antes de enviar.

- Player de audio
- Mostrar duracao
- Reproduzir gravacao
- Refazer gravacao
- Baixar audio localmente
- Definir formato adequado

Status: PLANEJADO

### Sprint 4 - API de upload

Objetivo: enviar a gravacao do navegador para o backend.

- Endpoint de upload
- multipart/form-data
- Validacao do arquivo
- Limite de tamanho
- Validacao de formato
- Armazenamento temporario
- Resposta da API

Status: PLANEJADO

### Sprint 5 - Processamento de audio

Objetivo: preparar o audio recebido para a transcricao.

- Integracao com FFmpeg
- Conversao de formatos
- Normalizacao do audio
- Preparacao para Whisper
- Limpeza de arquivos temporarios

Status: PLANEJADO

### Sprint 6 - Transcricao com Whisper

Objetivo: transformar o audio em texto.

- Integrar faster-whisper
- Carregar modelo
- Processar audio
- Gerar transcricao
- Retornar resultado pela API
- Tratamento de erros
- Medicao do processamento

Status: PLANEJADO

### Sprint 7 - Idiomas

Objetivo: permitir transcricao em diferentes idiomas.

- Detecao automatica de idioma
- Selecao manual de idioma
- Envio do idioma para API
- Retorno do idioma detectado

Status: PLANEJADO

### Sprint 8 - Exportacao TXT

Objetivo: permitir que o usuario baixe a transcricao.

- Gerar TXT
- Download
- Copiar texto
- Nome automatico do arquivo

Status: PLANEJADO

### Sprint 9 - SRT e timestamps

Objetivo: gerar legendas sincronizadas.

- Capturar timestamps
- Gerar formato SRT
- Download SRT
- Formatar timestamps corretamente

Status: PLANEJADO

### Sprint 10 - Interface profissional

Objetivo: transformar o prototipo em uma aplicacao agradavel de usar.

- Landing page
- Interface de transcricao
- Loading
- Progresso
- Estados de erro
- Empty states
- Responsividade
- Dark mode
- Melhorias de UX

Status: PLANEJADO

### Sprint 11 - Historico

Objetivo: permitir que usuarios acessem transcricoes anteriores.

- Persistencia no banco
- Historico
- Visualizacao
- Exclusao
- Download novamente

Status: PLANEJADO

### Sprint 12 - Autenticacao

Objetivo: adicionar contas de usuario.

- Cadastro
- Login
- Logout
- Autenticacao
- Protecao dos endpoints
- Associacao das transcricoes ao usuario

Status: PLANEJADO

### Sprint 13 - Seguranca e limites

Objetivo: preparar a aplicacao para uso publico.

- Limite de tamanho
- Limite de duracao
- Rate limiting
- Validacao de arquivos
- Sanitizacao
- Timeout de processamento
- Limpeza automatica
- Limites por usuario ou IP

Status: PLANEJADO

### Sprint 14 - Docker

Objetivo: padronizar o ambiente de execucao.

- Dockerfile
- Docker Compose
- Backend
- Frontend
- PostgreSQL
- FFmpeg
- Variaveis de ambiente
- Healthchecks
- Logs

Status: PLANEJADO

### Sprint 15 - Deploy

Objetivo: disponibilizar o sistema na internet.

- Deploy do frontend
- Deploy do backend
- Banco de producao
- HTTPS
- CORS
- Dominio
- Variaveis de ambiente
- Testes externos

Status: PLANEJADO

### Sprint 16 - Polimento

Objetivo: preparar a primeira versao publica.

- Correcao de bugs
- Melhorias de UX
- Testes em diferentes dispositivos
- Testes em diferentes navegadores
- Testes com arquivos grandes
- Tratamento de falhas de conexao
- Documentacao da API
- Melhorias no README

Status: PLANEJADO

## Estrategia de commits

O projeto segue Conventional Commits.

Exemplos:

- `feat: nova funcionalidade`
- `fix: correcao de bug`
- `refactor: refatoracao`
- `style: alteracoes visuais ou de formatacao`
- `test: testes`
- `docs: documentacao`
- `chore: configuracao ou manutencao`

Diretrizes:

- manter commits pequenos e focados em uma unica alteracao;
- evitar commits genéricos;
- testar a funcionalidade antes de considera-la concluida;
- commitar apenas quando a funcionalidade estiver funcionando.

## Regras de desenvolvimento

- Implementar uma funcionalidade por vez.
- Nao avancar para sprints futuras sem necessidade.
- Priorizar solucoes multiplataforma.
- Nao depender de tecnologias especificas do computador do usuario para capturar audio.
- O backend deve ser o responsavel pelo processamento e pela transcricao.
- Nao adicionar dependencias desnecessarias.
- Manter a arquitetura documentada quando houver mudancas relevantes.

## Estrutura esperada

A estrutura pode evoluir conforme a tecnologia escolhida, mas a separacao entre frontend e backend deve permanecer clara.

```text
audio-transcriber/
├── frontend/
├── backend/
├── README.md
└── .gitignore
```

## Como este README deve ser usado

Antes de implementar qualquer nova funcionalidade:

1. Verifique em qual sprint ela pertence.
2. Verifique se ela ja foi implementada.
3. Leia o estado atual do projeto.
4. Nao refaca funcionalidades existentes sem necessidade.
5. Nao avance varias sprints de uma vez.
6. Atualize este README quando uma sprint ou funcionalidade for realmente concluida.

