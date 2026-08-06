@description('PCM platform: VNet + Windows jumphost (idempotent)')
param location string = resourceGroup().location
param namePrefix string = 'pcm'
param jumpHostAdminUsername string = 'pcmadmin'
@secure()
param jumpHostAdminPassword string
param jumpHostRdpSourceCidr string
param jumpHostVmSize string = 'Standard_B2s'
param vnetAddressPrefix string = '10.20.0.0/16'
param jumphostSubnetPrefix string = '10.20.1.0/24'
param dataSubnetPrefix string = '10.20.2.0/24'
param acaSubnetPrefix string = '10.20.4.0/23'

module network 'network.bicep' = {
  name: 'pcm-network'
  params: {
    location: location
    namePrefix: namePrefix
    vnetAddressPrefix: vnetAddressPrefix
    jumphostSubnetPrefix: jumphostSubnetPrefix
    dataSubnetPrefix: dataSubnetPrefix
    acaSubnetPrefix: acaSubnetPrefix
    jumpHostRdpSourceCidr: jumpHostRdpSourceCidr
  }
}

module jumphost 'jumphost.bicep' = {
  name: 'pcm-jumphost'
  params: {
    location: location
    namePrefix: namePrefix
    subnetId: network.outputs.jumphostSubnetId
    adminUsername: jumpHostAdminUsername
    adminPassword: jumpHostAdminPassword
    vmSize: jumpHostVmSize
    jumpHostRdpSourceCidr: jumpHostRdpSourceCidr
  }
}

output vnetId string = network.outputs.vnetId
output vnetName string = network.outputs.vnetName
output jumphostSubnetId string = network.outputs.jumphostSubnetId
output dataSubnetId string = network.outputs.dataSubnetId
output acaSubnetId string = network.outputs.acaSubnetId
output jumpHostVmName string = jumphost.outputs.vmName
output jumpHostPublicIp string = jumphost.outputs.publicIpAddress
output jumpHostPrivateIp string = jumphost.outputs.privateIpAddress
output jumpHostAdminUsername string = jumphost.outputs.adminUsername
output jumpHostRdpHint string = jumphost.outputs.rdpHint
