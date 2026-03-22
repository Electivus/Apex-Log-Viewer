@description('Application Insights component name.')
param name string

@description('Azure region for the component.')
param location string

@description('Log Analytics workspace resource id.')
param workspaceResourceId string

@description('Environment tag value, for example prod or e2e.')
param environment string

@description('Common tags applied to the component.')
param tags object = {}

resource component 'Microsoft.Insights/components@2020-02-02' = {
  name: name
  location: location
  kind: 'web'
  tags: union(tags, {
    env: environment
    component: 'telemetry'
    'managed-by': 'bicep'
  })
  properties: {
    Application_Type: 'web'
    Flow_Type: 'Bluefield'
    WorkspaceResourceId: workspaceResourceId
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

output id string = component.id
output name string = component.name
output connectionString string = component.properties.ConnectionString
