<#
.SYNOPSIS
    采集 Clash Verge 的流量消耗，按分钟聚合落盘。

.DESCRIPTION
    mihomo 的 /connections 只暴露当前活动连接且不保留历史，所以这里轮询快照、
    对每条连接做差分，再按「分钟 + 域名 + 进程 + 出站链路」聚合成时间序列。
    只在采集器运行期间产生数据，装之前的流量无法追溯。

.PARAMETER IntervalSeconds
    采样间隔秒数。间隔越短，短命连接越不容易被漏掉，默认 5 秒。

.EXAMPLE
    .\collect.ps1
    .\collect.ps1 -IntervalSeconds 2
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 300)]
    [int]$IntervalSeconds = 5,

    # 采集多少秒后自动停止，0 表示一直采集到手动中断。
    [int]$DurationSeconds = 0,

    [string]$DataDir
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot 在 param 默认值里尚未赋值，只能在脚本体内取。
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = Join-Path $root 'data' }

. (Join-Path $root 'lib\clash-api.ps1')

if (-not (Test-Path -LiteralPath $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
}

# 上一次采样时每条连接的累计字节，用于算增量。
$previous = @{}
# 当前分钟的聚合桶：key -> 统计行。
$buckets = @{}
$currentMinute = ''
$totalFlushed = 0
$samples = 0
# 首次采样只记录基线：此时每条连接的 upload/download 是采集器启动前的存量，
# 直接当增量会把历史流量算进第一分钟。
$isFirstSample = $true

function Get-BucketKey {
    param($Row)
    return ($Row.host + "`u{1}" + $Row.proc + "`u{1}" + $Row.chain + "`u{1}" + $Row.rule + "`u{1}" + $Row.net + "`u{1}" + $Row.geo)
}

function Save-Buckets {
    param([string]$Minute)

    if ([string]::IsNullOrWhiteSpace($Minute) -or $buckets.Count -eq 0) { return 0 }

    $date = $Minute.Substring(0, 10)
    $file = Join-Path $DataDir "$date.jsonl"

    $lines = foreach ($entry in $buckets.Values) {
        [ordered]@{
            t    = $Minute
            host = $entry.host
            proc = $entry.proc
            chain= $entry.chain
            rule = $entry.rule
            net  = $entry.net
            geo  = $entry.geo
            up   = $entry.up
            down = $entry.down
        } | ConvertTo-Json -Compress -Depth 3
    }

    Add-Content -LiteralPath $file -Value $lines -Encoding UTF8
    $count = $buckets.Count
    $buckets.Clear()
    return $count
}

$deadline = if ($DurationSeconds -gt 0) { (Get-Date).AddSeconds($DurationSeconds) } else { [datetime]::MaxValue }

Write-Host ''
Write-Host '  Clash 流量采集器' -ForegroundColor Cyan
Write-Host "  采样间隔 $IntervalSeconds 秒   数据目录 $DataDir"
if ($DurationSeconds -gt 0) {
    Write-Host "  将在 $DurationSeconds 秒后自动停止"
} else {
    Write-Host '  按 Ctrl+C 停止（停止前会自动保存当前分钟的数据）'
}
Write-Host ''

try {
    while ((Get-Date) -lt $deadline) {
        $minute = (Get-Date).ToString('yyyy-MM-ddTHH:mm')

        if ($minute -ne $currentMinute) {
            $totalFlushed += Save-Buckets $currentMinute
            $currentMinute = $minute
        }

        try {
            $snapshot = Invoke-ClashApi -Path '/connections'
        } catch {
            Write-Host ("  {0}  内核未响应：{1}" -f (Get-Date -Format 'HH:mm:ss'), $_.Exception.Message) -ForegroundColor Yellow
            Start-Sleep -Seconds $IntervalSeconds
            continue
        }

        $connections = @()
        if ($null -ne $snapshot -and $null -ne $snapshot.connections) {
            $connections = @($snapshot.connections)
        }

        $seen = @{}
        $deltaUp = 0
        $deltaDown = 0

        foreach ($conn in $connections) {
            $id = [string]$conn.id
            if ([string]::IsNullOrWhiteSpace($id)) { continue }

            $up = [long]$conn.upload
            $down = [long]$conn.download
            $seen[$id] = @{ up = $up; down = $down }

            if ($isFirstSample) { continue }

            $prevUp = 0
            $prevDown = 0
            if ($previous.ContainsKey($id)) {
                $prevUp = $previous[$id].up
                $prevDown = $previous[$id].down
            }

            # 连接 id 复用或内核重置时可能倒退，此时以当前值为准。
            $incUp = if ($up -ge $prevUp) { $up - $prevUp } else { $up }
            $incDown = if ($down -ge $prevDown) { $down - $prevDown } else { $down }

            if ($incUp -le 0 -and $incDown -le 0) { continue }

            $meta = $conn.metadata

            $hostName = [string]$meta.host
            if ([string]::IsNullOrWhiteSpace($hostName)) { $hostName = [string]$meta.sniffHost }
            if ([string]::IsNullOrWhiteSpace($hostName)) { $hostName = [string]$meta.destinationIP }
            if ([string]::IsNullOrWhiteSpace($hostName)) { $hostName = '(unknown)' }

            $procName = [string]$meta.process
            if ([string]::IsNullOrWhiteSpace($procName) -and -not [string]::IsNullOrWhiteSpace([string]$meta.processPath)) {
                try { $procName = Split-Path -Leaf ([string]$meta.processPath) } catch { }
            }
            if ([string]::IsNullOrWhiteSpace($procName)) { $procName = '(未知进程)' }

            $chain = '(direct)'
            if ($null -ne $conn.chains -and @($conn.chains).Count -gt 0) {
                # chains 是从出站到入站排列的，第一个即最终出口。
                $chain = [string]@($conn.chains)[0]
            }

            $rule = [string]$conn.rule
            if (-not [string]::IsNullOrWhiteSpace([string]$conn.rulePayload)) {
                $rule = $rule + ':' + [string]$conn.rulePayload
            }
            if ([string]::IsNullOrWhiteSpace($rule)) { $rule = '(unknown)' }

            $geo = ''
            if ($null -ne $meta.destinationGeoIP -and @($meta.destinationGeoIP).Count -gt 0) {
                $geo = [string]@($meta.destinationGeoIP)[0]
            }

            $row = [pscustomobject]@{
                host  = $hostName
                proc  = $procName
                chain = $chain
                rule  = $rule
                net   = [string]$meta.network
                geo   = $geo
            }

            $key = Get-BucketKey $row
            if (-not $buckets.ContainsKey($key)) {
                $buckets[$key] = [pscustomobject]@{
                    host = $row.host; proc = $row.proc; chain = $row.chain
                    rule = $row.rule; net = $row.net; geo = $row.geo
                    up = [long]0; down = [long]0
                }
            }

            $buckets[$key].up += $incUp
            $buckets[$key].down += $incDown
            $deltaUp += $incUp
            $deltaDown += $incDown
        }

        $previous = $seen

        if ($isFirstSample) {
            $isFirstSample = $false
            Write-Host ("  {0}  连接 {1,3}   已建立基线，开始统计增量" -f `
                (Get-Date -Format 'HH:mm:ss'), $connections.Count) -ForegroundColor DarkGray
            Start-Sleep -Seconds $IntervalSeconds
            continue
        }

        $samples++

        $upText = '{0,8:N1}' -f ($deltaUp / 1KB)
        $downText = '{0,8:N1}' -f ($deltaDown / 1KB)
        Write-Host ("  {0}  连接 {1,3}   本次 ↑{2} KB  ↓{3} KB   待写 {4} 行" -f `
            (Get-Date -Format 'HH:mm:ss'), $connections.Count, $upText, $downText, $buckets.Count)

        Start-Sleep -Seconds $IntervalSeconds
    }
} finally {
    $totalFlushed += Save-Buckets $currentMinute
    Write-Host ''
    Write-Host ("  已停止。共采样 {0} 次，写入 {1} 行聚合数据。" -f $samples, $totalFlushed) -ForegroundColor Cyan
    Write-Host ("  用 .\report.ps1 生成报告。")
    Write-Host ''
}
