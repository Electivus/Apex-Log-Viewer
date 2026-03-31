# CLI Rica de Logs com Sync Incremental Local-First

**Data:** 2026-03-30  
**Status:** Aprovado para planejamento (pre-implementacao)  
**Contexto do repo:** `Apex-Log-Viewer` (arquitetura compartilhada entre extensao VS Code, runtime Rust e CLI proprio em evolucao)

## Problema

O repositorio ja contem um binario Rust (`apex-log-viewer`) e um runtime compartilhado consumido pela extensao VS Code. Porem, a superficie humana do CLI ainda e minima:

- o binario atual basicamente so suporta `app-server --stdio`
- nao existe uma CLI rica voltada para humanos e agentes de IA
- nao existe um fluxo local-first para sincronizar logs novos antes de analisa-los
- o layout atual de `apexlogs/` foi suficiente para o inicio, mas e raso para sync incremental, busca local, triage e automacao mais pesada

Isso conflita com o objetivo do produto:

1. entregar valor adicional ao que o `sf` CLI ja faz por padrao
2. permitir que humanos e agentes trabalhem localmente sobre os logs sincronizados
3. manter a arquitetura compartilhada entre CLI, runtime e extensao sem obrigar as superficies a serem identicas
4. preservar contratos locais estaveis para automacao

## Decisoes aprovadas

As decisoes abaixo foram aprovadas durante o brainstorming e fazem parte do design validado:

- A primeira fatia da CLI rica sera centrada em **logs**.
- O primeiro fluxo prioritario e **sincronizar logs novos para analise local**.
- O comando principal inicial sera **`apex-log-viewer logs sync`**.
- O sync sera **incremental por org**, com estado local persistido.
- O comportamento padrao usara a org default autenticada no `sf`, com override por **`--target-org`**.
- O comando de sync **baixa o corpo completo** dos logs novos para o espelho local.
- A saida padrao sera **humana e resumida**, com **`--json`** opcional para automacao.
- As flags da CLI devem seguir, quando fizer sentido, o estilo familiar do `sf`, especialmente `--target-org`.
- A arquitetura sera **compartilhada no runtime/core**, mas a **CLI sera a primeira superficie consumidora** dessa nova capacidade.
- A extensao **nao** deve passar a depender de shelling out para comandos humanos da CLI.
- O layout local de `apexlogs/` pode e deve evoluir agora, desde que a transicao seja **compativel** com o formato legado.
- O novo layout canonico sera **org-first com subpastas por data**, por ser melhor para agentes de IA e para sync incremental.

## Objetivos

1. Introduzir uma CLI rica e usavel por humanos e agentes de IA.
2. Entregar um fluxo local-first de sync e busca em logs.
3. Criar um layout local de `apexlogs/` mais estruturado e previsivel.
4. Implementar a capacidade como primitive compartilhada no runtime/core.
5. Preservar compatibilidade de leitura com o layout legado durante a transicao.
6. Manter `app-server --stdio` sem regressao.

## Nao-objetivos

- Cobrir toda a superficie futura do CLI nesta primeira entrega.
- Migrar automaticamente todos os logs legados para o novo layout.
- Fazer a extensao depender imediatamente do novo estado incremental.
- Implementar `tail`, `debug-flags` ou uma superficie completa de triage neste primeiro corte.
- Reescrever a UX da extensao para seguir exatamente a CLI.

## Principio arquitetural

O repo deve tratar extensao VS Code e CLI standalone como **superficies diferentes sobre uma arquitetura compartilhada**, nao como copias uma da outra.

Isso significa:

- novas capacidades reutilizaveis devem nascer em `alv-core` e nos contratos do runtime/app-server quando fizer sentido
- a CLI pode ser a primeira consumidora de uma capacidade compartilhada
- a extensao pode adotar a mesma primitive depois, sem regressao e sem depender de comandos humanos da CLI

No caso de logs, a capacidade compartilhada sera:

- layout local de `apexlogs/`
- estado incremental de sync
- resolucao de paths e metadados por org
- regras de sync
- leitura local para busca e triage

## Layout local canonico

O layout local canonico passa a ser:

```text
apexlogs/
  .alv/
    version.json
    sync-state.json
  orgs/
    <safe-target-org>/
      org.json
      logs/
        2026-03-30/
          07L000000000003AA.log
          07L000000000004AA.log
```

