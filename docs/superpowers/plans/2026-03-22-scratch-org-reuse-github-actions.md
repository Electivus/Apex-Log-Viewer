# Scratch Org Reuse (GitHub Actions E2E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reutilizar uma única scratch org entre execuções do workflow E2E no GitHub Actions, evitando conflitos via fila global e reautenticando por `sfdxAuthUrl` com rotação automática do secret quando a org for recriada.

**Architecture:** O workflow E2E passa a usar `concurrency` global (1 execução por vez), um alias fixo para scratch, login no começo via `sf org login sfdx-url` (secret com `sfdxAuthUrl`) e um passo no fim que extrai `sfdxAuthUrl` via `sf org display --verbose --json` e atualiza o secret via `gh secret set` usando um PAT.

**Tech Stack:** GitHub Actions (YAML), Salesforce CLI (`sf`), GitHub CLI (`gh`), Node.js (para parse seguro de JSON).

---

## File Structure (what changes where)

**Modify**
- `.github/workflows/e2e-playwright.yml:27` (concurrency global), `:74` (env e passos de login/rotação)
- `docs/CI.md:15` (documentar reuso de scratch e secrets)

**No changes expected**
- `test/e2e/utils/scratchOrg.ts` (já suporta reuso por alias; vamos controlar via env no workflow)

---

### Task 1: Serializar E2E globalmente (evitar conflito)

**Files:**
- Modify: `.github/workflows/e2e-playwright.yml:27-30`

- [ ] **Step 1: Ajustar `concurrency` para um grupo global**

Atualizar:

```yaml
concurrency:
  group: sf-e2e-scratch-global
  cancel-in-progress: false
```

Notas:
- `cancel-in-progress: false` garante fila (não cancela runs antigas).  
- Se vocês preferirem “sempre o último PR”, isso vira `true`, mas não faz parte deste spec.

- [ ] **Step 2: Verificar sintaxe YAML localmente**

Run (sanity only):
```bash
node -e "require('fs').readFileSync('.github/workflows/e2e-playwright.yml','utf8'); console.log('ok')"
```

Expected: imprime `ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/e2e-playwright.yml
git commit -m "ci(e2e): serialize scratch org usage" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Fixar alias da scratch e manter org entre runs

**Files:**
- Modify: `.github/workflows/e2e-playwright.yml:84-94`

- [ ] **Step 1: Fixar `SF_SCRATCH_ALIAS` do CI**

Trocar:

```yaml
SF_SCRATCH_ALIAS: ALV_E2E_Scratch_${{ github.run_id }}_${{ github.run_attempt }}
```

Para:

```yaml
SF_SCRATCH_ALIAS: ALV_E2E_SCRATCH_CI
```

- [ ] **Step 2: Garantir `SF_TEST_KEEP_ORG=1` em `pull_request`**

Substituir a lógica atual por algo explícito:

```yaml
SF_TEST_KEEP_ORG: ${{ github.event_name == 'workflow_dispatch' && (github.event.inputs.keep_scratch_org == 'false' && '' || '1') || '1' }}
```

Objetivo:
- `pull_request`: sempre keep (`'1'`)
- `workflow_dispatch`: respeitar input (default keep)

- [ ] **Step 3: (Opcional) Aumentar default de `scratch_duration_days`**

Se o DevHub permitir, considerar trocar default `1` para `7` (ou outro máximo permitido).  
Se não tiver certeza, manter como está e deixar operador escolher em `workflow_dispatch`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/e2e-playwright.yml
git commit -m "ci(e2e): reuse scratch org alias in CI" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Login best-effort na scratch via `sfdxAuthUrl` (runner efêmero)

**Files:**
- Modify: `.github/workflows/e2e-playwright.yml:55-74` (inserir step após instalar `@salesforce/cli`)

**Secrets (repo settings):**
- Add: `SF_SCRATCH_CI_SFDX_AUTH_URL` (conteúdo: `force://...` / `sfdxAuthUrl`)

- [ ] **Step 1: Inserir step de login antes de rodar Playwright**

Inserir após “Install Salesforce CLI”:

```yaml
      - name: Login to reusable scratch org (best-effort)
        if: ${{ secrets.SF_SCRATCH_CI_SFDX_AUTH_URL != '' }}
        continue-on-error: true
        shell: bash
        run: |
          set -euo pipefail
          tmp="$(mktemp)"
          printf '%s' "${SF_SCRATCH_CI_SFDX_AUTH_URL}" > "${tmp}"
          sf org login sfdx-url --sfdx-url-file "${tmp}" --alias "${SF_SCRATCH_ALIAS}"
          rm -f "${tmp}"
        env:
          SF_SCRATCH_CI_SFDX_AUTH_URL: ${{ secrets.SF_SCRATCH_CI_SFDX_AUTH_URL }}
          SF_SCRATCH_ALIAS: ALV_E2E_SCRATCH_CI
```

