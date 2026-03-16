@description('Azure region')
param location string

@description('Environment name')
param environment string

@description('Principal ID for secret read access')
param principalId string

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'autopod-${environment}-kv'
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    enableRbacAuthorization: true // Use RBAC instead of access policies
  }
}

// Grant Key Vault Secrets User to the daemon's Managed Identity
resource kvSecretsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, principalId, 'kvsecretsuser')
  scope: keyVault
  properties: {
    principalId: principalId
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4633458b-17de-408a-b874-0445c86b69e6' // Key Vault Secrets User
    )
    principalType: 'ServicePrincipal'
  }
}

// Secrets are created manually or via CLI — not in Bicep
// (Never put secret VALUES in IaC templates)
//
// az keyvault secret set --vault-name autopod-${env}-kv --name anthropic-api-key --value <value>
// az keyvault secret set --vault-name autopod-${env}-kv --name openai-api-key --value <value>
// az keyvault secret set --vault-name autopod-${env}-kv --name github-pat --value <value>
// az keyvault secret set --vault-name autopod-${env}-kv --name teams-webhook-url --value <value>

output vaultUri string = keyVault.properties.vaultUri
output vaultName string = keyVault.name
