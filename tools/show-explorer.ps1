# show-explorer.ps1 —— 在资源管理器中定位文件/目录，并把它【提到前台】
#
# 为什么需要它：DSH 的 reveal_in_explorer 是能创建窗口的（实测 Shell 能枚举到），
# 但它跑在 DSH 进程里 —— 而后台进程没有权限把窗口抢到前台（Windows 的前台锁定机制），
# 于是窗口被 DSH 全屏窗口挡住，看起来像"没反应"。本脚本在启动后用
# AttachThreadInput 把自己的线程挂到当前前台线程上，再 SetForegroundWindow，就能提上去。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File show-explorer.ps1 "E:\2\某文件.zip"
#   powershell -NoProfile -ExecutionPolicy Bypass -File show-explorer.ps1 "E:\2"
#
# ⚠️ 本文件必须保存为 UTF-8 with BOM（5.1 无 BOM 时按 GBK 解码中文注释 ⇒ 语法崩）。
#    ⚠️ 而 write/edit 工具写回时会【丢掉 BOM】⇒ 每次改完都要重补：
#    $u = New-Object System.Text.UTF8Encoding $true
#    $t = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($p))
#    [System.IO.File]::WriteAllText($p, $t, $u)

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Path,
    [int]$WaitMs = 1200
)

if (-not (Test-Path -LiteralPath $Path)) {
    Write-Output "路径不存在：$Path"
    exit 1
}
$full = (Resolve-Path -LiteralPath $Path).Path
$isDir = (Get-Item -LiteralPath $full).PSIsContainer

# --- 1. 用 WMI 启动 explorer -------------------------------------------------
# 不用 Start-Process：DSH 的 pwsh 工具把命令放进 job object，Start-Process 的子进程
# 会继承该 job，句柄释放时被连带清理（同一坑在 screen-watch 的 README 里记过）。
$target = if ($isDir) { 'explorer.exe "' + $full + '"' } else { 'explorer.exe /select,"' + $full + '"' }
try {
    $res = ([wmiclass]'Win32_Process').Create($target)
    if ($res.ReturnValue -ne 0) { Write-Output "explorer 启动失败，ReturnValue=$($res.ReturnValue)"; exit 1 }
} catch {
    Write-Output "explorer 启动异常：$($_.Exception.Message)"
    exit 1
}
Write-Output "已请求定位：$full"

# --- 2. 等窗口出现（轮询 Shell 的窗口列表）-----------------------------------
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class SW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@

# 匹配要点（第一版在这里栽过）：LocationURL 带 "file:///" 前缀，
# 而且 /select 打开的是【父目录】⇒ 必须转成同样的 URL 形式、并且父目录也算命中。
$wantUrl   = 'file:///' + ($full -replace '\\', '/')
$parentPath = [System.IO.Path]::GetDirectoryName($full)
if (-not $parentPath) { $parentPath = $full }
$parentUrl = 'file:///' + ($parentPath -replace '\\', '/')

$hwnd = $null
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 400
    try {
        $sh = New-Object -ComObject Shell.Application
        foreach ($w in @($sh.Windows())) {
            $u = ([string]$w.LocationURL).TrimEnd('/')
            if ($u -ieq $wantUrl.TrimEnd('/') -or $u -ieq $parentUrl.TrimEnd('/')) { $hwnd = [IntPtr]$w.HWND; break }
        }
    } catch { }
    if ($hwnd) { break }
}
if (-not $hwnd) { Write-Output "窗口已启动，但没枚举到（可能已经开着，按 Alt+Tab 找找）"; exit 0 }
Start-Sleep -Milliseconds $WaitMs

# --- 3. 提到前台（关键：先 AttachThreadInput 挂到当前前台线程）---------------
try {
    $fg = [SW]::GetForegroundWindow()
    $fgThread = [SW]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
    $myThread = [SW]::GetCurrentThreadId()
    [void][SW]::AttachThreadInput($myThread, $fgThread, $true)
    if ([SW]::IsIconic($hwnd)) { [void][SW]::ShowWindow($hwnd, 9) }   # SW_RESTORE
    [void][SW]::ShowWindow($hwnd, 5)                                   # SW_SHOW
    [void][SW]::BringWindowToTop($hwnd)
    $ok = [SW]::SetForegroundWindow($hwnd)
    [void][SW]::AttachThreadInput($myThread, $fgThread, $false)
    Start-Sleep -Milliseconds 300
    if ([SW]::GetForegroundWindow() -eq $hwnd) {
        Write-Output "✓ 已把它提到前台（HWND=$hwnd）"
    } else {
        Write-Output "窗口已创建但没能提到前台（HWND=$hwnd，SetForegroundWindow=$ok）—— 按 Alt+Tab 即可"
    }
} catch {
    Write-Output "提到前台时出错：$($_.Exception.Message)（窗口本身是开着的，按 Alt+Tab 找它）"
}
