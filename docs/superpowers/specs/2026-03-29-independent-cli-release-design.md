# Release Independente do CLI com Publicacao em crates.io e npm

**Data:** 2026-03-29  
**Status:** Aprovado para planejamento (pre-implementacao)  
**Contexto do repo:** `Apex-Log-Viewer` (extensao VS Code com runtime Rust embutido e CLI proprio em evolucao)

## Problema

O repositorio ja contem um CLI Rust (`apex-log-viewer`) e a extensao VS Code ja o embute na VSIX por plataforma. Hoje, porem, o processo de release continua centrado na extensao:

- a automacao oficial publica VSIX, Marketplace e Open VSX
- o build do runtime da extensao usa o codigo atual do workspace
- nao existe trilho dedicado para publicar o CLI como produto proprio
- nao existe distribuicao oficial do CLI em `crates.io`
- nao existe distribuicao oficial do CLI em `npm`

Esse desenho conflita com o objetivo aprovado para o produto:

1. o CLI precisa poder evoluir mais rapido que a extensao
2. a extensao precisa continuar presa a uma versao do CLI que foi testada e validada em conjunto
3. usuarios avancados precisam poder apontar a extensao para um executavel alternativo do CLI
4. o modelo de distribuicao deve seguir o padrao adotado pelo Codex: CLI com ciclo proprio, tags proprias e pacote npm principal com variantes nativas por plataforma

## Decisoes aprovadas

As decisoes abaixo foram aprovadas durante o brainstorming e sao parte do design validado:

- O CLI passa a ter **ciclo de release proprio**, separado do ciclo da extensao VS Code.
- O CLI usa **tags dedicadas** no formato:
  - stable: `rust-vX.Y.Z`
  - pre-release: `rust-vX.Y.Z-alpha.N`
- O CLI sera publicado em **tres canais oficiais**:
  - `crates.io`
  - `npm`
  - GitHub Releases
- A distribuicao no `npm` seguira o padrao **meta package + pacotes nativos por plataforma**, sem `postinstall` que baixa binarios.
- A extensao fica **pinada a uma versao exata do CLI**, que sera a versao embutida e validada na VSIX.
- A extensao aceitara **sempre** um CLI externo configurado manualmente, **sem bloqueio de compatibilidade**.
- Quando um CLI externo for configurado, a extensao exibira um **aviso em tom de desenvolvimento/manutencao**, no estilo da extensao do Codex.
- A compatibilidade entre extensao e runtime sera observada via **handshake/protocolo**, e nao pela exigencia de versao identica entre produtos.

## Objetivos

1. Publicar o CLI como produto proprio, independente da extensao.
2. Permitir releases mais frequentes do CLI sem obrigar release simultaneo da extensao.
3. Distribuir o CLI por `cargo install`, `npm install -g` e download direto de GitHub Release.
4. Preservar a extensao como consumidor conservador de uma versao validada do runtime.
5. Permitir override manual do executavel do CLI sem bloqueio artificial.
6. Tornar o pipeline de release do CLI previsivel, reproduzivel e proximo do modelo usado pelo Codex.

## Nao-objetivos

- Unificar novamente o versionamento do CLI e da extensao.
- Trocar o empacotamento principal da extensao por instalacao obrigatoria do CLI no `PATH`.
- Implementar negociacao dura de compatibilidade que bloqueie CLI externo.
- Introduzir downloads de binario em `postinstall` do `npm`.
- Fazer o CLI seguir a convencao odd/even minor usada hoje pela extensao VS Code.

## Identidade publica do CLI

### Binario

- Nome do executavel: `apex-log-viewer`

Esse nome continua sendo usado:

- no binario embutido pela extensao
- no `npm` como comando exposto ao usuario
- no runtime iniciado pela extensao via `app-server --stdio`

### Crate publico

- Nome publico no `crates.io`: `apex-log-viewer-cli`
- Comando instalado pelo crate: `apex-log-viewer`

Para suportar a publicacao no `crates.io`, o package name do crate em `crates/alv-cli/Cargo.toml` passa a refletir esse nome publico. O diretorio pode continuar sendo `crates/alv-cli/`; o nome publico e o caminho no workspace nao precisam ser identicos.

### Pacotes npm

- Meta package: `@electivus/apex-log-viewer`
- Pacotes nativos:
  - `@electivus/apex-log-viewer-linux-x64`
  - `@electivus/apex-log-viewer-linux-arm64`
  - `@electivus/apex-log-viewer-darwin-x64`
  - `@electivus/apex-log-viewer-darwin-arm64`
  - `@electivus/apex-log-viewer-win32-x64`
  - `@electivus/apex-log-viewer-win32-arm64`

O meta package expora o binario `apex-log-viewer` e resolvera o pacote nativo correspondente a plataforma atual.

## Modelo de versionamento

### CLI

