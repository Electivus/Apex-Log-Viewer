# Nx Monorepo com CLI Rust e App Server para a extensão

**Data:** 2026-03-27  
**Status:** Aprovado para planejamento (pré-implementação)  
**Contexto do repo:** `Apex-Log-Viewer` (extensão VS Code com backend hoje concentrado em TypeScript)

## Problema

Hoje o repositório é um pacote único de extensão VS Code. A lógica de domínio está concentrada principalmente no extension host em TypeScript, incluindo:

- descoberta de orgs e reaproveitamento de autenticação do Salesforce CLI
- cache persistente e cache em memória
- leitura, download e busca de logs
- triage/classificação de erro
- tailing/streaming
- gerenciamento de Debug Flags

Esse desenho traz quatro problemas principais:

1. A extensão carrega responsabilidades demais no extension host.
2. O produto não tem um CLI standalone próprio para entregar valor fora do VS Code.
3. O backend fica acoplado à superfície VS Code, dificultando reaproveitamento futuro por CLI e MCP.
4. Integrações baseadas em terminal integrado são operacionalmente ruins: output difícil de correlacionar, ausência de contratos fortes, dificuldade de cancelamento, timeouts e observabilidade.

## Decisões aprovadas

As decisões abaixo foram aprovadas durante o brainstorming e são consideradas parte do design validado:

- O repositório vai migrar para **monorepo com Nx**.
- O produto principal passa a ser um **CLI standalone próprio em Rust**.
- O CLI deve expor **todo o valor adicional** que hoje existe além do que o `sf` oficial entrega por padrão.
- O runtime compartilhado será um **processo separado** e não bindings nativos Node <-> Rust.
- A extensão vai consumir esse runtime por meio de um **daemon/app-server** embutido no mesmo binário do CLI.
- O transporte padrão entre extensão e runtime será **`stdio`**.
- A comunicação será estruturada e confiável, sem depender do terminal integrado.
- A **VSIX deve empacotar o binário por plataforma**, sem depender de instalação separada no `PATH`.
- O primeiro desenho já deve contemplar os targets:
  - `linux-x64`
  - `linux-arm64`
  - `win32-x64`
  - `win32-arm64`
  - `darwin-x64`
  - `darwin-arm64`

## Objetivos

1. Transformar o repositório em um monorepo com fronteiras explícitas entre extensão, webview, protocolo e runtime.
2. Criar um produto Rust reutilizável por:
   - CLI standalone
   - extensão VS Code
   - futura superfície MCP
3. Tirar do extension host toda a lógica de domínio e estado operacional.
4. Substituir integrações frágeis por um protocolo forte, tipado, observável e cancelável.
5. Preservar a experiência atual da extensão durante a migração, com rollout em fases.
6. Manter o fluxo de build, testes, empacotamento e publicação compatível com Marketplace/Open VSX.

## Não-objetivos

- Reescrever a interface webview nesta etapa.
- Tornar a extensão compatível com `vscode.dev`/web extension neste design.
- Reescrever o produto inteiro em um único corte.
- Migrar para múltiplos runtimes concorrentes ou para uma arquitetura distribuída.
- Definir já todos os comandos MCP; o importante aqui é preservar a possibilidade arquitetural.

## Restrições e premissas

- A extensão atual continua sendo uma extensão Node/desktop, não uma web extension.
- O runtime Rust será tratado como backend oficial do produto, e não como ferramenta auxiliar.
- O Salesforce CLI continua podendo ser usado como fonte de autenticação e descoberta, mas o valor do produto deve viver no runtime `apex-log-viewer`.
- A UI VS Code continua responsável por experiência de usuário, renderização, comandos do workbench e integrações específicas do editor.
- O protocolo entre extensão e runtime precisa ser versionado para evitar drift entre releases.
- O design precisa suportar packaging platform-specific oficial via VSIX.

## Arquitetura recomendada

### Abordagem aprovada

