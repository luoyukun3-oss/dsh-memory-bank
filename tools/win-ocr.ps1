# win-ocr.ps1 - OCR an image via the built-in Windows.Media.Ocr engine.
# Usage:  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\win-ocr.ps1 -Path <image>
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less files as ANSI,
#       so non-ASCII comments would be mangled and can break parsing.
# WinRT is available in Windows PowerShell 5.1 but NOT reliably in PowerShell 7.
param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  $m = $asTaskGeneric.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime] | Out-Null

$file    = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream  = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap  = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { Write-Output 'OCR-ENGINE-UNAVAILABLE'; exit 1 }

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
Write-Output ('LANG=' + $engine.RecognizerLanguage.LanguageTag)
Write-Output 'TEXT-BEGIN'
Write-Output $result.Text
Write-Output 'TEXT-END'
Write-Output 'LINES-BEGIN'
foreach ($line in $result.Lines) { Write-Output ('| ' + $line.Text) }
Write-Output 'LINES-END'
