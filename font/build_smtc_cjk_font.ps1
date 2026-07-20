param(
  [string]$ConverterPath = $env:LV_FONT_CONV_JS,
  [string]$NodePath = $env:NODE_EXE,
  [string]$ChineseFont = 'C:\Windows\Fonts\NotoSansSC-VF.ttf',
  [string]$JapaneseFont = 'C:\Windows\Fonts\NotoSansSC-VF.ttf',
  [string]$KoreanFont = 'C:\Windows\Fonts\malgun.ttf',
  [int]$Size = 16,
  [int]$Bpp = 1
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir '..')
$workspaceRoot = Resolve-Path (Join-Path $repoRoot '..')
$toolsDir = Join-Path $workspaceRoot 'tools'
$outDir = Join-Path $repoRoot 'package\font'
$outPath = Join-Path $outDir 'smtc_cjk_16.bin'

if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) { $NodePath = $nodeCommand.Source }
}

if ([string]::IsNullOrWhiteSpace($ConverterPath)) {
  $candidates = @(
    (Join-Path $scriptDir 'node_modules\lv_font_conv\lv_font_conv.js'),
    (Join-Path $repoRoot 'node_modules\lv_font_conv\lv_font_conv.js')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      $ConverterPath = $candidate
      break
    }
  }
}

foreach ($item in @(
  @{ Name='node'; Path=$NodePath },
  @{ Name='lv_font_conv.js'; Path=$ConverterPath },
  @{ Name='Chinese font'; Path=$ChineseFont },
  @{ Name='Japanese font'; Path=$JapaneseFont },
  @{ Name='Korean font'; Path=$KoreanFont }
)) {
  if ([string]::IsNullOrWhiteSpace($item.Path) -or -not (Test-Path -LiteralPath $item.Path)) {
    throw "Missing $($item.Name): $($item.Path)"
  }
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Resolve-FontPath {
  param(
    [string]$FontPath,
    [string]$Name
  )

  if ([System.IO.Path]::GetExtension($FontPath).ToLowerInvariant() -ne '.ttc') {
    return $FontPath
  }

  $tempDir = Join-Path $env:TEMP 'smtc_music_font_build'
  New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
  $output = Join-Path $tempDir "$Name-face0.ttf"
  if (Test-Path -LiteralPath $output) {
    return $output
  }

  $extractScript = @'
import sys
from fontTools.ttLib import TTFont

src, dst = sys.argv[1], sys.argv[2]
font = TTFont(src, fontNumber=0)
font.save(dst)
'@
  $extractScript | python - $FontPath $output
  if (-not (Test-Path -LiteralPath $output)) {
    throw "Failed to extract TTF from TTC: $FontPath"
  }
  return $output
}

$ChineseFontActual = Resolve-FontPath -FontPath $ChineseFont -Name 'zh'
$JapaneseFontActual = Resolve-FontPath -FontPath $JapaneseFont -Name 'ja'
$KoreanFontActual = Resolve-FontPath -FontPath $KoreanFont -Name 'ko'

$charsetFiles = @(
  'charset_zh_cn.txt',
  'charset_zh_tw.txt',
  'charset_ja.txt'
)

$symbolsBuilder = [System.Text.StringBuilder]::new()
$extra = '，。！？；：、（）《》〈〉【】〔〕［］｛｝“”‘’—…·￥「」『』～・〜％℃℉‰°±×÷≤≥≈←↑→↓♪♫♬♩♥♡☆★'
[void]$symbolsBuilder.Append($extra)
foreach ($file in $charsetFiles) {
  $path = Join-Path $toolsDir $file
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing charset: $path"
  }
  [void]$symbolsBuilder.Append([System.IO.File]::ReadAllText($path, [System.Text.UTF8Encoding]::new($false)))
}

$seen = [System.Collections.Generic.HashSet[char]]::new()
$symbolsChars = New-Object System.Collections.Generic.List[char]
foreach ($char in $symbolsBuilder.ToString().ToCharArray()) {
  if ([int]$char -le 127) { continue }
  if ($seen.Add($char)) { $symbolsChars.Add($char) }
}
$symbols = -join $symbolsChars

Write-Host "[font] node      = $NodePath"
Write-Host "[font] converter = $ConverterPath"
Write-Host "[font] zh font   = $ChineseFont"
Write-Host "[font] ja font   = $JapaneseFont"
Write-Host "[font] ko font   = $KoreanFont"
Write-Host "[font] zh actual = $ChineseFontActual"
Write-Host "[font] ja actual = $JapaneseFontActual"
Write-Host "[font] ko actual = $KoreanFontActual"
Write-Host "[font] symbols   = $($symbols.Length)"
Write-Host "[font] output    = $outPath"

& $NodePath $ConverterPath `
  --size $Size `
  --bpp $Bpp `
  --format bin `
  --font $ChineseFontActual `
  -r 0x20-0x7F `
  --symbols $symbols `
  --font $JapaneseFontActual `
  -r 0x3040-0x30FF `
  --font $KoreanFontActual `
  -r 0xAC00-0xD7A3 `
  --no-kerning `
  -o $outPath

if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outPath)) {
  throw "Font build failed: $outPath"
}

Get-Item -LiteralPath $outPath | Select-Object Name,Length,FullName
