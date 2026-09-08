# User-scope compatibility repair for podman-compose 1.6.0 on Windows.
# Run with -Undo to restore the exact pre-repair module.
param([switch]$Undo)
$ErrorActionPreference = 'Stop'
$alvToolsDirectory = (& uv tool dir).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Unable to locate uv tools.' }
$alvModule = Join-Path $alvToolsDirectory 'podman-compose\Lib\site-packages\podman_compose.py'
$alvBackup = "$alvModule.alv1076-backup"
if ($Undo) {
  if (-not (Test-Path -LiteralPath $alvBackup)) { throw 'Backup is absent.' }
  Copy-Item -LiteralPath $alvBackup -Destination $alvModule -Force
  Write-Output 'Restored podman-compose module from the original backup.'
  exit
}
$alvContent = [IO.File]::ReadAllText($alvModule)
$alvOld = "def is_context_git_url(path: str) -> bool:`n"
$alvNew = "def is_context_git_url(path: str) -> bool:`n    # ALV Windows compatibility: a drive path is not a Git URL.`n    if os.name == 'nt' and os.path.splitdrive(path)[0]:`n        return False`n"
if ($alvContent.Contains('# ALV Windows compatibility:')) { Write-Output 'Compatibility repair already present.'; exit }
if (-not $alvContent.Contains($alvOld)) { throw 'Unsupported module layout; no changes made.' }
if (Test-Path -LiteralPath $alvBackup) { throw 'Existing backup must be reconciled before patching.' }
Copy-Item -LiteralPath $alvModule -Destination $alvBackup
[IO.File]::WriteAllText($alvModule, $alvContent.Replace($alvOld, $alvNew), [Text.UTF8Encoding]::new($false))
$alvPython = Join-Path $alvToolsDirectory 'podman-compose\Scripts\python.exe'
& $alvPython -c "import podman_compose as p; assert not p.is_context_git_url(r'C:\workspace\lab'); assert p.is_context_git_url('https://github.com/example/repo.git'); print('Fresh-process Windows path and Git URL checks passed.')"
if ($LASTEXITCODE -ne 0) { throw 'Fresh-process verification failed.' }
