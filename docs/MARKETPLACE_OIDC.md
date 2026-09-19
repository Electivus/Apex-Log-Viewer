# Marketplace authentication

Release and nightly Marketplace jobs use GitHub OIDC to authenticate a dedicated Azure user-assigned managed identity, then call `vsce publish --azure-credential`. No client secret or long-lived Marketplace PAT is required. Open VSX retains its separate `OVSX_PAT` authentication.

```text
GitHub job + marketplace environment approval
  -> GitHub OIDC assertion
  -> Microsoft Entra ID managed identity
  -> short-lived Azure DevOps access token
  -> Marketplace publisher (Contributor)
```

## Configuration

| Setting               | Value                                                    |
| --------------------- | -------------------------------------------------------- |
| Azure resource group  | `rg-apex-log-viewer-publishing`                          |
| Managed identity      | `id-apex-log-viewer-marketplace`                         |
| Azure region          | `eastus`                                                 |
| Azure role            | Reader on the publishing resource group only             |
| Federated credential  | `github-marketplace`                                     |
| Issuer                | `https://token.actions.githubusercontent.com`            |
| Subject               | `repo:Electivus/Apex-Log-Viewer:environment:marketplace` |
| Audience              | `api://AzureADTokenExchange`                             |
| Marketplace publisher | `electivus`                                              |
| Marketplace role      | Contributor                                              |

The subject matches the repository's current default OIDC subject configuration (`use_immutable_subject: false`). In Azure's federated credential form, use **Other** and enter the exact subject above if the GitHub wizard generates a subject with immutable IDs. Changing the repository-wide subject format also affects existing telemetry and npm OIDC consumers and requires a separate coordinated migration.

Store these non-secret identifiers as **variables in the GitHub `marketplace` environment**:

| Variable                            | Source                               |
| ----------------------------------- | ------------------------------------ |
| `MARKETPLACE_AZURE_CLIENT_ID`       | Managed identity Client ID           |
| `MARKETPLACE_AZURE_TENANT_ID`       | Microsoft Entra tenant ID            |
| `MARKETPLACE_AZURE_SUBSCRIPTION_ID` | Subscription containing the identity |

Keep the existing environment reviewers. The environment name is part of the federated subject, so renaming it requires updating the Azure credential. These variables are separate from the telemetry identity's `AZURE_*` secrets.

## Recreate the Azure configuration

Run as an authorized Azure administrator with the intended subscription selected in Azure CLI. These commands create only the dedicated identity infrastructure:

```bash
az group create --name rg-apex-log-viewer-publishing --location eastus
az identity create --name id-apex-log-viewer-marketplace \
  --resource-group rg-apex-log-viewer-publishing --location eastus
az identity federated-credential create --name github-marketplace \
  --identity-name id-apex-log-viewer-marketplace \
  --resource-group rg-apex-log-viewer-publishing \
  --issuer https://token.actions.githubusercontent.com \
  --subject repo:Electivus/Apex-Log-Viewer:environment:marketplace \
  --audiences api://AzureADTokenExchange
publishing_principal=$(az identity show --name id-apex-log-viewer-marketplace \
  --resource-group rg-apex-log-viewer-publishing --query principalId --output tsv)
publishing_scope=$(az group show --name rg-apex-log-viewer-publishing --query id --output tsv)
az role assignment create --assignee-object-id "$publishing_principal" \
  --assignee-principal-type ServicePrincipal --role Reader --scope "$publishing_scope"
```

The Reader assignment lets Azure login discover the subscription without granting resource modification rights. Marketplace publishing permission comes from publisher membership, not Azure RBAC.

## Bootstrap and verify publisher access

1. Set the environment variables and create the federated credential.
2. Dispatch **Pre-release (nightly)** with `verify_marketplace_only=true` and approve its `marketplace` deployment. This mode skips all build, packaging, release creation, and publishing jobs.
3. Read the `id` from **Read Marketplace identity ID for publisher membership**. It comes from the Azure DevOps profile API as the managed identity. This is not its Azure resource path, Client ID, or Object ID. Initial access verification may fail until membership is added.
4. In [publisher management](https://marketplace.visualstudio.com/manage/publishers/electivus), open **Members**, add that ID, and select **Contributor**.
5. Rerun verification. `vsce verify-pat electivus --azure-credential` must succeed. Despite the command's historical name, it uses an Entra token. This checks publisher access without uploading a VSIX; confirm the Contributor role in Members because the command also accepts read-only membership.
6. Integrate the workflow migration, then remove the obsolete `VSCE_PAT` environment secret. Old workflow revisions still require their original authentication; rerunning one does not use the updated YAML.

```bash
gh workflow run prerelease.yml --repo Electivus/Apex-Log-Viewer \
  --ref main -f verify_marketplace_only=true
```

The verification job prints only the profile ID and display name, never access tokens. A successful check validates federation and publisher access; the next authorized release validates the actual upload.

## Reversal

To disable this identity's publishing access, remove its Contributor membership from the publisher and its `github-marketplace` federated credential. Remove the three environment variables when no workflow uses them. If restoring the previous PAT workflows is necessary, provision an authorized PAT separately; deleting a GitHub secret cannot be undone. Remove the dedicated Azure identity, Reader assignment, and resource group only after checking that they have no remaining consumers.

References: [VS Code secure automated publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace), [Azure login with OIDC](https://github.com/Azure/login#login-with-openid-connect-oidc-recommended).