- Fonte canonica da versao do CLI: `crates/alv-cli/Cargo.toml`
- Tag de release:
  - stable: `rust-vX.Y.Z`
  - pre-release: `rust-vX.Y.Z-alpha.N`
- O CLI usa semver normal de Rust/npm.
- O canal do CLI e determinado pelo proprio semver:
  - sem sufixo pre-release: stable
  - com `-alpha.N`: pre-release

O CLI **nao** usa a regra odd/even minor da extensao. Essa regra continua exclusiva da extensao VS Code.

### npm dist-tags

- Stable publica no dist-tag `latest`
- Pre-release publica no dist-tag `next`

Exemplos:

- `npm install -g @electivus/apex-log-viewer@latest` instala stable
- `npm install -g @electivus/apex-log-viewer@next` instala o pre-release mais recente
- `npm install -g @electivus/apex-log-viewer@1.3.0-alpha.2` instala uma versao preview especifica

### Extensao VS Code

A extensao continua com seu proprio versionamento e seu proprio processo de release. Ela nao herda automaticamente a ultima versao do CLI. Em vez disso, cada release da extensao aponta explicitamente para uma versao do CLI ja validada.

## Distribuicao do CLI

### 1. crates.io

O workflow do CLI publica o crate `apex-log-viewer-cli` em `crates.io` sempre que uma tag `rust-v...` valida e promovida for disparada.

O artefato publicado deve:

- instalar o binario `apex-log-viewer`
- refletir exatamente a mesma versao do release tag
- suportar versoes stable e pre-release

### 2. GitHub Releases

Cada tag `rust-v...` gera um GitHub Release proprio do CLI.

Assets obrigatorios:

- `apex-log-viewer-<version>-linux-x64.tar.gz`
- `apex-log-viewer-<version>-linux-arm64.tar.gz`
- `apex-log-viewer-<version>-darwin-x64.tar.gz`
- `apex-log-viewer-<version>-darwin-arm64.tar.gz`
- `apex-log-viewer-<version>-win32-x64.zip`
- `apex-log-viewer-<version>-win32-arm64.zip`
- `apex-log-viewer-<version>-SHA256SUMS.txt`

Esses assets servem para:

- download direto por usuarios
- troubleshooting e reproducao
- bundling da extensao em modo pinado
- futuros instaladores ou scripts operacionais

### 3. npm

#### Meta package

O meta package `@electivus/apex-log-viewer` contem:

- o launcher JS em `bin/apex-log-viewer.js`
- os `optionalDependencies` apontando para todos os pacotes nativos da mesma versao
- a logica de resolucao de plataforma
- a delegacao para o binario correto

#### Pacotes nativos

Cada pacote nativo contem apenas:

- o binario da plataforma
- metadata de plataforma (`os` e `cpu`)
- package metadata minima

#### Regra operacional

- Nao usar `postinstall` para baixar binarios.
- Nao depender de GitHub durante `npm install`.
- O `npm install` deve resolver tudo via registry, com comportamento previsivel em CI e cache corporativo.

## Arquitetura do pacote npm

O repositorio passa a ter uma camada dedicada para o empacotamento npm do CLI:

```text
packages/
  cli-npm/
    bin/
      apex-log-viewer.js
    templates/
      package.meta.json
      package.native.json
    README.md
scripts/
  build-cli-npm-packages.mjs
```

`packages/cli-npm/` e a fonte do launcher e dos templates. Os manifests finais dos sete pacotes npm sao gerados em staging durante o release, a partir da versao lida de `crates/alv-cli/Cargo.toml` e dos binarios compilados na matriz de build.

Esse desenho evita manter sete pacotes duplicados com versao hardcoded dentro do repositorio.

## CI/CD do CLI

### Workflow novo

O repositorio ganha um workflow dedicado:

- `.github/workflows/rust-release.yml`

Trigger:

- `push` de tags `rust-v*`

O pipeline do CLI e totalmente separado do workflow de release da extensao.

### Sequencia de jobs

### 1. Validacao da tag

Validacoes obrigatorias:

- a ref e uma tag
- a tag casa com `^rust-v`
- a versao da tag e identica a versao em `crates/alv-cli/Cargo.toml`
- prerelease e reconhecido apenas por semver real (`-alpha.N`)

### 2. Testes do CLI/runtime

Gates obrigatorios antes de publicar:

- `npm run test:rust`
- smoke do launcher npm em staging para pelo menos:
  - `apex-log-viewer --version`
  - smoke do `app-server` por `stdio`, abrindo o processo, enviando `initialize` e validando resposta estruturada

O release do CLI nao depende da suite completa da extensao VS Code. O acoplamento aqui e intencionalmente baixo.

### 3. Build multiplataforma

Targets oficiais:

- `linux-x64`
- `linux-arm64`
- `darwin-x64`
- `darwin-arm64`
- `win32-x64`
- `win32-arm64`

Cada target produz:

- binario nativo
- arquivo compactado para GitHub Release
- insumo para o pacote npm nativo correspondente

