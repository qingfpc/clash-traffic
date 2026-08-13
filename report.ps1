<#
.SYNOPSIS
    把采集到的流量数据汇总成一份自包含的 HTML 报告。

.DESCRIPTION
    读取 collect.ps1 落盘的按分钟聚合数据，从进程、域名、出站节点、命中规则、
    时间分布几个维度拆解流量消耗。报告不依赖任何外部资源，可离线打开或转发。

.PARAMETER Days
    统计最近多少天（含今天），默认 1。

.PARAMETER Date
    只统计某一天，格式 yyyy-MM-dd。指定后 Days 失效。

.PARAMETER Top
    每个排行榜显示多少条，默认 15。

.EXAMPLE
    .\report.ps1
    .\report.ps1 -Days 7
    .\report.ps1 -Date 2026-08-13 -Top 30
#>
[CmdletBinding()]
param(
    [int]$Days = 1,
    [string]$Date,
    [int]$Top = 15,
    [string]$DataDir,
    [string]$OutFile,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot 在 param 默认值里尚未赋值，只能在脚本体内取。
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = Join-Path $root 'data' }

function Format-Bytes {
    param([double]$Bytes)

    if ($Bytes -ge 1GB) { return ('{0:N2} GB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ('{0:N1} KB' -f ($Bytes / 1KB)) }
    return ('{0:N0} B' -f $Bytes)
}

function ConvertTo-HtmlText {
    param([string]$Text)

    if ([string]::IsNullOrEmpty($Text)) { return '' }
    return $Text.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
}

# 选出要读取的数据文件
if (-not [string]::IsNullOrWhiteSpace($Date)) {
    $targetDates = @($Date)
} else {
    $targetDates = 0..($Days - 1) | ForEach-Object { (Get-Date).AddDays(-$_).ToString('yyyy-MM-dd') }
}

$rows = New-Object System.Collections.Generic.List[object]
$loadedFiles = @()

foreach ($d in $targetDates) {
    $file = Join-Path $DataDir "$d.jsonl"
    if (-not (Test-Path -LiteralPath $file)) { continue }

    $loadedFiles += $d
    foreach ($line in (Get-Content -LiteralPath $file -Encoding UTF8)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $rows.Add(($line | ConvertFrom-Json)) } catch { }
    }
}

if ($rows.Count -eq 0) {
    Write-Host ''
    Write-Host '  没有找到任何数据。' -ForegroundColor Yellow
    Write-Host "  查找范围：$($targetDates -join ', ')"
    Write-Host "  数据目录：$DataDir"
    Write-Host '  请先运行 .\collect.ps1 采集一段时间。'
    Write-Host ''
    return
}

$totalUp = ($rows | Measure-Object -Property up -Sum).Sum
$totalDown = ($rows | Measure-Object -Property down -Sum).Sum
$totalAll = $totalUp + $totalDown

function Get-Ranking {
    param(
        [string]$Property,
        [int]$Limit
    )

    $rows |
        Group-Object -Property $Property |
        ForEach-Object {
            $up = ($_.Group | Measure-Object -Property up -Sum).Sum
            $down = ($_.Group | Measure-Object -Property down -Sum).Sum
            [pscustomobject]@{
                Name  = $_.Name
                Up    = $up
                Down  = $down
                Total = $up + $down
            }
        } |
        Sort-Object -Property Total -Descending |
        Select-Object -First $Limit
}

function New-RankingRows {
    param($Items, [double]$Max)

    $html = ''
    $rank = 0
    foreach ($item in $Items) {
        $rank++
        $pct = if ($Max -gt 0) { [math]::Round($item.Total / $Max * 100, 1) } else { 0 }
        $share = if ($totalAll -gt 0) { [math]::Round($item.Total / $totalAll * 100, 1) } else { 0 }
        $name = ConvertTo-HtmlText $item.Name

        $html += @"
<tr>
  <td class="rank">$rank</td>
  <td class="name" title="$name">$name</td>
  <td class="bar-cell"><div class="bar" style="width:$pct%"></div></td>
  <td class="num">$(Format-Bytes $item.Total)</td>
  <td class="num dim">$(Format-Bytes $item.Up)</td>
  <td class="num dim">$(Format-Bytes $item.Down)</td>
  <td class="num dim">$share%</td>
</tr>
"@
    }
    return $html
}

function New-RankingSection {
    param([string]$Title, [string]$Caption, $Items)

    if ($null -eq $Items -or @($Items).Count -eq 0) { return '' }
    $max = (@($Items) | Measure-Object -Property Total -Maximum).Maximum

    return @"
<section>
  <h2>$(ConvertTo-HtmlText $Title)</h2>
  <p class="caption">$(ConvertTo-HtmlText $Caption)</p>
  <table>
    <thead>
      <tr><th class="rank">#</th><th>名称</th><th class="bar-col">占比</th><th class="num">合计</th><th class="num">上行</th><th class="num">下行</th><th class="num">份额</th></tr>
    </thead>
    <tbody>
$(New-RankingRows $Items $max)
    </tbody>
  </table>
</section>
"@
}

# 时间分布图：根据数据实际跨度自适应选择粒度，避免采集 10 分钟只画出一根柱子、
# 或采集一周画出上千根柱子。目标是柱子数落在 72 根以内。
$parseFormat = 'yyyy-MM-ddTHH:mm'
$invariant = [cultureinfo]::InvariantCulture

$stamps = @($rows | Group-Object t | ForEach-Object { [datetime]::ParseExact($_.Name, $parseFormat, $invariant) } | Sort-Object)
$spanMinutes = ($stamps[-1] - $stamps[0]).TotalMinutes + 1

$bucketMinutes = 1440
foreach ($candidate in @(1, 5, 10, 15, 30, 60, 120, 360, 720, 1440)) {
    if (($spanMinutes / $candidate) -le 72) { $bucketMinutes = $candidate; break }
}

$epoch = $stamps[0].Date

# 必须用 @() 包裹：只有单个分组时管道返回标量，标量取 .Count 不可靠。
$hourly = @($rows |
    Group-Object {
        $dt = [datetime]::ParseExact($_.t, $parseFormat, $invariant)
        $index = [math]::Floor(($dt - $epoch).TotalMinutes / $bucketMinutes)
        $epoch.AddMinutes($index * $bucketMinutes).ToString('yyyy-MM-dd HH:mm')
    } |
    ForEach-Object {
        $up = ($_.Group | Measure-Object -Property up -Sum).Sum
        $down = ($_.Group | Measure-Object -Property down -Sum).Sum
        [pscustomobject]@{ Hour = $_.Name; Up = $up; Down = $down; Total = $up + $down }
    } |
    Sort-Object Hour)

$bucketLabel = if ($bucketMinutes -lt 60) { "$bucketMinutes 分钟" }
               elseif ($bucketMinutes -lt 1440) { "$($bucketMinutes / 60) 小时" }
               else { '1 天' }

$chartSvg = ''
if ($hourly.Count -gt 0) {
    $maxHour = ($hourly | Measure-Object -Property Total -Maximum).Maximum
    $barWidth = [math]::Max(8, [math]::Min(48, [int](900 / [math]::Max($hourly.Count, 1)) - 6))
    $gap = 6
    $chartW = ($barWidth + $gap) * $hourly.Count + 60
    $chartH = 260
    $plotH = 200

    $bars = ''
    $labels = ''
    $x = 50
    $barIndex = 0
    $labelStep = [math]::Max(1, [math]::Ceiling($hourly.Count / 24))
    foreach ($h in $hourly) {
        $hUp = if ($maxHour -gt 0) { [int]($h.Up / $maxHour * $plotH) } else { 0 }
        $hDown = if ($maxHour -gt 0) { [int]($h.Down / $maxHour * $plotH) } else { 0 }
        $yDown = 20 + $plotH - $hDown
        $yUp = $yDown - $hUp

        $tip = "$($h.Hour)  合计 $(Format-Bytes $h.Total)  上行 $(Format-Bytes $h.Up)  下行 $(Format-Bytes $h.Down)"
        $bars += "<g><title>$(ConvertTo-HtmlText $tip)</title>"
        $bars += "<rect x=""$x"" y=""$yDown"" width=""$barWidth"" height=""$hDown"" class=""bar-down""/>"
        $bars += "<rect x=""$x"" y=""$yUp"" width=""$barWidth"" height=""$hUp"" class=""bar-up""/></g>"

        # 柱子多时抽稀标签，否则文字会叠在一起。
        if (($barIndex % $labelStep) -eq 0) {
            $hourLabel = if ($bucketMinutes -ge 1440) { $h.Hour.Substring(5, 5) }
                         elseif ($bucketMinutes -ge 60) { $h.Hour.Substring(11, 2) }
                         else { $h.Hour.Substring(11, 5) }
            $labels += "<text x=""$($x + $barWidth / 2)"" y=""$(20 + $plotH + 16)"" class=""axis"" text-anchor=""middle"">$hourLabel</text>"
        }
        $barIndex++
        $x += $barWidth + $gap
    }

    $gridLines = ''
    for ($i = 0; $i -le 4; $i++) {
        $gy = 20 + $plotH - ($plotH * $i / 4)
        $gv = Format-Bytes ($maxHour * $i / 4)
        $gridLines += "<line x1=""50"" y1=""$gy"" x2=""$($chartW - 10)"" y2=""$gy"" class=""grid""/>"
        $gridLines += "<text x=""44"" y=""$($gy + 4)"" class=""axis"" text-anchor=""end"">$gv</text>"
    }

    $chartSvg = @"
<svg viewBox="0 0 $chartW $chartH" width="100%" height="$chartH" preserveAspectRatio="xMinYMin meet">
  $gridLines
  $bars
  $labels
  <text x="50" y="$($chartH - 4)" class="axis-title">时间（本地时间，每格 $bucketLabel）</text>
</svg>
"@
}

# 直连与代理的分流对比
Write-Verbose ("图表：hourly 分组 {0} 个，maxHour={1}，SVG 长度 {2}" -f @($hourly).Count, $maxHour, $chartSvg.Length)

$directBytes = 0
$proxyBytes = 0
foreach ($r in $rows) {
    if ($r.chain -eq 'DIRECT' -or $r.chain -eq '(direct)') { $directBytes += ($r.up + $r.down) }
    else { $proxyBytes += ($r.up + $r.down) }
}
$directPct = if ($totalAll -gt 0) { [math]::Round($directBytes / $totalAll * 100, 1) } else { 0 }
$proxyPct = if ($totalAll -gt 0) { [math]::Round($proxyBytes / $totalAll * 100, 1) } else { 0 }

$minuteCount = ($rows | Group-Object t).Count
$rangeText = if ($loadedFiles.Count -eq 1) { $loadedFiles[0] } else { "$($loadedFiles[-1]) 至 $($loadedFiles[0])" }

$procSection = New-RankingSection '按进程' '哪些应用在消耗流量。需要 Clash 开启 find-process-mode: always 才能归因到进程。' (Get-Ranking 'proc' $Top)
$hostSection = New-RankingSection '按域名' '流量流向了哪些站点或 CDN。' (Get-Ranking 'host' $Top)
$chainSection = New-RankingSection '按出站链路' 'DIRECT 表示直连，其余为该流量实际走的代理节点。' (Get-Ranking 'chain' $Top)
$ruleSection = New-RankingSection '按命中规则' '流量是被哪条分流规则决定去向的，可用来发现规则配置问题。' (Get-Ranking 'rule' $Top)

$html = @"
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Clash 流量报告 $rangeText</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 32px 64px;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: #fbfbfa; color: #1f2328; line-height: 1.5;
  }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; }
  h2 { font-size: 15px; font-weight: 600; margin: 40px 0 4px; }
  .sub { color: #6b7280; font-size: 13px; margin: 0 0 32px; }
  .caption { color: #6b7280; font-size: 12px; margin: 0 0 12px; }
  .stats { display: flex; gap: 40px; padding: 20px 0; border-top: 1px solid #e5e7eb; border-bottom: 1px solid #e5e7eb; flex-wrap: wrap; }
  .stat .label { font-size: 12px; color: #6b7280; margin-bottom: 2px; }
  .stat .value { font-size: 24px; font-weight: 600; letter-spacing: -0.02em; }
  .stat .value.accent { color: #1a56db; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead th { text-align: left; font-weight: 500; color: #6b7280; font-size: 12px; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; }
  tbody td { padding: 6px 8px; border-bottom: 1px solid #f1f2f4; }
  tbody tr:hover { background: #f6f8fa; }
  .rank { width: 32px; color: #9ca3af; font-variant-numeric: tabular-nums; }
  .name { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .dim { color: #6b7280; }
  .bar-col { width: 30%; }
  .bar-cell { width: 30%; padding-right: 16px; }
  .bar { height: 6px; background: #1a56db; border-radius: 2px; min-width: 1px; }
  .split { display: flex; height: 28px; border-radius: 3px; overflow: hidden; margin: 12px 0 6px; background: #eef0f3; }
  .split .d { background: #16a34a; }
  .split .p { background: #1a56db; }
  .split-legend { display: flex; gap: 20px; font-size: 12px; color: #6b7280; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
  .grid { stroke: #e5e7eb; stroke-width: 1; }
  .axis { fill: #9ca3af; font-size: 10px; }
  .axis-title { fill: #6b7280; font-size: 11px; }
  .bar-down { fill: #1a56db; }
  .bar-up { fill: #93b4f5; }
  footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">

<h1>Clash 流量报告</h1>
<p class="sub">统计区间 $rangeText　·　覆盖 $minuteCount 个采样分钟　·　生成于 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')</p>

<div class="stats">
  <div class="stat"><div class="label">总流量</div><div class="value accent">$(Format-Bytes $totalAll)</div></div>
  <div class="stat"><div class="label">上行</div><div class="value">$(Format-Bytes $totalUp)</div></div>
  <div class="stat"><div class="label">下行</div><div class="value">$(Format-Bytes $totalDown)</div></div>
  <div class="stat"><div class="label">涉及域名</div><div class="value">$(@(Get-Ranking 'host' 100000).Count)</div></div>
</div>

<section>
  <h2>流量的时间分布</h2>
  <p class="caption">每根柱子代表 $bucketLabel 内消耗的字节数（纵轴），深色为下行、浅色为上行。鼠标悬停可看具体数值。粒度随统计跨度自动调整。数据来源：本机 Clash 内核连接快照差分。</p>
  $chartSvg
</section>

<section>
  <h2>直连与代理的分流占比</h2>
  <p class="caption">代理流量会消耗你的机场套餐，直连不会。</p>
  <div class="split">
    <div class="d" style="width:$directPct%"></div>
    <div class="p" style="width:$proxyPct%"></div>
  </div>
  <div class="split-legend">
    <span><span class="dot" style="background:#16a34a"></span>直连 $(Format-Bytes $directBytes)（$directPct%）</span>
    <span><span class="dot" style="background:#1a56db"></span>走代理 $(Format-Bytes $proxyBytes)（$proxyPct%）</span>
  </div>
</section>

$procSection
$hostSection
$chainSection
$ruleSection

<footer>
  由 clash-traffic 采集器生成。数据仅覆盖 collect.ps1 实际运行的时间段，未运行期间的流量不会被记录。
</footer>

</div>
</body>
</html>
"@

if ([string]::IsNullOrWhiteSpace($OutFile)) {
    $reportDir = Join-Path $root 'reports'
    if (-not (Test-Path -LiteralPath $reportDir)) {
        New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
    }
    $OutFile = Join-Path $reportDir ("traffic-{0}.html" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
}

Set-Content -LiteralPath $OutFile -Value $html -Encoding UTF8

Write-Host ''
Write-Host '  报告已生成' -ForegroundColor Cyan
Write-Host "  统计区间 : $rangeText（$minuteCount 个采样分钟）"
Write-Host "  总流量   : $(Format-Bytes $totalAll)   上行 $(Format-Bytes $totalUp)   下行 $(Format-Bytes $totalDown)"
Write-Host "  分流占比 : 直连 $directPct%   代理 $proxyPct%"
Write-Host "  文件     : $OutFile"
Write-Host ''

if (-not $NoLaunch) {
    Start-Process $OutFile
}
