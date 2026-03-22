@description('Action group resource name.')
param name string

@description('Global short name shown in alert notifications. Maximum 12 characters.')
@maxLength(12)
param shortName string

@description('Email receivers for the action group.')
param emailReceivers array = []

@description('Webhook receivers for the action group.')
param webhookReceivers array = []

@description('Common tags applied to the action group.')
param tags object = {}

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: name
  location: 'Global'
  tags: union(tags, {
    component: 'alerting'
    'managed-by': 'bicep'
  })
  properties: {
    enabled: true
    groupShortName: shortName
    emailReceivers: [for receiver in emailReceivers: {
      name: string(receiver.name)
      emailAddress: string(receiver.emailAddress)
      useCommonAlertSchema: bool(receiver.?useCommonAlertSchema ?? true)
    }]
    webhookReceivers: [for receiver in webhookReceivers: {
      name: string(receiver.name)
      serviceUri: string(receiver.serviceUri)
      useCommonAlertSchema: bool(receiver.?useCommonAlertSchema ?? true)
    }]
  }
}

output id string = actionGroup.id
