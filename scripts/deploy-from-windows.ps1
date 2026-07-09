$ErrorActionPreference = "Stop"

. "$PSScriptRoot\deploy-config.ps1"

ssh $ServerTarget "bash $RemoteDeployScript"
