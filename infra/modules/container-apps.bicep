@description('Azure region')
param location string

@description('Environment name')
param environment string

@description('Log Analytics workspace ID')
param logAnalyticsWorkspaceId string

@description('Log Analytics shared key')
@secure()
param logAnalyticsSharedKey string

@description('User-assigned Managed Identity resource ID')
param identityId string

@description('Managed Identity client ID')
param identityClientId string

@description('ACR login server')
param acrLoginServer string

@description('Key Vault URI')
param keyVaultUri string

@description('Daemon image tag')
param daemonImageTag string

// ─── Container Apps Environment ────────────────────────────
resource cae 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'autopod-${environment}-cae'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsWorkspaceId
        sharedKey: logAnalyticsSharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

// ─── Azure File Share for SQLite DB ────────────────────────
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'autopod${environment}storage'
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

resource fileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: 'autopod-data'
  properties: {
    shareQuota: 1 // 1 GB — SQLite DB won't be large
  }
}

// Mount the file share in the Container Apps Environment
resource caeStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: cae
  name: 'autopod-data'
  properties: {
    azureFile: {
      accountName: storageAccount.name
      accountKey: storageAccount.listKeys().keys[0].value
      shareName: 'autopod-data'
      accessMode: 'ReadWrite'
    }
  }
}

// ─── Daemon Container App ──────────────────────────────────
resource daemonApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'autopod-${environment}-daemon'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: cae.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'http'
        corsPolicy: {
          allowedOrigins: ['*'] // TODO: tighten in production
        }
      }
      registries: [
        {
          server: acrLoginServer
          identity: identityId
        }
      ]
      secrets: [
        {
          name: 'anthropic-api-key'
          keyVaultUrl: '${keyVaultUri}secrets/anthropic-api-key'
          identity: identityId
        }
        {
          name: 'openai-api-key'
          keyVaultUrl: '${keyVaultUri}secrets/openai-api-key'
          identity: identityId
        }
        {
          name: 'github-pat'
          keyVaultUrl: '${keyVaultUri}secrets/github-pat'
          identity: identityId
        }
        {
          name: 'teams-webhook-url'
          keyVaultUrl: '${keyVaultUri}secrets/teams-webhook-url'
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'daemon'
          image: '${acrLoginServer}/autopod/daemon:${daemonImageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '3000' }
            { name: 'DB_PATH', value: '/data/autopod.db' }
            { name: 'AZURE_CLIENT_ID', value: identityClientId }
            { name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }
            { name: 'OPENAI_API_KEY', secretRef: 'openai-api-key' }
            { name: 'GITHUB_PAT', secretRef: 'github-pat' }
            { name: 'TEAMS_WEBHOOK_URL', secretRef: 'teams-webhook-url' }
          ]
          volumeMounts: [
            {
              volumeName: 'data'
              mountPath: '/data'
            }
          ]
          probes: [
            {
              type: 'startup'
              httpGet: {
                path: '/health'
                port: 3000
              }
              initialDelaySeconds: 5
              periodSeconds: 5
              failureThreshold: 10
            }
            {
              type: 'liveness'
              httpGet: {
                path: '/health'
                port: 3000
              }
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'readiness'
              httpGet: {
                path: '/health'
                port: 3000
              }
              periodSeconds: 10
              failureThreshold: 3
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'data'
          storageName: 'autopod-data'
          storageType: 'AzureFile'
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 3
        rules: [
          {
            name: 'http-scaling'
            http: {
              metadata: {
                concurrentRequests: '10'
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [caeStorage]
}

output daemonFqdn string = daemonApp.properties.configuration.ingress.fqdn
