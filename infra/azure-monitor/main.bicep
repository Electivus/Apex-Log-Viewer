targetScope = 'resourceGroup'

@description('Azure region used for workspace, Application Insights, alerts, and workbook resources.')
param location string

@description('Log Analytics workspace name.')
param workspaceName string

@description('Retention for the shared Log Analytics workspace in days.')
@minValue(30)
param workspaceRetentionInDays int = 30

@description('Production Application Insights component name.')
param prodAppInsightsName string

@description('Dedicated E2E Application Insights component name.')
param e2eAppInsightsName string

@description('Whether to deploy a workbook in the shared workspace.')
param deployWorkbook bool = true

@description('Workbook display name.')
param workbookDisplayName string = 'Apex Log Viewer Telemetry'

@description('Whether to create a dedicated action group from this template.')
param deployActionGroup bool = false

@description('Action group resource name.')
param actionGroupName string = 'ag-apex-log-viewer-telemetry'

@description('Action group short name. Maximum 12 characters.')
@maxLength(12)
param actionGroupShortName string = 'ALVTelem'

@description('Optional email receivers for the dedicated action group.')
param actionGroupEmailReceivers array = []

@description('Optional webhook receivers for the dedicated action group.')
param actionGroupWebhookReceivers array = []

@description('Existing action group resource id used by scheduled query alerts when deployActionGroup is false.')
param existingActionGroupResourceId string = ''

@description('Whether to deploy scheduled query alerts.')
param deployAlerts bool = false

@description('Common tags applied to all Azure Monitor resources created by this template.')
param tags object = {
  app: 'apex-log-viewer'
  repo: 'Apex-Log-Viewer'
}

var normalizedTags = union(tags, {
  component: 'telemetry'
  'managed-by': 'bicep'
})
var workbookContent = loadTextContent('workbook.json')
var shouldCreateActionGroup = deployActionGroup && (length(actionGroupEmailReceivers) > 0 || length(actionGroupWebhookReceivers) > 0)

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: normalizedTags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: workspaceRetentionInDays
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

module prodComponent 'modules/app-insights.bicep' = {
  name: 'prod-app-insights'
  params: {
    name: prodAppInsightsName
    location: location
    workspaceResourceId: workspace.id
    environment: 'prod'
    tags: tags
  }
}

module e2eComponent 'modules/app-insights.bicep' = {
  name: 'e2e-app-insights'
  params: {
    name: e2eAppInsightsName
    location: location
    workspaceResourceId: workspace.id
    environment: 'e2e'
    tags: tags
  }
}

module actionGroup 'modules/action-group.bicep' = if (shouldCreateActionGroup) {
  name: 'monitor-action-group'
  params: {
    name: actionGroupName
    shortName: actionGroupShortName
    emailReceivers: actionGroupEmailReceivers
    webhookReceivers: actionGroupWebhookReceivers
    tags: tags
  }
}

var prodComponentResourceId = resourceId('Microsoft.Insights/components', prodAppInsightsName)
var managedActionGroupResourceId = resourceId('Microsoft.Insights/actionGroups', actionGroupName)
var actionGroupIds = !empty(existingActionGroupResourceId)
  ? [
      existingActionGroupResourceId
    ]
  : (shouldCreateActionGroup
      ? [
          managedActionGroupResourceId
        ]
      : [])
var telemetryNoDataQuery = 'AppEvents\n| where TimeGenerated > ago(24h)\n| where _ResourceId =~ "${toLower(prodComponentResourceId)}"\n| where Name startswith "electivus.apex-log-viewer/"\n| summarize events = count()\n| where events == 0'
var cliDiscoveryQuery = 'AppEvents\n| where TimeGenerated > ago(1h)\n| where _ResourceId =~ "${toLower(prodComponentResourceId)}"\n| where Name in ("electivus.apex-log-viewer/cli.exec", "electivus.apex-log-viewer/cli.getOrgAuth")\n| extend props = parse_json(Properties)\n| where tostring(props["code"]) in ("ENOENT", "CLI_NOT_FOUND")\n| summarize failures = count()\n| where failures >= 3'
var cliTimeoutQuery = 'AppEvents\n| where TimeGenerated > ago(1h)\n| where _ResourceId =~ "${toLower(prodComponentResourceId)}"\n| where Name in ("electivus.apex-log-viewer/cli.exec", "electivus.apex-log-viewer/cli.getOrgAuth")\n| extend props = parse_json(Properties)\n| where tostring(props["code"]) == "ETIMEDOUT"\n| summarize failures = count()\n| where failures >= 5'
var refreshFailureQuery = 'AppEvents\n| where TimeGenerated > ago(1h)\n| where _ResourceId =~ "${toLower(prodComponentResourceId)}"\n| where Name == "electivus.apex-log-viewer/logs.refresh"\n| extend props = parse_json(Properties)\n| summarize total = count(), errors = countif(tostring(props["outcome"]) == "error")\n| extend errorRate = iff(total == 0, 0.0, 100.0 * todouble(errors) / todouble(total))\n| where total >= 20 and errorRate >= 15'
var debugLevelsQuery = 'AppEvents\n| where TimeGenerated > ago(2h)\n| where _ResourceId =~ "${toLower(prodComponentResourceId)}"\n| where Name == "electivus.apex-log-viewer/debugLevels.load"\n| extend props = parse_json(Properties), measurements = parse_json(Measurements)\n| extend outcome = tostring(props["outcome"]), durationMs = todouble(measurements["durationMs"])\n| summarize total = count(), errors = countif(outcome == "error"), p95 = percentile(durationMs, 95)\n| extend errorRate = iff(total == 0, 0.0, 100.0 * todouble(errors) / todouble(total))\n| where total >= 5 and (errorRate >= 50 or p95 >= 60000)'

