param(
    [switch]$DryRun,
    [string]$OutputDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ProjectFile = Join-Path $RepoRoot 'desktop\AlexaAlarmSkip.csproj'
$TargetDir = if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    Join-Path $RepoRoot 'dist\desktop'
} else {
    $OutputDir
}
$TargetExe = Join-Path $TargetDir 'AlexaAlarmSkip.exe'
$WebViewLoaderDll = Join-Path $TargetDir 'WebView2Loader.dll'

if (-not (Test-Path -LiteralPath $ProjectFile -PathType Leaf)) {
    Write-Error "プロジェクトファイルが見つかりません: $ProjectFile"
    exit 1
}

$PublishArgs = @(
    'publish',
    $ProjectFile,
    '-c', 'Release',
    '-r', 'win-x64',
    '--self-contained', 'false',
    '-p:PublishSingleFile=true',
    '-o', $TargetDir
)

if ($DryRun) {
    Write-Output "Dry-run mode enabled."
    Write-Output "Project : $ProjectFile"
    Write-Output "Output  : $TargetDir"
    Write-Output "Command : dotnet $($PublishArgs -join ' ')"
    exit 0
}

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Error "dotnet CLI が見つかりません。.NET 10 SDK がインストールされているか確認してください。"
    exit 1
}

if (-not (Test-Path -LiteralPath $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
}

if (Test-Path -LiteralPath $TargetExe -PathType Leaf) {
    try {
        $stream = [System.IO.File]::Open($TargetExe, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $stream.Close()
    } catch {
        Write-Error "出力先ファイルが起動中またはロックされています。アプリを閉じてから再実行してください: $TargetExe"
        exit 1
    }
}

$output = & dotnet @PublishArgs 2>&1
$exitCode = $LASTEXITCODE
if ($output) {
    $output | ForEach-Object { Write-Output $_ }
}
if ($exitCode -ne 0) {
    Write-Error "dotnet publish によるビルドが失敗しました (exit=$exitCode)"
    exit $exitCode
}

if (-not (Test-Path -LiteralPath $TargetExe -PathType Leaf)) {
    Write-Error "ビルド成果物が見つかりません: $TargetExe"
    exit 1
}
if (-not (Test-Path -LiteralPath $WebViewLoaderDll -PathType Leaf)) {
    Write-Error "必須のランタイム DLL が見つかりません: $WebViewLoaderDll"
    exit 1
}

$item = Get-Item -LiteralPath $TargetExe
$verInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($TargetExe)
Write-Output ("Built: {0} ({1} bytes)" -f $item.FullName, $item.Length)
Write-Output ("Loader: {0}" -f $WebViewLoaderDll)
Write-Output ("VersionInfo: ProductName={0}, FileVersion={1}, ProductVersion={2}" -f $verInfo.ProductName, $verInfo.FileVersion, $verInfo.ProductVersion)
