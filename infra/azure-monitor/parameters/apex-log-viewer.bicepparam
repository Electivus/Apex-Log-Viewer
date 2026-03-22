using '../main.bicep'

param location = 'eastus'
param workspaceName = 'law-apex-log-viewer-telemetry'
param prodAppInsightsName = 'appi-apex-log-viewer-telemetry-prod'
param e2eAppInsightsName = 'appi-apex-log-viewer-telemetry-e2e'

param deployWorkbook = true
param deployActionGroup = false
param deployAlerts = false

param tags = {
  app: 'apex-log-viewer'
  repo: 'Apex-Log-Viewer'
}
