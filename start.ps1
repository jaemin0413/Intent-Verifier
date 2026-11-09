$ErrorActionPreference = 'Stop'
$serviceUrl = 'http://127.0.0.1:4318'
function Test-ServiceReady {
    try {
        $response = Invoke-RestMethod -Uri "$serviceUrl/api/session" -TimeoutSec 2
        return [bool]$response.token
    } catch { return $false }
}
if (-not (Test-ServiceReady)) {
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $logDirectory = Join-Path $PSScriptRoot '.local'
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
    # WMI owns the hidden process, so it survives a terminal/tool process ending.
    $startup = New-CimInstance -CimClass (Get-CimClass Win32_ProcessStartup) -ClientOnly -Property @{ShowWindow=[uint16]0}
    $commandLine = '"' + $nodePath + '" "' + (Join-Path $PSScriptRoot 'server.mjs') + '"'
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$commandLine; CurrentDirectory=$PSScriptRoot; ProcessStartupInformation=$startup}
    if ($created.ReturnValue -ne 0) { throw "서버를 실행하지 못했습니다. 오류 코드: $($created.ReturnValue)" }
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 300
        if (Test-ServiceReady) { break }
    }
}
if (-not (Test-ServiceReady)) { throw '앱 서버가 응답하지 않습니다. 프로젝트 폴더에서 npm start로 오류를 확인해 주세요.' }
Start-Process $serviceUrl
