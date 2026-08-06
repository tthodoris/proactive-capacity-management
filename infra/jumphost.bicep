@description('Windows Server jumphost for DB / platform management')
param location string = resourceGroup().location
param namePrefix string = 'pcm'
param subnetId string
param adminUsername string
@secure()
param adminPassword string
param vmSize string = 'Standard_B2s'
param jumpHostRdpSourceCidr string

var vmName = '${namePrefix}-jump'
var nicName = '${namePrefix}-jump-nic'
var pipName = '${namePrefix}-jump-pip'
var nsgName = '${namePrefix}-jump-nsg'

resource pip 'Microsoft.Network/publicIPAddresses@2023-11-01' = {
  name: pipName
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: nsgName
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
        }
      }
    ]
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2023-11-01' = {
  name: nicName
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          subnet: {
            id: subnetId
          }
          privateIPAllocationMethod: 'Dynamic'
          publicIPAddress: {
            id: pip.id
          }
        }
      }
    ]
    networkSecurityGroup: {
      id: nsg.id
    }
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-03-01' = {
  name: vmName
  location: location
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    storageProfile: {
      imageReference: {
        publisher: 'MicrosoftWindowsServer'
        offer: 'WindowsServer'
        sku: '2022-datacenter-azure-edition'
        version: 'latest'
      }
      osDisk: {
        name: '${vmName}-osdisk'
        createOption: 'FromImage'
        managedDisk: {
          storageAccountType: 'Premium_LRS'
        }
        deleteOption: 'Delete'
      }
    }
    osProfile: {
      computerName: take(replace(vmName, '-', ''), 15)
      adminUsername: adminUsername
      adminPassword: adminPassword
      windowsConfiguration: {
        provisionVMAgent: true
        enableAutomaticUpdates: true
      }
      allowExtensionOperations: true
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
          properties: {
            deleteOption: 'Delete'
          }
        }
      ]
    }
    diagnosticsProfile: {
      bootDiagnostics: {
        enabled: true
      }
    }
  }
}

// Enable Azure AD login + helpful tooling note via Custom Script is heavy;
// keep the box stock Windows Server for RDP + Azure Data Studio / psql install by admin.

output vmId string = vm.id
output vmName string = vm.name
output publicIpAddress string = pip.properties.ipAddress
output privateIpAddress string = nic.properties.ipConfigurations[0].properties.privateIPAddress
output adminUsername string = adminUsername
output rdpHint string = 'mstsc /v:${pip.properties.ipAddress}'