Racional:
- Login falha quando o secret está desatualizado/expirado; `continue-on-error` permite que o `ensureScratchOrg()` crie uma scratch nova.

- [ ] **Step 2: Validar que o workflow continua funcionando sem o secret**

Teste mental/checklist (não envolve rodar CI):
- Sem `SF_SCRATCH_CI_SFDX_AUTH_URL`, o step é pulado.
- `ensureScratchOrg()` tenta `sf org display` e, sem auth, vai criar a scratch (desde que `SF_DEVHUB_AUTH_URL` exista).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/e2e-playwright.yml
git commit -m "ci(e2e): login to reusable scratch org via sfdxAuthUrl" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Rotação automática do secret no mesmo run (self-healing)

**Files:**
- Modify: `.github/workflows/e2e-playwright.yml:95` (inserir step após “Run Playwright E2E” e antes de upload artifacts)

**Secrets (repo settings):**
- Add: `GH_SECRETS_ROTATOR_PAT` (fine-grained PAT com permissão mínima para editar Actions secrets)

**Important security boundary:**
- Este step deve rodar somente quando `GH_SECRETS_ROTATOR_PAT` estiver disponível (PR interno / workflow_dispatch).  
  Em forks, secrets não existem; o step deve ficar automaticamente desabilitado.

- [ ] **Step 1: Inserir step “Rotate scratch auth URL secret”**

Adicionar após “Run Playwright E2E”:

```yaml
      - name: Rotate scratch auth URL secret (post-run)
        if: ${{ secrets.GH_SECRETS_ROTATOR_PAT != '' }}
        shell: bash
        run: |
          set -euo pipefail
          auth_json="$(mktemp)"

          # IMPORTANT: do NOT print this JSON; it includes access tokens.
          sf org display --target-org "${SF_SCRATCH_ALIAS}" --verbose --json > "${auth_json}"

          # Extract sfdxAuthUrl without echoing it to logs; pass via stdin to gh.
          node -e '
            const fs = require("fs");
            const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
            const url = data && data.result && data.result.sfdxAuthUrl;
            if (!url) process.exit(2);
            process.stdout.write(url);
          ' "${auth_json}" | gh secret set SF_SCRATCH_CI_SFDX_AUTH_URL --app actions --body - --repo "${GITHUB_REPOSITORY}"

          rm -f "${auth_json}"
        env:
          GH_TOKEN: ${{ secrets.GH_SECRETS_ROTATOR_PAT }}
          SF_SCRATCH_ALIAS: ALV_E2E_SCRATCH_CI
```

Expected:
- Step termina com sucesso e log do `gh` indicando secret atualizado (sem imprimir o valor).

- [ ] **Step 2: Tornar a condição ainda mais explícita para forks (opcional, mas recomendado)**

Para reduzir ambiguidades, reforçar o `if`:

```yaml
if: ${{ secrets.GH_SECRETS_ROTATOR_PAT != '' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.fork == false) }}
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/e2e-playwright.yml
git commit -m "ci(e2e): rotate scratch sfdxAuthUrl secret after run" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Documentar o novo modelo de reuso no `docs/CI.md`

**Files:**
- Modify: `docs/CI.md:15`

- [ ] **Step 1: Atualizar a seção de CI para explicar reuso de scratch**

Adicionar uma subseção (sugestão de conteúdo):

```md
## E2E scratch org reuse (GitHub Actions)

O workflow `.github/workflows/e2e-playwright.yml` reutiliza uma scratch org única no CI para evitar esgotar a quota diária de criação.

Secrets necessários:
- `SF_DEVHUB_AUTH_URL`: login no Dev Hub (criar/recriar scratch quando necessário)
- `SF_SCRATCH_CI_SFDX_AUTH_URL`: `sfdxAuthUrl` para login não-interativo na scratch reutilizável
- `GH_SECRETS_ROTATOR_PAT`: (internal PR / workflow_dispatch) atualiza `SF_SCRATCH_CI_SFDX_AUTH_URL` quando a scratch é recriada
```

E mencionar:
- existe fila global (`concurrency`) para impedir conflito
- a scratch é mantida (`SF_TEST_KEEP_ORG=1`) e limpa/seed nos testes

- [ ] **Step 2: Commit**

```bash
git add docs/CI.md
git commit -m "docs(ci): document scratch org reuse and required secrets" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## End-to-end verification (post-merge / in CI)

- [ ] **Step: Trigger `workflow_dispatch` once**
  - Expected: primeira execução cria scratch (se needed) e atualiza o secret no final.
- [ ] **Step: Trigger novamente**
  - Expected: login via secret funciona e `ensureScratchOrg()` reusa (sem criar).
- [ ] **Step: Confirmar não-concorrência**
  - Disparar 2 runs e confirmar que o segundo fica “Queued” até o primeiro finalizar.
