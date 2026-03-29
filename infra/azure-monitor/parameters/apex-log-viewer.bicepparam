using '../main.bicep'

param location = 'eastus'
param workspaceName = 'law-apex-log-viewer-telemetry'
param workspaceRetentionInDays = 90
param prodAppInsightsName = 'appi-apex-log-viewer-telemetry-prod'
param e2eAppInsightsName = 'appi-apex-log-viewer-telemetry-e2e'

param deployWorkbook = true
param deployActionGroup = false
param deployAlerts = false

param tags = {
  app: 'apex-log-viewer'
  env: 'prod'
  repo: 'Apex-Log-Viewer'
}
