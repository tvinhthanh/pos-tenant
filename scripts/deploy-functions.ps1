# Deploy Edge Function + đặt secret cho project remote, dùng tài khoản RIÊNG của repo này.
#
# Đọc từ .env.remote (git bỏ qua):
#   SUPABASE_REMOTE_REF       project ref
#   SUPABASE_ACCESS_TOKEN     token của tài khoản sở hữu project (supabase.com → Account → Access Tokens)
#                             CLI ưu tiên biến này hơn tài khoản đang `supabase login` → không đụng login chung
#   FN_SECRET_<TÊN>=<giá trị> mỗi dòng thành một secret <TÊN> của Edge Function (VD FN_SECRET_SMS_PROVIDER=esms)
#
# Chạy:  powershell -ExecutionPolicy Bypass -File scripts/deploy-functions.ps1
param(
  [string]$EnvFile = ".env.remote",
  [string[]]$Functions = @("send-sms", "verify-domain")
)
$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Test-Path $EnvFile)) { Write-Host "Không thấy $EnvFile." -ForegroundColor Red; exit 1 }
$cfg = [ordered]@{}
foreach ($line in Get-Content -Encoding UTF8 $EnvFile) {
  if ($line -notmatch '^\s*#' -and $line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$') {
    $cfg[$Matches[1]] = $Matches[2].Trim('"').Trim("'")
  }
}
$ref = $cfg["SUPABASE_REMOTE_REF"]
$token = $cfg["SUPABASE_ACCESS_TOKEN"]
if (-not $ref) { Write-Host "Thiếu SUPABASE_REMOTE_REF trong $EnvFile." -ForegroundColor Red; exit 1 }
if (-not $token) { Write-Host "Thiếu SUPABASE_ACCESS_TOKEN trong $EnvFile." -ForegroundColor Red; exit 1 }

# Chỉ trong tiến trình này; tắt cửa sổ là mất
$env:SUPABASE_ACCESS_TOKEN = $token
$token = $null

Write-Host "Project: $ref" -ForegroundColor Cyan
$visible = (supabase projects list 2>&1 | Out-String) -match $ref
if (-not $visible) {
  Write-Host "Token này KHÔNG thấy project $ref — dùng token của tài khoản sở hữu / thành viên Owner/Developer." -ForegroundColor Red
  exit 1
}

# ---- Secret -------------------------------------------------------------------
$secrets = @($cfg.Keys | Where-Object { $_ -like "FN_SECRET_*" -and $cfg[$_] -and $cfg[$_] -ne "..." } |
  ForEach-Object { "$($_.Substring(10))=$($cfg[$_])" })
if ($secrets.Count -gt 0) {
  Write-Host "Đặt $($secrets.Count) secret: $(($secrets | ForEach-Object { $_.Split('=')[0] }) -join ', ')"
  supabase secrets set --project-ref $ref @secrets
  if ($LASTEXITCODE -ne 0) { exit 1 }
} else {
  Write-Host "Không có dòng FN_SECRET_* nào — bỏ qua đặt secret." -ForegroundColor Yellow
}

# ---- Deploy -------------------------------------------------------------------
# verify_jwt lấy theo supabase/config.toml (send-sms = false, verify-domain = true)
supabase functions deploy @Functions --project-ref $ref
exit $LASTEXITCODE