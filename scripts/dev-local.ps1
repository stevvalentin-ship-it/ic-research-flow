param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $ProjectRoot
try {
  if (-not (Get-Command pnpm.cmd -ErrorAction SilentlyContinue)) { throw 'Install Node.js and pnpm first: npm install -g pnpm' }
  & pnpm.cmd install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  $LocalArgs = @('run', 'dev', '--host', '127.0.0.1', '--port', '5174', '--strictPort')
  if (-not $NoOpen) { $LocalArgs += '--open' }
  Write-Host 'IC Research Flow: http://127.0.0.1:5174  (Ctrl+C to stop)' -ForegroundColor Green
  & pnpm.cmd @LocalArgs
} finally { Pop-Location }
