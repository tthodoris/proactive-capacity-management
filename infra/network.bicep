@description('PCM shared virtual network (jumphost, data, optional ACA)')
param location string = resourceGroup().location
param namePrefix string = 'pcm'
param vnetAddressPrefix string = '10.20.0.0/16'
param jumphostSubnetPrefix string = '10.20.1.0/24'
param dataSubnetPrefix string = '10.20.2.0/24'
param acaSubnetPrefix string = '10.20.4.0/23'
param jumpHostRdpSourceCidr string

var vnetName = '${namePrefix}-vnet'
var jumphostNsgName = '${namePrefix}-jumphost-nsg'
var dataNsgName = '${namePrefix}-data-nsg'

resource jumphostNsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: jumphostNsgName
  location: location
  properties: {
    securityRules: [
      {
        name: 'AllowRdpFromAdminCidr'
        properties: {
          priority: 1000
          access: 'Allow'
          direction: 'Inbound'
          protocol: 'Tcp'
          sourceAddressPrefix: jumpHostRdpSourceCidr
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '3389'
          description: 'RDP from approved management CIDR only'
        }
      }
      {
        name: 'DenyAllInbound'
        properties: {
          priority: 4096
          access: 'Deny'
          direction: 'Inbound'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource dataNsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: dataNsgName
  location: location
  properties: {
    securityRules: [
      {
        name: 'AllowPostgresFromVnet'
        properties: {
          priority: 1000
          access: 'Allow'
          direction: 'Inbound'
          protocol: 'Tcp'
          sourceAddressPrefix: vnetAddressPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '5432'
          description: 'PostgreSQL from within the VNet (jumphost / apps)'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetAddressPrefix
      ]
    }
    subnets: [
      {
        name: 'snet-jumphost'
        properties: {
          addressPrefix: jumphostSubnetPrefix
          networkSecurityGroup: {
            id: jumphostNsg.id
          }
        }
      }
      {
        name: 'snet-data'
        properties: {
          addressPrefix: dataSubnetPrefix
          networkSecurityGroup: {
            id: dataNsg.id
          }
          delegations: [
            {
              name: 'postgres-flexible'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
        }
      }
      {
        // Reserved for future Container Apps VNet integration (/23 minimum)
        name: 'snet-aca'
        properties: {
          addressPrefix: acaSubnetPrefix
        }
      }
    ]
  }
}

output vnetId string = vnet.id
output vnetName string = vnet.name
output jumphostSubnetId string = vnet.properties.subnets[0].id
output dataSubnetId string = vnet.properties.subnets[1].id
output acaSubnetId string = vnet.properties.subnets[2].id
