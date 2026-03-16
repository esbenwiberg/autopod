@description('Azure region')
param location string

@description('Container Registry name')
param acrName string

@description('Principal ID for AcrPull role assignment')
param principalId string

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: acrName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false // Use Managed Identity, not admin user
    publicNetworkAccess: 'Enabled'
  }
}

// Grant AcrPull to the daemon's Managed Identity
resource acrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, principalId, 'acrpull')
  scope: acr
  properties: {
    principalId: principalId
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d' // AcrPull built-in role
    )
    principalType: 'ServicePrincipal'
  }
}

output loginServer string = acr.properties.loginServer
output acrId string = acr.id
