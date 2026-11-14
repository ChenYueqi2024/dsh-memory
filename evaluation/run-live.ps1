param(
    [string]$Case = 'recall-package',
    [ValidateRange(1, 10)][int]$Repeats = 1,
    [switch]$Full,
    [string]$Model = 'deepseek-flash'
)

$ErrorActionPreference = 'Stop'
$evalArgs = @((Join-Path $PSScriptRoot 'run.mjs'), '--repeats', "$Repeats", '--model', $Model)
if (-not $Full) { $evalArgs += @('--case', $Case) }

# Print the exact budget before asking for any credential.
& node @evalArgs --mode plan
if ($LASTEXITCODE -ne 0) { throw 'Evaluation plan failed. No API request was sent.' }

$prompted = $false
try {
    if ([string]::IsNullOrWhiteSpace($env:DEEPSEEK_API_KEY)) {
        $secureKey = Read-Host 'DeepSeek API Key (hidden; process environment only)' -AsSecureString
        $pointer = [IntPtr]::Zero
        try {
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
            $env:DEEPSEEK_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
            $prompted = $true
        }
        finally {
            if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
            $secureKey.Dispose()
        }
    }
    & node @evalArgs --mode live
    if ($LASTEXITCODE -ne 0) { throw 'Evaluation failed. Inspect the run report; no automatic retries were made.' }
}
finally {
    if ($prompted) { Remove-Item Env:\DEEPSEEK_API_KEY -ErrorAction SilentlyContinue }
}
