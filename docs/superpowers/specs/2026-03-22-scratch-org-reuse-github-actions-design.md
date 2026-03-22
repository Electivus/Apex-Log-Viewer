# Scratch org reutilizável no GitHub Actions (E2E Playwright)

**Data:** 2026-03-22  
**Status:** Aprovado para planejamento (pré-implementação)  
**Contexto do repo:** `Apex-Log-Viewer` (workflow E2E real org via scratch)

## Problema

No ecossistema Salesforce, **a criação diária de Scratch Orgs é limitada** (quota do Dev Hub). O workflow de E2E no GitHub Actions precisa validar os testes Playwright contra uma org real, mas:

- Criar uma scratch org nova a cada execução evita conflito, porém **consome quota** e pode parar o pipeline quando a quota diária acaba.
- Reutilizar a mesma scratch org reduz consumo de quota, porém precisa evitar **conflito/concor­rên­cia** (duas execuções usando a mesma org ao mesmo tempo) e precisa funcionar em runners **efêmeros** (GitHub-hosted), que não guardam estado entre runs.

## Situação atual (baseline)

Arquivos relevantes no repo:

- Workflow E2E: `.github/workflows/e2e-playwright.yml`
  - Hoje usa alias único por run: `SF_SCRATCH_ALIAS: ALV_E2E_Scratch_${{ github.run_id }}_${{ github.run_attempt }}`
  - Hoje tende a deletar a scratch no fim para `pull_request` (via `SF_TEST_KEEP_ORG` vazio).
- Provisionamento/reuso de scratch na suíte E2E: `test/e2e/utils/scratchOrg.ts`
  - Já existe lógica de reuso quando o alias aponta para uma scratch válida (`isReusableScratchOrg(...)`).
  - Em CI, esse reuso só acontece se a execução conseguir **autenticar no mesmo alias** em todo run.

## Objetivos

1. **Reutilizar scratch org entre execuções do GitHub Actions** para reduzir consumo de quota diária.
2. **Evitar conflitos** ao garantir que apenas uma execução E2E use a scratch por vez.
3. **Auto-healing**: recriar scratch quando estiver inválida (expirada/deletada/quebrada) e voltar a funcionar sem intervenção frequente.
4. Manter o fluxo compatível com o utilitário existente (`ensureScratchOrg()`), mudando o mínimo necessário.

## Não-objetivos (por enquanto)

- Pool com N scratch orgs e alocação paralela (leasing/locks por org).
- Paralelismo de E2E (várias execuções simultâneas no repo).
- Persistir segredos em caches/artifacts (não recomendado para credenciais).

## Restrições / Premissas

- **Apenas 1 execução de E2E por vez no repositório inteiro** (aceito como requisito).
- Runner GitHub-hosted é **stateless**: não dá pra depender de `~/.sf` / `~/.sfdx` persistindo.
- Credenciais precisam ser não-interativas:
  - A forma suportada/recomendada pela Salesforce para CI é via **SFDX Authorization URL (`sfdxAuthUrl`)**.
  - Doc oficial: “Authorize an Org Using Its SFDX Authorization URL”.  
    Exemplo: `sf org display --verbose --json > authFile.json` (inclui `sfdxAuthUrl`) e depois `sf org login sfdx-url --sfdx-url-file authFile.json`.

## Abordagens consideradas

### A) Singleton scratch + fila global (GitHub Actions concurrency) + `sfdxAuthUrl` persistido (RECOMENDADA)

- Uma scratch “oficial do CI”, com alias fixo (ex.: `ALV_E2E_SCRATCH_CI`)
- Workflows E2E enfileirados globalmente (uma execução por vez)
- Antes dos testes: reautentica na scratch via `sf org login sfdx-url` usando `sfdxAuthUrl` persistido (secret)
- Durante os testes: suíte faz limpeza/seed conforme já faz hoje
- Se a org estiver inválida: `ensureScratchOrg()` recria (usando DevHub auth já existente)
- Após recriar: sistema atualiza o secret do `sfdxAuthUrl` (auto-rotação) para os próximos runs

Prós:
- Reduz drasticamente consumo de quota diária.
- Elimina conflito por design (fila global).
- Mantém comportamento previsível e depuração simples.

Contras:
- Precisa de estratégia de rotação segura do `sfdxAuthUrl` (ver abaixo).

### B) Self-hosted runner fixo

Prós:
- Estado local do CLI persiste; reuso fica trivial.

Contras:
- Infra para manter, atualizar e proteger.

### C) Pool real (N scratch orgs) + lease/lock

Contras:
- Complexidade não necessária dado requisito de serialização (1 execução por vez).

## Design aprovado (Abordagem A)

### 1) Fila global no GitHub Actions (evita conflito)

No workflow `.github/workflows/e2e-playwright.yml`, configurar `concurrency` para:

- `group`: valor constante (ex.: `sf-e2e-scratch-global`)
- `cancel-in-progress: false` (enfileirar em vez de cancelar)

Resultado: nenhuma run E2E concorrente usa a mesma org simultaneamente.

### 2) Alias fixo para a scratch do CI

