@description('Proactive Capacity Management — Azure Container Apps (web + api)')
param location string = resourceGroup().location
param namePrefix string = 'pcm'
param acrName string
@secure()
param databaseUrl string
param apiImage string
param webImage string
param apiCpu string = '1.0'
param apiMemory string = '2Gi'
param webCpu string = '0.5'
param webMemory string = '1Gi'
param minReplicas int = 1
param maxReplicas int = 3

@description('Deploy VNet + Windows jumphost with this stack')
param deployPlatform bool = true
param jumpHostAdminUsername string = 'pcmadmin'
@secure()
param jumpHostAdminPassword string
@description('CIDR allowed to RDP to the jumphost, e.g. 203.0.113.10/32')
param jumpHostRdpSourceCidr string
param jumpHostVmSize string = 'Standard_B2s'

var envName = '${namePrefix}-env'
var apiAppName = '${namePrefix}-api'
var webAppName = '${namePrefix}-web'
var logAnalyticsName = '${namePrefix}-logs'
var pullIdentityName = '${namePrefix}-acr-pull'

// AcrPull role
var acrPullRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)

module platform 'platform.bicep' = if (deployPlatform) {
  name: 'pcm-platform'
  params: {
    location: location
    namePrefix: namePrefix
    jumpHostAdminUsername: jumpHostAdminUsername
    jumpHostAdminPassword: jumpHostAdminPassword
    jumpHostRdpSourceCidr: jumpHostRdpSourceCidr
    jumpHostVmSize: jumpHostVmSize
  }
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logAnalyticsName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

// User-assigned identity for ACR pull (no ACR admin user required)
resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: pullIdentityName
  location: location
}

resource acrPullAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, pullIdentity.id, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource managedEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: envName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource apiApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: apiAppName
  location: location
  dependsOn: [
    acrPullAssignment
  ]
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${pullIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnv.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        targetPort: 8080
        transport: 'http'
        allowInsecure: true
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: pullIdentity.id
        }
      ]
      secrets: [
        {
          name: 'database-url'
          value: databaseUrl
        }
      ]
    }
    template: {
      containers: [
        {
          name: apiAppName
          image: apiImage
          resources: {
            cpu: json(apiCpu)
            memory: apiMemory
          }
          env: [
            {
              name: 'PCM_API_PORT'
              value: '8080'
            }
            {
              name: 'PCM_API_HOST'
              value: '0.0.0.0'
            }
            {
              name: 'PGSSL'
              value: 'true'
            }
            {
              name: 'PGSSL_REJECT_UNAUTHORIZED'
              value: 'false'
            }
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/health'
                port: 8080
              }
              initialDelaySeconds: 20
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/health'
                port: 8080
              }
              initialDelaySeconds: 10
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

resource webApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: webAppName
  location: location
  dependsOn: [
    acrPullAssignment
  ]
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${pullIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnv.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 80
        transport: 'http'
        allowInsecure: false
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: pullIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: webAppName
          image: webImage
          resources: {
            cpu: json(webCpu)
            memory: webMemory
          }
          env: [
            {
              // Same-environment Container App DNS; ingress listens on 80 → container 8080
              name: 'API_HOST'
              value: apiAppName
            }
            {
              name: 'API_PORT'
              value: '80'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 80
              }
              initialDelaySeconds: 5
              periodSeconds: 30
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

output containerAppsEnvironmentId string = managedEnv.id
output webFqdn string = webApp.properties.configuration.ingress.fqdn
output webUrl string = 'https://${webApp.properties.configuration.ingress.fqdn}'
output apiAppNameOut string = apiApp.name
output webAppNameOut string = webApp.name
output acrLoginServer string = acr.properties.loginServer
output pullIdentityId string = pullIdentity.id
output vnetId string = deployPlatform ? platform!.outputs.vnetId : ''
output dataSubnetId string = deployPlatform ? platform!.outputs.dataSubnetId : ''
output jumpHostPublicIp string = deployPlatform ? platform!.outputs.jumpHostPublicIp : ''
output jumpHostRdpHint string = deployPlatform ? platform!.outputs.jumpHostRdpHint : ''