resource workbook 'Microsoft.Insights/workbooks@2023-06-01' = if (deployWorkbook) {
  name: guid(resourceGroup().id, workspace.id, workbookDisplayName)
  location: location
  kind: 'shared'
  tags: union(tags, {
    component: 'workbook'
    'managed-by': 'bicep'
  })
  properties: {
    displayName: workbookDisplayName
    category: 'workbook'
    sourceId: workspace.id
    version: '1.0'
    serializedData: workbookContent
  }
}

module telemetryNoDataAlert 'modules/scheduled-query-rule.bicep' = if (deployAlerts) {
  name: 'telemetry-no-data-alert'
  params: {
    name: 'alv-telemetry-no-data'
    location: location
    workspaceResourceId: workspace.id
    ruleDescription: 'No Apex Log Viewer telemetry events were observed in the last 24 hours.'
    actionGroupIds: actionGroupIds
    severity: 2
    evaluationFrequency: 'PT15M'
    windowSize: 'PT24H'
    tags: tags
    query: telemetryNoDataQuery
  }
}

module cliDiscoveryAlert 'modules/scheduled-query-rule.bicep' = if (deployAlerts) {
  name: 'cli-discovery-alert'
  params: {
    name: 'alv-cli-discovery-regression'
    location: location
    workspaceResourceId: workspace.id
    ruleDescription: 'The extension is failing to discover the Salesforce CLI in production.'
    actionGroupIds: actionGroupIds
    severity: 2
    evaluationFrequency: 'PT5M'
    windowSize: 'PT1H'
    tags: tags
    query: cliDiscoveryQuery
  }
}

module cliTimeoutAlert 'modules/scheduled-query-rule.bicep' = if (deployAlerts) {
  name: 'cli-timeout-alert'
  params: {
    name: 'alv-cli-timeout-spike'
    location: location
    workspaceResourceId: workspace.id
    ruleDescription: 'The extension is seeing a spike in Salesforce CLI timeout errors.'
    actionGroupIds: actionGroupIds
    severity: 2
    evaluationFrequency: 'PT5M'
    windowSize: 'PT1H'
    tags: tags
    query: cliTimeoutQuery
  }
}

module refreshFailureAlert 'modules/scheduled-query-rule.bicep' = if (deployAlerts) {
  name: 'refresh-failure-alert'
  params: {
    name: 'alv-refresh-failure-rate-spike'
    location: location
    workspaceResourceId: workspace.id
    ruleDescription: 'The main logs.refresh workflow is failing above its normal baseline.'
    actionGroupIds: actionGroupIds
    severity: 2
    evaluationFrequency: 'PT5M'
    windowSize: 'PT1H'
    tags: tags
    query: refreshFailureQuery
  }
}

module debugLevelsAlert 'modules/scheduled-query-rule.bicep' = if (deployAlerts) {
  name: 'debug-levels-alert'
  params: {
    name: 'alv-debug-levels-degraded'
    location: location
    workspaceResourceId: workspace.id
    ruleDescription: 'debugLevels.load is either failing frequently or becoming very slow.'
    actionGroupIds: actionGroupIds
    severity: 2
    evaluationFrequency: 'PT15M'
    windowSize: 'PT2H'
    tags: tags
    query: debugLevelsQuery
  }
}

output workspaceId string = workspace.id
output prodAppInsightsId string = prodComponent.outputs.id
output prodConnectionString string = prodComponent.outputs.connectionString
output e2eAppInsightsId string = e2eComponent.outputs.id
output e2eConnectionString string = e2eComponent.outputs.connectionString
output workbookResourceId string = deployWorkbook ? workbook.id : ''
output actionGroupResourceIds array = actionGroupIds