No step “Run Playwright E2E”, usar:

- `SF_SCRATCH_ALIAS: ALV_E2E_SCRATCH_CI`

Isso permite que o código existente (`ensureScratchOrg()`) reconheça e reutilize a org quando ela estiver ativa.

### 3) Não deletar a scratch no fim do job (reuso)

Garantir `SF_TEST_KEEP_ORG=1` no CI para que `ensureScratchOrg()` não execute `sf org delete scratch` no cleanup.

Observação: deleção continua possível via um modo manual/maintenance (ex.: `workflow_dispatch` “force reset”).

### 4) Reautenticação no início do job (runner efêmero)

Adicionar um step no job para autenticar na scratch com `sfdxAuthUrl`:

1. Materializar um arquivo `authFile.json` (ou `sfdxAuthUrl.txt`) a partir de um GitHub Secret
2. Rodar `sf org login sfdx-url --sfdx-url-file <arquivo> --alias ALV_E2E_SCRATCH_CI`

Depois disso, `sf org display -o ALV_E2E_SCRATCH_CI` funciona no runner, habilitando o reuso no `ensureScratchOrg()`.

### 5) Auto-rotação do `sfdxAuthUrl` quando recriar a scratch (modo “self-healing”)

Quando `ensureScratchOrg()` precisar criar uma scratch nova (org inválida), o sistema deve:

- Executar `sf org display --target-org ALV_E2E_SCRATCH_CI --verbose --json`
- Extrair o campo `sfdxAuthUrl`
- Atualizar o GitHub Secret que guarda o `sfdxAuthUrl`

#### Modelo adotado (explícito): rotação no mesmo run que recriar

Para garantir que o reuso funcione em runners efêmeros (GitHub-hosted), **a rotação precisa acontecer imediatamente no mesmo run** em que a scratch foi recriada. Caso contrário, a execução seguinte não tem como “descobrir” e autenticar automaticamente na scratch recém-criada.

Portanto, este design assume:

- Se a scratch foi recriada, o próprio workflow E2E atualiza `SF_SCRATCH_CI_SFDX_AUTH_URL` no final do job (ou imediatamente após criar).
- Isso requer um token (PAT fine-grained) com permissão mínima para atualizar secrets do repositório.

> Nota de segurança (trade-off assumido): esse modelo expõe o token de rotação ao job E2E em execuções `pull_request` internas (não-fork). Se isso for considerado arriscado para o seu contexto, um modelo alternativo é mover a criação/rotação para um workflow de maintenance (`workflow_dispatch`/`schedule`) e fazer o E2E falhar com instruções claras quando a org estiver inválida — mas isso deixa de ser “self-healing” no PR.

## Configuração de Secrets (proposta)

Obrigatórios:
- `SF_DEVHUB_AUTH_URL` (já existe): login no Dev Hub em CI
- `SF_SCRATCH_CI_SFDX_AUTH_URL` **ou** `SF_SCRATCH_CI_AUTH_FILE_JSON`: credencial para login na scratch reutilizável

Para auto-rotação (modelo adotado):
- `GH_SECRETS_ROTATOR_PAT`: token (PAT fine-grained) com permissão mínima para **atualizar secrets do repositório**

## Fluxo de execução (end-to-end)

1. Job E2E inicia (fila global garante exclusividade).
2. `sf` CLI instalado.
3. Login no DevHub via `SF_DEVHUB_AUTH_URL` (já suportado por `ensureScratchOrg()`).
4. Login na scratch via `sfdxAuthUrl` (secret) para reuso.
5. `ensureScratchOrg()`:
   - Se scratch válida: reusa.
   - Se stale/ausente: recria.
6. Suíte E2E faz limpeza/seed/validação.
7. Cleanup:
   - Mantém scratch (reuso).
8. Se scratch foi recriada:
   - O próprio workflow E2E atualiza `SF_SCRATCH_CI_SFDX_AUTH_URL` no mesmo run.

## Falhas esperadas e comportamento

- **Secret do `sfdxAuthUrl` inválido/expirado**:
  - Login na scratch falha; `ensureScratchOrg()` recria usando DevHub auth; o workflow E2E rota o secret no mesmo run.
- **Quota diária estourada**:
  - Criação falha; pipeline falha com erro explícito (sem workaround automático).
- **Scratch “meio pronta” / interstitial**:
  - `ensureScratchOrg()` já faz polling de readiness (Tooling API) antes de prosseguir.

## Observabilidade / Debug

Recomendações:
- Emitir logs “de alto nível” (sem tokens) no workflow: “reused vs created”.
- Nunca imprimir `sfdxAuthUrl` em logs (treat as secret).

## Plano de rollout (alto nível)

1. Implementar fila global + alias fixo + keep org no workflow E2E.
2. Implementar step de login por `sfdxAuthUrl` no CI.
3. Implementar step de rotação do secret (PAT) quando a scratch for recriada.
4. Executar 2–3 runs seguidas em PRs para validar reuso (sem criação diária).
5. (Opcional) Adicionar um workflow de maintenance apenas para “force reset”/recovery manual (não faz parte do caminho primário).
