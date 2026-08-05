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

var envName = '${namePrefix}-env'
var apiAppName = '${namePrefix}-api'
var webAppName = '${namePrefix}-web'
var logAnalyticsName = '${namePrefix}-logs'

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

var acrCreds = acr.listCredentials()

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
          username: acrCreds.username
          passwordSecretRef: 'acr-password'
        }
      ]
      secrets: [
        {
          name: 'database-url'
          value: databaseUrl
        }
        {
          name: 'acr-password'
          value: acrCreds.passwords[0].value
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
          username: acrCreds.username
          passwordSecretRef: 'acr-password'
        }
      ]
      secrets: [
        {
          name: 'acr-password'
          value: acrCreds.passwords[0].value
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
