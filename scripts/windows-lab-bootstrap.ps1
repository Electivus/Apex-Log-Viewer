param(
  [Parameter(Mandatory = $true)][string]$PublicKeyBase64,
  [Parameter(Mandatory = $true)][string]$AdminUser,
  [Parameter(Mandatory = $true)][string]$RepoUrl,
  [string]$Ref = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Git for Windows publishes this SHA-256 in the release notes. The version matches the windows-latest image.
$GitVersion = '2.56.0.windows.4'
$GitInstaller = 'Git-2.56.0.4-64-bit.exe'
$GitSha256 = '4961a4a8cc778d8b6e00a5819e5fe4d078b754555aff7aedc2d77a5d74c2de80'

$LabRoot = 'C:\alv-lab'
$RepoDir = "$LabRoot\repo"
$NodeRoot = "$LabRoot\node"
$NodeCurrent = "$NodeRoot\current"
$Downloads = "$LabRoot\downloads"
$CorepackHome = "$LabRoot\corepack"
$GitCmdDir = 'C:\Program Files\Git\cmd'
$GitBash = 'C:\Program Files\Git\bin\bash.exe'
$RestartSshd = $false

function Invoke-Native {
  param([string]$FilePath, [string[]]$Arguments)
  $output = & $FilePath @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath $($Arguments -join ' ') exited with code ${LASTEXITCODE}: $output"
  }
  return $output
}

function Get-VerifiedDownload {
  param([string]$Url, [string]$FileName, [string]$ExpectedSha256)
  $target = Join-Path $Downloads $FileName
  Invoke-WebRequest -Uri $Url -OutFile $target -UseBasicParsing
  $actual = (Get-FileHash -Algorithm SHA256 -Path $target).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
    Remove-Item -Force $target
    throw "SHA-256 mismatch for $FileName"
  }
  return $target
}

function Add-MachinePath {
  param([string]$Entry)
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if (($machinePath -split ';') -notcontains $Entry) {
    [Environment]::SetEnvironmentVariable('Path', "$Entry;$machinePath", 'Machine')
    $script:RestartSshd = $true
  }
}

function Set-MachineVariable {
  param([string]$Name, [string]$Value)
  if ([Environment]::GetEnvironmentVariable($Name, 'Machine') -ne $Value) {
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Machine')
    $script:RestartSshd = $true
  }
  Set-Item -Path "Env:$Name" -Value $Value
}

function Install-LabDirectories {
  foreach ($dir in @($LabRoot, $NodeRoot, $Downloads, $CorepackHome)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  # icacls rewrites every file under the root, which takes minutes once node_modules exists.
  $granted = (Get-Acl -Path $LabRoot).Access | Where-Object {
    $_.IdentityReference -like "*\$AdminUser" -and $_.FileSystemRights -match 'FullControl'
  }
  if (-not $granted) { Invoke-Native icacls @($LabRoot, '/grant', "${AdminUser}:(OI)(CI)F", '/Q') | Out-Null }
}

function Expand-SystemDrive {
  # The smalldisk image keeps a 30 GB partition on a larger disk.
  Update-Disk -Number (Get-Partition -DriveLetter C).DiskNumber
  $largest = (Get-PartitionSupportedSize -DriveLetter C).SizeMax
  if ((Get-Partition -DriveLetter C).Size -lt $largest) { Resize-Partition -DriveLetter C -Size $largest }
}

function Install-OpenSsh {
  if (-not (Get-Service -Name sshd -ErrorAction SilentlyContinue)) {
    Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null
  }
  Set-Service -Name sshd -StartupType Automatic
  Start-Service -Name sshd

  if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' `
      -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
  }
  Enable-NetFirewallRule -Name 'OpenSSH-Server-In-TCP'

  $configPath = 'C:\ProgramData\ssh\sshd_config'
  $config = Get-Content -Raw -Path $configPath
  $hardened = $config -replace '(?m)^#?PasswordAuthentication\s+\S+', 'PasswordAuthentication no'
  if ($hardened -notmatch '(?m)^KbdInteractiveAuthentication no') {
    $hardened = "KbdInteractiveAuthentication no`r`n$hardened"
  }
  if ($hardened -ne $config) {
    [IO.File]::WriteAllText($configPath, $hardened)
    $script:RestartSshd = $true
  }

  $publicKey = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PublicKeyBase64)).Trim()
  $keysPath = 'C:\ProgramData\ssh\administrators_authorized_keys'
  [IO.File]::WriteAllText($keysPath, "$publicKey`n")
  Invoke-Native icacls @($keysPath, '/inheritance:r', '/grant', '*S-1-5-32-544:F', '/grant', '*S-1-5-18:F', '/Q') | Out-Null
}

function Install-Git {
  $installed = ''
  if (Test-Path "$GitCmdDir\git.exe") {
    $installed = (& "$GitCmdDir\git.exe" --version) -replace '^git version ', ''
  }
  if ($installed -ne $GitVersion) {
    $tag = "v$GitVersion"
    $installer = Get-VerifiedDownload `
      -Url "https://github.com/git-for-windows/git/releases/download/$tag/$GitInstaller" `
      -FileName $GitInstaller -ExpectedSha256 $GitSha256
    $process = Start-Process -FilePath $installer -Wait -PassThru -ArgumentList @(
      '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/CLOSEAPPLICATIONS', '/RESTARTAPPLICATIONS',
      '/o:PathOption=CmdTools', '/o:BashTerminalOption=ConHost', '/o:EnableSymlinks=Enabled', '/COMPONENTS=gitlfs'
    )
    if ($process.ExitCode -ne 0) { throw "Git installer exited with code $($process.ExitCode)" }
    $script:RestartSshd = $true
  }
  $env:Path = "$GitCmdDir;$env:Path"

  Invoke-Native "$GitCmdDir\git.exe" @('config', '--system', 'core.autocrlf', 'false') | Out-Null
  Invoke-Native "$GitCmdDir\git.exe" @('config', '--system', '--replace-all', 'safe.directory', '*') | Out-Null
  Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name 'LongPathsEnabled' -Value 1

  if (-not (Test-Path 'HKLM:\SOFTWARE\OpenSSH')) { New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null }
  $shell = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -ErrorAction SilentlyContinue).DefaultShell
  if ($shell -ne $GitBash) {
    New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value $GitBash -PropertyType String -Force | Out-Null
    $script:RestartSshd = $true
  }
}