### Regras do layout

- `apexlogs/` continua sendo a raiz compartilhada.
- `apexlogs/.alv/version.json` registra a versao do layout local.
- `apexlogs/.alv/sync-state.json` guarda o checkpoint incremental global, com entradas por org.
- `apexlogs/orgs/<safe-target-org>/org.json` guarda metadados resolvidos da org.
- Os arquivos `.log` ficam em `apexlogs/orgs/<safe-target-org>/logs/<YYYY-MM-DD>/<logId>.log`.

### Motivacao do layout org-first

Esse desenho foi escolhido por ser melhor para uso por agentes de IA:

- o ponto de entrada natural costuma ser "analise a org X", nao "analise o dia Y"
- o sync incremental e naturalmente modelado por org
- a busca local fica menos sujeita a misturar contextos de orgs diferentes
- os caminhos ficam mais previsiveis para automacao

## Compatibilidade de transicao

O layout atual legado em `apexlogs/` no formato flat continua valido durante a transicao:

```text
apexlogs/
  <safeUser>_<logId>.log
```

### Fase 1: leitura dual

- runtime/core procuram primeiro no layout novo
- se nao encontrarem, fazem fallback para o formato legado flat
- `search`, `triage`, `status` e utilitarios de cache precisam entender os dois formatos

### Fase 2: escrita no layout novo

- `logs sync` escreve no layout novo desde o primeiro corte
- logs legados continuam pesquisaveis
- nenhuma migracao automatica e obrigatoria nesta fase

## Estado incremental

O checkpoint incremental fica em:

```text
apexlogs/.alv/sync-state.json
```

Shape inicial proposto:

```json
{
  "version": 1,
  "orgs": {
    "default@example.com": {
      "targetOrg": "default@example.com",
      "safeTargetOrg": "default@example.com",
      "orgDir": "apexlogs/orgs/default@example.com",
      "lastSyncStartedAt": "2026-03-30T18:40:00.000Z",
      "lastSyncCompletedAt": "2026-03-30T18:40:04.000Z",
      "lastSyncedLogId": "07L000000000003AA",
      "lastSyncedStartTime": "2026-03-30T18:39:58.000Z",
      "downloadedCount": 3,
      "cachedCount": 12,
      "lastError": null
    }
  }
}
```

### Regras do checkpoint

- o checkpoint e por org resolvida de fato
- o estado so avanca quando a sync termina com sucesso
- se houver cancelamento ou falha parcial, os arquivos baixados permanecem validos, mas o checkpoint nao avanca
- o state file deve ser estavel e legivel por automacao

## Superficie inicial da CLI

Primeiro corte:

```bash
apex-log-viewer logs sync [--target-org <org>] [--json] [--force-full]
apex-log-viewer logs status [--target-org <org>] [--json]
apex-log-viewer logs search <query> [--target-org <org>] [--json]
apex-log-viewer app-server --stdio
```

### Regras gerais

- `app-server --stdio` continua funcionando sem regressao
- a CLI usa parser real, preferencialmente `clap`
- a saida padrao e humana
- `--json` expande a mesma operacao com resultado estruturado para agentes

## Comando `logs sync`

`logs sync` e o centro do primeiro fluxo de uso.

### Semantica

- resolve a org efetiva usando a default do `sf` por padrao
- aceita override por `--target-org`
- lista logs remotos em ordem decrescente de recencia
- detecta o delta incremental com base no checkpoint e no espelho local
- baixa os corpos completos dos logs novos
- grava os arquivos no layout novo
- promove o checkpoint apenas em execucao totalmente bem-sucedida

### Regras operacionais

- o comando nao deve rebaixar logs que ja existem localmente
- `--force-full` ignora o checkpoint, mas ainda evita regravar logs ja presentes
- arquivos baixados com sucesso continuam validos mesmo se a sync falhar depois

### Modelo de resultado

Estados operacionais:

- `success`: sync completa e checkpoint promovido
- `partial`: houve materializacao util, mas checkpoint nao foi promovido
- `cancelled`: operacao interrompida; arquivos parciais permanecem
- `error`: falha sem resultado util

Exit codes recomendados:

- `0` para `success`
- `2` para `partial`
- `130` para `cancelled`
- `1` para `error`

Exemplo de saida humana:

```text
Synced Apex logs for default@example.com
New logs downloaded: 3
Already cached: 12
Last synced log: 07L000000000003AA
State file: apexlogs/.alv/sync-state.json
```

Exemplo de saida humana parcial:

```text
Sync finished with partial results for default@example.com
Downloaded: 5
Already cached: 12
Failed: 1
Checkpoint not advanced
State file: apexlogs/.alv/sync-state.json
```

## Comando `logs status`

`logs status` e o comando de inspecao rapida do espelho local.

Deve expor:

- org resolvida
- path de `apexlogs/`
- path do state file
- timestamp da ultima sync completa
- ultimo log do checkpoint
- quantidade de `.log` locais detectados para a org

`logs status` le exclusivamente o estado local e nao faz fetch remoto implicito.

## Comando `logs search`

`logs search` e explicitamente **local-first**.

### Semantica

- pesquisa apenas nos `.log` ja materializados localmente
- nao dispara fetch remoto implicito
- procura por padrao no universo da org resolvida
- retorna ids de logs com match e snippets curtos

Exemplo de fluxo:

```bash
apex-log-viewer logs sync --target-org my-org
apex-log-viewer logs search "System.NullPointerException" --target-org my-org
```

Exemplo de JSON:

```json
{
  "targetOrg": "default@example.com",
  "query": "NullPointerException",
  "matches": [
    {
      "logId": "07L000000000003AA",
      "snippet": "...FATAL_ERROR|System.NullPointerException: Attempt to de-reference..."
    }
  ],
  "searchedLogCount": 18
}
```

## Estrutura interna recomendada

### `alv-core`

- `logs.rs`: integracao remota com `sf` para listagem e download
- `search.rs`: busca local-first em cima do storage compartilhado
- `triage.rs`: leitura local com suporte ao layout novo e ao legado
- novo modulo de storage local, por exemplo `log_store.rs`:
  - resolve `apexlogs/`
  - conhece layout novo e legado
  - resolve paths por org/data/log id
  - le/escreve `version.json`, `sync-state.json` e `org.json`
- novo modulo de sync, por exemplo `logs_sync.rs`:
  - resolve org
  - lista logs remotos
  - calcula delta
  - baixa corpos novos
  - promove checkpoint ou retorna resultado parcial

### `alv-cli`

- sai do `main.rs` minimo atual para um parser com subcommands
- preserva `app-server --stdio`
- expande a superficie humana com `logs sync`, `logs status` e `logs search`

## Ordem de implementacao recomendada

1. Introduzir parser de CLI rica no `alv-cli`, preservando `app-server --stdio`.
2. Criar a camada de storage compartilhada no `alv-core`.
3. Implementar `logs sync` em cima dessa camada.
4. Adaptar `search` e `triage` para ler do storage compartilhado.
5. Expor `logs status`.
6. Expor `logs search`.
7. Cobrir com testes de unidade e smoke.
8. Avaliar numa fase seguinte se a extensao passa a consumir a mesma primitive de sync.

## Testes mandatarios desta fase

- `logs sync` cria a estrutura local quando necessario
- `logs sync` respeita o layout novo
- `logs sync` nao rebaixa logs ja presentes
- `logs sync` nao promove checkpoint em caso parcial ou cancelado
- `logs status` interpreta corretamente o state file e os arquivos locais
- `logs search` so pesquisa localmente e nao faz fetch remoto implicito
- `app-server --stdio` continua funcionando
- leitura do layout legado continua operante durante a transicao

## Recorte exato da primeira entrega

Incluido no primeiro corte:

- parser de CLI rica com `clap`
- `logs sync`
- `logs status`
- `logs search`
- layout local org-first com subpastas por data
- `sync-state.json` e `version.json`
- leitura compativel do layout legado
- manutencao de `app-server --stdio`

Fora deste primeiro corte:

- migracao automatica de logs legados
- `logs triage` como subcommand de usuario
- `tail`
- `debug-flags`
- mudancas obrigatorias na UX da extensao

## Resumo da recomendacao

O melhor primeiro passo para a CLI rica e transformar `apex-log-viewer` em uma superficie local-first para sync e analise de logs, com:

- comandos `logs sync`, `logs status` e `logs search`
- flags familiares ao `sf`
- capacidade compartilhada no runtime/core
- layout `apexlogs/` org-first pensado para humanos e agentes
- transicao compativel com o layout flat legado