Foi aprovada a abordagem **CLI-first com `app-server` embutido no mesmo binário Rust**, inspirada no padrão usado por produtos como o Codex:

- binário principal: `apex-log-viewer`
- modo CLI para usuário final
- subcomando de servidor: `apex-log-viewer app-server --stdio`
- extensão VS Code atuando como cliente fino desse runtime

Esse desenho combina:

- produto externo simples
- separação interna forte entre crates
- reaproveitamento do mesmo backend por múltiplas superfícies
- eliminação da dependência de terminal integrado

### Estrutura proposta do monorepo

```text
/
  nx.json
  package.json
  tsconfig.base.json
  Cargo.toml
  apps/
    vscode-extension/
  packages/
    webview/
    app-server-client-ts/
    test-support/
  crates/
    alv-core/
    alv-protocol/
    alv-app-server/
    alv-cli/
    alv-mcp/
  tools/
    generators/
  docs/
    ...
```

### Responsabilidade por superfície

**`apps/vscode-extension/`**

- manifesto da extensão
- activation code
- registro de comandos VS Code
- integração com Replay Debugger
- lifecycle do processo Rust
- telemetria da superfície VS Code

**`packages/webview/`**

- React UI
- reducers, componentes e modelos de apresentação
- nenhuma dependência direta de Salesforce, Node child process ou APIs de domínio

**`packages/app-server-client-ts/`**

- client TypeScript centralizado para o runtime Rust
- parser JSONL
- correlação request/response
- subscriptions de notifications
- restart/backoff/timeouts/cancelamento

**`crates/alv-core/`**

- auth
- cache
- org discovery
- logs
- search
- triage
- tail
- debug flags
- configuração efetiva
- políticas de timeout, retry e concorrência

**`crates/alv-protocol/`**

- métodos do contrato
- params/results/events
- códigos de erro
- handshake/capabilities
- geração de tipos Rust e TypeScript

**`crates/alv-app-server/`**

- transporte `stdio`
- camada JSON-RPC
- session manager
- backpressure
- cancelamento
- lifecycle do runtime

**`crates/alv-cli/`**

- UX do terminal
- output humano e `--json`
- comandos de alto valor do produto
- subcomando `app-server`

**`crates/alv-mcp/`**

- futura superfície MCP usando o mesmo `alv-core`

## Fronteiras arquiteturais

As fronteiras abaixo são mandatórias no design final:

1. Nada em `apps/vscode-extension` deve falar com Salesforce diretamente após o cutover final.
2. Nada em `packages/webview` deve depender de processo, spawn ou detalhes do runtime.
3. Nada em `alv-core` deve depender de VS Code, JSON-RPC, output de terminal ou tipos de UI.
4. A extensão fala com o runtime apenas por meio do `app-server-client-ts`.
5. O `app-server` fala com o backend apenas por meio do `alv-core`.
6. O contrato de integração entre Rust e TypeScript vive em `alv-protocol`.

## Protocolo e ciclo de vida do runtime

### Processo

A extensão resolve um binário embutido na própria VSIX e executa:

```bash
apex-log-viewer app-server --stdio
```

Regras do processo:

- `stdout`: somente protocolo estruturado
- `stderr`: logs/tracing/diagnóstico
- sem shell
- sem terminal integrado
- sem parse de output humano para dirigir comportamento

### Transporte

- JSON-RPC 2.0 em **JSON Lines** sobre `stdin/stdout`
- handshake obrigatório por conexão:
  - `initialize`
  - `initialized`

O handshake deve retornar ao menos:

- `runtimeVersion`
- `protocolVersion`
- `platform`
- `arch`
- capacidades disponíveis
- diretórios de state/cache utilizados

### Estilo de API

Requests síncronos para ações pontuais, por exemplo:

- `org/list`
- `org/auth/read`
- `logs/list`
- `log/read`
- `search/query`
- `debugFlags/list`
- `debugFlags/apply`
- `tail/start`
- `tail/stop`
- `runtime/doctor`