### 4. Staging dos pacotes npm

Um script dedicado gera:

- um diretorio do meta package
- seis diretorios de pacotes nativos
- `package.json` finais com versao sincronizada ao release atual

### 5. Publicacao npm

Ordem de publicacao:

1. publicar os seis pacotes nativos
2. publicar o meta package

Essa ordem evita que o meta package fique visivel apontando para dependencias opcionais ainda indisponiveis.

Canal:

- stable -> `npm publish --tag latest`
- pre-release -> `npm publish --tag next`

### 6. Publicacao em crates.io

O crate e publicado depois que a fase de build/testes passou e antes do fechamento do release.

Segredo necessario:

- `CARGO_REGISTRY_TOKEN`

### 7. GitHub Release

O workflow cria ou atualiza o GitHub Release da tag `rust-v...` e anexa:

- os seis assets nativos
- o arquivo de checksums

O release fica marcado como pre-release quando a propria versao do CLI for pre-release.

## Empacotamento da extensao com CLI pinado

### Fonte do pin

A extensao passa a ler um arquivo explicito:

- `config/runtime-bundle.json`

Formato:

```json
{
  "cliVersion": "1.2.3",
  "tag": "rust-v1.2.3",
  "channel": "stable",
  "protocolVersion": "1"
}
```

Esse arquivo e a referencia oficial para o runtime embutido na extensao.

### Regra de bundling da extensao

Para empacotamento de release da extensao:

- a extensao **nao** compila automaticamente o CLI do workspace HEAD
- a extensao baixa os assets do GitHub Release apontado por `config/runtime-bundle.json`
- a VSIX embute exatamente esse runtime pinado

Para desenvolvimento local:

- o fluxo atual de build local pode continuar compilando o CLI do workspace para iteracao rapida
- o override manual de executavel continua disponivel para desenvolvimento da extensao e do CLI

Esse desenho resolve o problema central do produto: o repo pode conter um CLI mais avancado, enquanto a extensao continua empacotando a ultima versao validada em conjunto.

## Contrato entre extensao e CLI

O handshake `initialize` do `app-server` deve expor ao menos:

- `cliVersion`
- `protocolVersion`
- `channel`

A extensao usa esses campos para:

- diagnostico
- logging
- suporte
- exibicao de informacao em troubleshooting

A extensao **nao bloqueia** o uso de um CLI externo por divergencia de versao ou canal. O contrato aqui e observacional, nao coercitivo.

## Configuracao de CLI externo na extensao

Nova configuracao:

- `electivus.apexLogs.runtimePath`

Texto esperado no Settings UI, em linha com o modelo do Codex:

> DEVELOPMENT ONLY: Path to the Apex Log Viewer CLI executable. You do NOT need to set this unless you are actively developing the Apex Log Viewer CLI. If set manually, parts of the extension may not work as expected.

Comportamento:

- se vazio, usar o binario embutido na VSIX
- se preenchido, usar o executavel informado
- sempre aceitar sem validacao preventiva
- exibir aviso de override/manual path
- registrar nos logs/diagnostics que um runtime externo esta em uso

## Segredos e publicacao

Novos segredos necessarios para o pipeline do CLI:

- `NPM_TOKEN`
- `CARGO_REGISTRY_TOKEN`

Os segredos atuais da extensao permanecem separados:

- `VSCE_PAT`
- `OVSX_PAT`

Essa separacao preserva independencia operacional entre os produtos.

## Mudancas de documentacao

Documentacao a atualizar como parte da implementacao:

- `docs/CI.md`
- `docs/PUBLISHING.md`
- `docs/ARCHITECTURE.md`
- `CHANGELOG.md` quando houver impacto visivel para mantenedores/usuarios

Os docs precisam passar a descrever claramente dois trilhos:

- release da extensao VS Code
- release do CLI Rust

## Alternativas consideradas

### Release unificado de extensao + CLI

Rejeitado porque impediria o CLI de avancar mais rapido que a extensao.

### Publicar o CLI apenas como asset de GitHub

Rejeitado porque nao entrega os canais oficiais de instalacao desejados (`crates.io` e `npm`) e piora a experiencia de instalacao/atualizacao.

### Pacote npm unico com download em `postinstall`

Rejeitado porque aumenta fragilidade de instalacao, dependencia de rede fora do registry e problemas em CI, cache corporativo e ambientes restritos.

## Resultado esperado

Ao final dessa migracao de release:

- o CLI tera release proprio por tag `rust-v...`
- stable e pre-release do CLI serao canais distintos por semver
- o CLI sera instalavel por `cargo install`, `npm install -g` e GitHub Release
- a extensao continuara independente e presa a um runtime pinado e validado
- usuarios avancados poderao apontar para outro executavel com aviso, sem bloqueio
- o desenho de distribuicao ficara alinhado ao padrao operacional usado pelo Codex
