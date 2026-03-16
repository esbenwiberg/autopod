@description('Azure region')
param location string

@description('Environment name')
param environment string

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'autopod-${environment}-logs'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

output workspaceId string = workspace.properties.customerId
output sharedKey string = workspace.listKeys().primarySharedKey