Notifications/eventos para progresso e streams:

- `tail/event`
- `search/progress`
- `logs/download/progress`
- `runtime/warning`
- `runtime/error`
- `org/stateChanged`

### Cancelamento

O protocolo deve suportar cancelamento explícito por request id. A extensão precisa conseguir abortar:

- refresh
- search
- download em lote
- bootstrap de tail
- qualquer chamada longa do runtime

### Backpressure

O runtime deve usar filas limitadas e comportamento explícito de overload. O design aprovado assume:

- filas bounded entre leitura de transporte, processamento e escrita
- erro explícito quando o servidor estiver saturado
- consumo robusto de notifications pela extensão
- nenhuma dependência em crescimento não limitado de memória

### Ciclo de vida

- um runtime por extension host/window
- startup lazy, acionado pela primeira operação real
- restart controlado com backoff quando o processo cair
- estado operacional no Rust, não no extension host

Estado que deve viver no runtime:

- auth cache
- org discovery cache
- log cache
- sessões de tail
- downloads em andamento
- políticas efetivas de retry/concurrency

Estado que continua na extensão/UI:

- seleção de filtros de UI
- layout/colunas
- estado de navegação
- ações específicas de VS Code

## Escopo funcional do CLI

O CLI deve cobrir tudo o que agrega valor além do `sf` oficial. Isso inclui, no mínimo:

- busca local/full-text em logs
- triage e classificação de erros
- download e gerenciamento de cache de logs
- tailing com buffer e eventos estruturados
- workflows de Debug Flags mais produtivos
- comandos de diagnóstico (`doctor`) para o runtime
- output estruturado `--json` onde fizer sentido

O CLI não deve ser um wrapper fino do `sf`; ele deve ser o produto principal.

## Packaging e distribuição da extensão

### Estratégia aprovada

A recomendação aprovada é publicar a extensão como **platform-specific extension**, em vez de uma VSIX universal com todos os binários.

Motivos:

- evita embutir binários de seis plataformas em toda instalação
- usa o fluxo oficial suportado pelo Marketplace
- mantém distribuição mais enxuta por target
- combina bem com dependências/bits nativos

### Targets aprovados

- `linux-x64`
- `linux-arm64`
- `win32-x64`
- `win32-arm64`
- `darwin-x64`
- `darwin-arm64`

### Layout esperado na extensão empacotada

```text
apps/vscode-extension/
  package.json
  dist/extension.js
  media/...
  bin/
    linux-x64/apex-log-viewer
    linux-arm64/apex-log-viewer
    win32-x64/apex-log-viewer.exe
    win32-arm64/apex-log-viewer.exe
    darwin-x64/apex-log-viewer
    darwin-arm64/apex-log-viewer
```

### Regras operacionais de empacotamento

- o release deve gerar uma VSIX por target
- a extensão deve resolver o binário correto em runtime a partir de `process.platform` e `process.arch`
- o pipeline deve preservar bits executáveis POSIX para Linux/macOS
- publicar Unix binaries a partir de Windows não é aceitável como fluxo principal de release

## Estratégia de migração

### Fase 0: Nx sem mudança de comportamento

- introduzir `Nx` no repo
- separar a extensão atual em projetos explícitos
- manter o backend ainda em TypeScript
- migrar build/test/package para targets do Nx

### Fase 1: workspace Rust e protocolo mínimo

- adicionar workspace Cargo
- criar `alv-core`, `alv-protocol`, `alv-app-server`, `alv-cli`
- implementar handshake mínimo
- gerar tipos TS
- subir o runtime Rust pela extensão e validar `initialize`

### Fase 2: org/auth/cache no Rust

- migrar descoberta de orgs
- migrar reaproveitamento de auth
- migrar cache persistente e em memória
- tornar o runtime a fonte de verdade para estado operacional de org

