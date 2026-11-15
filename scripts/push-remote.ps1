# Đẩy migration lên database Supabase remote đã có schema nhưng thiếu lịch sử migration.
#
#   1. Đọc thông tin kết nối từ .env.remote (git bỏ qua theo .gitignore: .env.*)
#      Thiếu mật khẩu trong file thì hỏi (gõ ẩn). Không in, không lưu mật khẩu ra đâu cả.
#   2. Dò remote đã có tới migration nào (CHỈ ĐỌC) qua psql trong container Supabase local
#   3. Kiểm phần đã có là một dãy liên tục từ đầu; lệch thì DỪNG, không sửa gì
#   4. migration repair --status applied cho phần đã có (chỉ ghi lịch sử, không chạy SQL)
#   5. db push phần còn thiếu (CLI liệt kê và hỏi Y/n trước khi áp)
#
# Chuẩn bị:  copy scripts\remote.env.example .env.remote  → điền mật khẩu
# Chạy:      powershell -ExecutionPolicy Bypass -File scripts/push-remote.ps1
param(
  [string]$EnvFile = ".env.remote",
  [string]$DbContainer = "supabase_db_pos-rental-supabase"
)
$ErrorActionPreference = "Stop"
# PowerShell 5.1 mặc định đẩy chuỗi sang lệnh ngoài bằng ASCII → chữ có dấu trong truy vấn dò bị hỏng
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Set-Location (Split-Path $PSScriptRoot -Parent)

# ---- 1. Thông tin kết nối ----------------------------------------------------
$cfg = @{}
if (Test-Path $EnvFile) {
  foreach ($line in Get-Content -Encoding UTF8 $EnvFile) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$' -and $line -notmatch '^\s*#') {
      $cfg[$Matches[1]] = $Matches[2].Trim('"').Trim("'")
    }
  }
} else {
  Write-Host "Không thấy $EnvFile — dùng biến môi trường / hỏi trực tiếp." -ForegroundColor Yellow
}
function Get-Setting($name, $default) {
  if ($cfg[$name]) { return $cfg[$name] }
  $v = [Environment]::GetEnvironmentVariable($name)
  if ($v) { return $v }
  return $default
}
$Ref        = Get-Setting "SUPABASE_REMOTE_REF" ""
$PoolerHost = Get-Setting "SUPABASE_REMOTE_POOLER_HOST" ""
$Port       = Get-Setting "SUPABASE_REMOTE_PORT" "5432"
$plain      = Get-Setting "SUPABASE_REMOTE_DB_PASSWORD" ""
if (-not $Ref -or -not $PoolerHost) { Write-Host "Thiếu SUPABASE_REMOTE_REF / SUPABASE_REMOTE_POOLER_HOST trong $EnvFile." -ForegroundColor Red; exit 1 }
if (-not $plain) {
  $secure = Read-Host "Mật khẩu database của project $Ref" -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
$url = "postgresql://postgres.${Ref}:$([uri]::EscapeDataString($plain))@${PoolerHost}:${Port}/postgres"
$plain = $null
Write-Host "Project: $Ref  ($PoolerHost`:$Port)" -ForegroundColor Cyan

# ---- 2. Dò -------------------------------------------------------------------
$probe = (Get-Content -Raw -Encoding UTF8 "supabase/snippets/probe_remote_migrations.sql") -replace "select version, ok from p order by version;", "select version || '|' || ok from p order by version;"
Write-Host "`nĐang dò schema remote (chỉ đọc)..." -ForegroundColor Cyan
$rows = $probe | docker exec -i $DbContainer psql $url -X -At -v ON_ERROR_STOP=1 -f - 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "Không dò được:`n$rows" -ForegroundColor Red; exit 1 }

$probes = @{}
foreach ($r in $rows) { if ($r -match '^(\d{14})\|(t|f|true|false)$') { $probes[$Matches[1]] = ($Matches[2] -in @('t', 'true')) } }
if ($probes.Count -eq 0) { Write-Host "Kết quả dò rỗng:`n$rows" -ForegroundColor Red; exit 1 }
$probes.GetEnumerator() | Sort-Object Name | ForEach-Object { "{0}  {1}" -f $_.Name, $(if ($_.Value) { "có" } else { "chưa" }) }

# ---- 3. Phải là dãy liên tục từ đầu ----------------------------------------
$sorted = $probes.Keys | Sort-Object
$lastApplied = $null; $seenMissing = $false
foreach ($v in $sorted) {
  if ($probes[$v]) {
    if ($seenMissing) { Write-Host "`nDỪNG: $v có trên remote nhưng migration trước nó lại chưa có. Schema remote không theo thứ tự — cần xem tay." -ForegroundColor Red; exit 1 }
    $lastApplied = $v
  } else { $seenMissing = $true }
}

$files = Get-ChildItem supabase/migrations/*.sql | ForEach-Object { $_.Name.Substring(0, 14) } | Sort-Object
$toRepair = if ($lastApplied) { $files | Where-Object { $_ -le $lastApplied } } else { @() }
$toPush = $files | Where-Object { -not $lastApplied -or $_ -gt $lastApplied }

Write-Host "`nRemote đã có tới: $(if ($lastApplied) { $lastApplied } else { '(chưa có gì)' })" -ForegroundColor Cyan
Write-Host "Ghi lịch sử 'đã áp' (không chạy SQL): $($toRepair.Count) migration"
Write-Host "Sẽ push (chạy SQL): $($toPush.Count) migration`n  $($toPush -join "`n  ")"
if ((Read-Host "`nTiếp tục? (y/N)") -ne "y") { Write-Host "Đã hủy, chưa sửa gì."; exit 0 }

# ---- 4. Ghi lịch sử ---------------------------------------------------------
if ($toRepair.Count -gt 0) {
  supabase migration repair --status applied @toRepair --db-url $url
  if ($LASTEXITCODE -ne 0) { Write-Host "migration repair lỗi, dừng." -ForegroundColor Red; exit 1 }
}

# ---- 5. Push phần còn thiếu (CLI tự hỏi Y/n) --------------------------------
supabase db push --db-url $url
exit $LASTEXITCODE
