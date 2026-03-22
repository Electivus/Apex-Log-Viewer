@description('Scheduled query rule name.')
param name string

@description('Azure region for the rule.')
param location string

@description('Rule description.')
param ruleDescription string

@description('Workspace resource id used as the alert scope.')
param workspaceResourceId string

@description('KQL query that returns one or more rows when the alert should fire.')
param query string

@description('Action group resource ids invoked when the alert fires.')
param actionGroupIds array

@description('Severity from 0 (critical) to 4 (verbose).')
@minValue(0)
@maxValue(4)
param severity int = 2

@description('Frequency used to evaluate the rule, for example PT5M.')
param evaluationFrequency string = 'PT5M'

@description('Window size used by the rule, for example PT1H.')
param windowSize string = 'PT1H'

@description('Whether Azure should auto-resolve the alert.')
param autoMitigate bool = true

@description('Whether the rule is enabled.')
param enabled bool = true

@description('Additional tags applied to the rule.')
param tags object = {}

resource rule 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = {
  name: name
  location: location
  tags: union(tags, {
    component: 'alerting'
    'managed-by': 'bicep'
  })
  properties: {
    description: ruleDescription
    enabled: enabled
    severity: severity
    scopes: [
      workspaceResourceId
    ]
    evaluationFrequency: evaluationFrequency
    windowSize: windowSize
    autoMitigate: autoMitigate
    criteria: {
      allOf: [
        {
          query: query
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: actionGroupIds
      customProperties: {}
    }
    targetResourceTypes: [
      'Microsoft.OperationalInsights/workspaces'
    ]
  }
}