### Fase 3: logs, search, triage e tail

- migrar listagem/leitura/download de logs
- migrar busca local/full-text
- migrar triage
- migrar tailing e streaming
- converter a extensão para consumir o `app-server-client-ts`

### Fase 4: debug flags e maturação do CLI

- migrar debug flags/debug levels
- expor os comandos standalone do produto
- consolidar output humano e `--json`

### Fase 5: cutover final

- remover backend TypeScript legado
- manter no TypeScript apenas:
  - integração VS Code
  - client TS do app-server
  - webview
  - modelos estritamente de apresentação

## Testes e verificação

### Pirâmide de testes desejada

**Rust**

- `alv-core`: testes unitários por módulo
- `alv-app-server`: testes de protocolo, cancelamento, streaming e overload
- `alv-cli`: testes de snapshot/contract para output humano e `--json`

**TypeScript**

- `app-server-client-ts`: parser, correlação, restart, timeout, cancelamento
- webview: testes Jest
- extensão VS Code: integração com daemon fake e com daemon real

**E2E**

- Playwright/scratch org continua existindo
- passa a validar a extensão já consumindo o binário embutido

### Critério de sucesso da migração

A migração só deve ser considerada completa quando as três superfícies abaixo usarem o mesmo backend Rust:

- CLI standalone
- extensão VS Code
- superfície MCP futura

## CI e release

O `Nx` vira o orquestrador principal do monorepo, sem esconder os toolchains reais.

O pipeline final deve cobrir:

- lint/typecheck TypeScript
- `cargo fmt --check`
- `cargo clippy`
- `cargo test`
- testes webview
- testes unit/integration da extensão em VS Code `stable`
- E2E Playwright
- smoke test da extensão com binário embutido
- package matrix por target
- publish de VSIXs platform-specific

### Matriz recomendada

- `ubuntu-latest`
  - checks TS/Rust
  - package `linux-x64`
  - package `linux-arm64`
- `windows-latest`
  - package `win32-x64`
  - package `win32-arm64`
- `macos-latest`
  - package `darwin-x64`
  - package `darwin-arm64`

## Riscos principais e mitigação

### Risco 1: Drift entre Rust e TypeScript

Mitigação:

- contrato único em `alv-protocol`
- geração de tipos TS
- testes de contrato entre client TS e app-server

### Risco 2: Extensão ficar com backend duplicado por muito tempo

Mitigação:

- fases explícitas de cutover
- regra arquitetural proibindo novo domínio em TypeScript
- remoção planejada do backend legado ao final

### Risco 3: Processo Rust cair ou saturar

Mitigação:

- lifecycle manager no client TS
- restart com backoff
- filas limitadas
- erros estruturados de overload

### Risco 4: Packaging multi-plataforma complicar o release

Mitigação:

- usar fluxo oficial de platform-specific extension
- package por target em CI
- manter release matrix explícita

## Consequência explícita deste design

Este design **não** persegue compatibilidade com web extension como objetivo primário. Como a extensão passa a depender de spawn de binário nativo embutido, a superfície suportada é desktop/Node extension host.

## Referências externas que embasaram o design

- Nx monorepos: `https://nx.dev/docs/concepts/decisions/why-monorepos`
- Nx + Rust release/workspace: `https://nx.dev/docs/guides/nx-release/publish-rust-crates`
- VS Code e processo separado: `https://code.visualstudio.com/api/language-extensions/language-server-extension-guide`
- Limitações de web extensions para spawn/binários: `https://code.visualstudio.com/api/extension-guides/web-extensions`
- Packaging platform-specific de extensões VS Code: `https://code.visualstudio.com/api/working-with-extensions/publishing-extension`
- `vsce` e `--target`: `https://github.com/microsoft/vscode-vsce`
- Node child process assíncrono: `https://nodejs.org/api/child_process.html`
- Node e não bloquear o event loop: `https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop`

