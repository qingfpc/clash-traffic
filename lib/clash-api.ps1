# Minimal mihomo REST client that speaks HTTP over the Clash Verge named pipe.
# Chunked bodies must be parsed at the byte level: chunk sizes count bytes, and
# decoding to a string first desynchronises the offsets on any multi-byte character.

$script:ClashConfigDir = Join-Path $env:APPDATA 'io.github.clash-verge-rev.clash-verge-rev'

function Get-ClashSecret {
    $configPath = Join-Path $script:ClashConfigDir 'config.yaml'
    if (-not (Test-Path -LiteralPath $configPath)) { return '' }

    $match = Select-String -LiteralPath $configPath -Pattern '^secret:\s*(.+)$' | Select-Object -First 1
    if ($null -eq $match) { return '' }

    return $match.Matches[0].Groups[1].Value.Trim().Trim("'").Trim('"')
}

function Get-ClashPipeName {
    $configPath = Join-Path $script:ClashConfigDir 'config.yaml'
    if (Test-Path -LiteralPath $configPath) {
        $match = Select-String -LiteralPath $configPath -Pattern '^external-controller-pipe:\s*(.+)$' | Select-Object -First 1
        if ($null -ne $match) {
            $raw = $match.Matches[0].Groups[1].Value.Trim()
            return ($raw -replace '^\\\\\.\\pipe\\', '')
        }
    }
    return 'verge-mihomo'
}

function Invoke-ClashApi {
    param(
        [string]$Method = 'GET',
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Body,
        [int]$TimeoutMs = 5000
    )

    $pipeName = Get-ClashPipeName
    $secret = Get-ClashSecret

    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
    try {
        $pipe.Connect($TimeoutMs)
    } catch {
        throw "无法连接 Clash 内核管道 \\.\pipe\$pipeName，请确认 Clash Verge 正在运行。"
    }

    try {
        $bodyBytes = if ($Body) { [Text.Encoding]::UTF8.GetBytes($Body) } else { [byte[]]@() }
        $header = "$Method $Path HTTP/1.1`r`n" +
                  "Host: localhost`r`n" +
                  "Authorization: Bearer $secret`r`n" +
                  "Content-Type: application/json`r`n" +
                  "Content-Length: $($bodyBytes.Length)`r`n" +
                  "Connection: close`r`n`r`n"

        $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
        $pipe.Write($headerBytes, 0, $headerBytes.Length)
        if ($bodyBytes.Length -gt 0) { $pipe.Write($bodyBytes, 0, $bodyBytes.Length) }
        $pipe.Flush()

        $buffer = New-Object byte[] 16384
        $memory = New-Object System.IO.MemoryStream
        while (($read = $pipe.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $memory.Write($buffer, 0, $read)
        }
        $raw = $memory.ToArray()
    } finally {
        $pipe.Dispose()
    }

    if ($raw.Length -eq 0) { return $null }

    # Locate the CRLFCRLF that terminates the response header.
    $split = -1
    for ($i = 0; $i -lt $raw.Length - 3; $i++) {
        if ($raw[$i] -eq 13 -and $raw[$i + 1] -eq 10 -and $raw[$i + 2] -eq 13 -and $raw[$i + 3] -eq 10) {
            $split = $i
            break
        }
    }
    if ($split -lt 0) { return $null }

    $headerText = [Text.Encoding]::ASCII.GetString($raw, 0, $split)
    $bodyStart = $split + 4
    $bodyLength = $raw.Length - $bodyStart
    if ($bodyLength -le 0) { return $null }

    if ($headerText -match '(?i)Transfer-Encoding:\s*chunked') {
        $out = New-Object System.IO.MemoryStream
        $pos = $bodyStart
        while ($pos -lt $raw.Length) {
            $lineEnd = -1
            for ($i = $pos; $i -lt $raw.Length - 1; $i++) {
                if ($raw[$i] -eq 13 -and $raw[$i + 1] -eq 10) { $lineEnd = $i; break }
            }
            if ($lineEnd -lt 0) { break }

            $sizeText = [Text.Encoding]::ASCII.GetString($raw, $pos, $lineEnd - $pos).Split(';')[0].Trim()
            if ([string]::IsNullOrWhiteSpace($sizeText)) { break }

            try { $size = [Convert]::ToInt32($sizeText, 16) } catch { break }
            if ($size -le 0) { break }

            $dataStart = $lineEnd + 2
            if ($dataStart + $size -gt $raw.Length) { break }

            $out.Write($raw, $dataStart, $size)
            $pos = $dataStart + $size + 2
        }
        $bodyBytesOut = $out.ToArray()
    } else {
        $bodyBytesOut = New-Object byte[] $bodyLength
        [Array]::Copy($raw, $bodyStart, $bodyBytesOut, 0, $bodyLength)
    }

    if ($bodyBytesOut.Length -eq 0) { return $null }

    $json = [Text.Encoding]::UTF8.GetString($bodyBytesOut)
    try {
        return $json | ConvertFrom-Json
    } catch {
        return $json
    }
}
