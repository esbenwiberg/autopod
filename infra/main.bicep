targetScope = 'resourceGroup'

@description('Environment name')
@allowed(['dev', 'prod'])
param environment string

@description('Azure region')
param location string = resourceGroup().location

@description('Container Registry name')
param acrName string

@description('Daemon image tag')
param daemonImageTag string = 'latest'

// ─── Log Analytics ─────────────────────────────────────────
module logAnalytics 'modules/log-analytics.bicep' = {
  name: 'log-analytics'
  params: {
    location: location
    environment: environment
  }
}

// ─── Managed Identity ──────────────────────────────────────
module identity 'modules/identity.bicep' = {
  name: 'identity'
  params: {
    location: location
    environment: environment
  }
}

// ─── Container Registry ────────────────────────────────────
module acr 'modules/acr.bicep' = {
  name: 'acr'
  params: {
    location: location
    acrName: acrName
    principalId: identity.outputs.principalId
  }
}

// ─── Key Vault ─────────────────────────────────────────────
module keyVault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    location: location
    environment: environment
    principalId: identity.outputs.principalId
  }
}

// ─── Container Apps ────────────────────────────────────────
module containerApps 'modules/container-apps.bicep' = {
  name: 'container-apps'
  params: {
    location: location
    environment: environment
    logAnalyticsWorkspaceId: logAnalytics.outputs.workspaceId
    logAnalyticsSharedKey: logAnalytics.outputs.sharedKey
    identityId: identity.outputs.identityId
    identityClientId: identity.outputs.clientId
    acrLoginServer: acr.outputs.loginServer
    keyVaultUri: keyVault.outputs.vaultUri
    daemonImageTag: daemonImageTag
  }
}

// ─── Outputs ───────────────────────────────────────────────
output daemonFqdn string = containerApps.outputs.daemonFqdn
output acrLoginServer string = acr.outputs.loginServer
output keyVaultName string = keyVault.outputs.vaultName