function Sync-Repository {
  $git = "$GitCmdDir\git.exe"
  $firstClone = -not (Test-Path "$RepoDir\.git")
  if ($firstClone) {
    Invoke-Native $git @('init', '--quiet', $RepoDir) | Out-Null
    Invoke-Native $git @('-C', $RepoDir, 'remote', 'add', 'origin', $RepoUrl) | Out-Null
  }
  $target = if ($Ref) { $Ref } elseif ($firstClone) { 'main' } else { '' }
  if (-not $target) { return }

  Invoke-Native $git @('-C', $RepoDir, 'fetch', '--quiet', '--depth', '1', 'origin', $target) | Out-Null
  $wanted = (Invoke-Native $git @('-C', $RepoDir, 'rev-parse', 'FETCH_HEAD')).Trim()
  $current = ''
  if (-not $firstClone) {
    $current = (& $git -C $RepoDir rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0) { $current = '' }
  }
  if ($wanted -eq $current) { return }
  if (-not $firstClone) {
    $dirty = Invoke-Native $git @('-C', $RepoDir, 'status', '--porcelain')
    if ($dirty) { throw "The repository on the VM has local changes. Refusing to move it to $target." }
  }
  Invoke-Native $git @('-C', $RepoDir, 'checkout', '--quiet', '--detach', 'FETCH_HEAD') | Out-Null
}

function Install-Node {
  $version = (Get-Content -Raw -Path "$RepoDir\.nvmrc").Trim().TrimStart('v')
  if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'The .nvmrc file does not hold an exact version.' }
  $name = "node-v$version-win-x64"
  $dir = "$NodeRoot\$name"

  if (-not (Test-Path "$dir\node.exe")) {
    $base = "https://nodejs.org/dist/v$version"
    $sums = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing).Content
    $line = ($sums -split "`n") | Where-Object { $_ -match "\s$name\.zip\s*$" } | Select-Object -First 1
    if (-not $line) { throw "SHASUMS256.txt has no entry for $name.zip" }
    $zip = Get-VerifiedDownload -Url "$base/$name.zip" -FileName "$name.zip" -ExpectedSha256 (($line -split '\s+')[0])
    Invoke-Native "$env:SystemRoot\System32\tar.exe" @('-xf', $zip, '-C', $NodeRoot) | Out-Null
  }

  $junction = Get-Item -Path $NodeCurrent -ErrorAction SilentlyContinue
  if ($junction -and $junction.Target -ne $dir) {
    [IO.Directory]::Delete($NodeCurrent)
    $junction = $null
  }
  if (-not $junction) { New-Item -ItemType Junction -Path $NodeCurrent -Target $dir | Out-Null }
  Add-MachinePath $NodeCurrent
  $env:Path = "$NodeCurrent;$env:Path"
}

function Install-Pnpm {
  Set-MachineVariable 'COREPACK_HOME' $CorepackHome
  Set-MachineVariable 'COREPACK_ENABLE_DOWNLOAD_PROMPT' '0'
  $packageManager = (Get-Content -Raw -Path "$RepoDir\package.json" | ConvertFrom-Json).packageManager
  if ($packageManager -notmatch '^pnpm@\d+\.\d+\.\d+') { throw 'package.json does not pin pnpm.' }
  Invoke-Native "$NodeCurrent\corepack.cmd" @('enable') | Out-Null
  Invoke-Native "$NodeCurrent\corepack.cmd" @('prepare', $packageManager, '--activate') | Out-Null
  $version = (Invoke-Native "$NodeCurrent\pnpm.cmd" @('--version', '--dir', $LabRoot)).Trim()
  Write-Output "ALV_PNPM=$version"
}

function Invoke-Step {
  param([string]$Name, [scriptblock]$Body)
  $watch = [Diagnostics.Stopwatch]::StartNew()
  & $Body
  Write-Output "ALV_STEP=$Name $([int]$watch.Elapsed.TotalSeconds)s"
}

Invoke-Step 'directories' { Install-LabDirectories }
Invoke-Step 'system-drive' { Expand-SystemDrive }
Invoke-Step 'openssh' { Install-OpenSsh }
Invoke-Step 'git' { Install-Git }
Invoke-Step 'repository' { Sync-Repository }
Invoke-Step 'node' { Install-Node }
Invoke-Step 'pnpm' { Install-Pnpm }

if ($RestartSshd) { Restart-Service -Name sshd }

Write-Output "ALV_GIT=$((& "$GitCmdDir\git.exe" --version) -replace '^git version ', '')"
Write-Output "ALV_NODE=$(& "$NodeCurrent\node.exe" --version)"
Write-Output "ALV_REF=$(& "$GitCmdDir\git.exe" -C $RepoDir rev-parse HEAD)"
Write-Output "ALV_DEFENDER_REALTIME=$((Get-MpComputerStatus).RealTimeProtectionEnabled)"
Write-Output "ALV_HOST_KEY=$((Get-Content -Raw -Path 'C:\ProgramData\ssh\ssh_host_ed25519_key.pub').Trim())"
Write-Output 'ALV_BOOTSTRAP_OK'
