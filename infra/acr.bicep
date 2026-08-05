@description('Create Azure Container Registry used by Container Apps + GitHub Actions')
param location string = resourceGroup().location
param acrName string
param sku string = 'Basic'

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: {
    name: sku
  }
  properties: {
    adminUserEnabled: true
    publicNetworkAccess: 'Enabled'
  }
}

output loginServer string = acr.properties.loginServer
output acrId string = acr.id
output acrNameOut string = acr.name
