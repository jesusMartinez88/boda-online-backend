# ============================================================================
# dev-stripe-listen.ps1
# ----------------------------------------------------------------------------
# Arranca `stripe listen --forward-to localhost:3000/api/payments/webhook`,
# captura el `whsec_xxx` temporal que imprime la CLI, lo guarda en `.env`
# (sobreescribiendo `STRIPE_WEBHOOK_SECRET`) y mantiene el listener vivo
# hasta que pulses Ctrl+C.
#
# Al salir (Ctrl+C) restaura el valor original de STRIPE_WEBHOOK_SECRET
# que había en .env cuando se arrancó el script.
#
# Uso:
#   .\scripts\stripe-listen-dev.ps1
#   .\scripts\stripe-listen-dev.ps1 -Port 3001   # si tu backend va en otro puerto
#
# Requiere:
#   - Stripe CLI instalada y logueada (`stripe login`)
#   - Backend escuchando en localhost:<PORT>/api/payments/webhook
# ============================================================================

param(
    [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'

# Constantes de nueva línea (evitamos usar `n que rompe el parser).
$NL = [Environment]::NewLine

$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot '.env'

if (-not (Test-Path $envPath)) {
    Write-Host "❌ No se encontró .env en $envPath" -ForegroundColor Red
    exit 1
}

# 1) Backup del valor actual de STRIPE_WEBHOOK_SECRET para restaurarlo al salir.
$envContent = Get-Content $envPath -Raw
$regex = '(?m)^STRIPE_WEBHOOK_SECRET\s*=\s*(.*)$'
$match = [regex]::Match($envContent, $regex)

if (-not $match.Success) {
    Write-Host "⚠️  STRIPE_WEBHOOK_SECRET no existe en .env. Lo añadimos vacío." -ForegroundColor Yellow
    $envContent = $envContent.TrimEnd() + $NL + 'STRIPE_WEBHOOK_SECRET=' + $NL
    $originalValue = ''
} else {
    $originalValue = $match.Groups[1].Value.Trim()
}

Write-Host ''
Write-Host '================================================================' -ForegroundColor Cyan
Write-Host "  Stripe CLI - forwarding webhooks to localhost:$Port" -ForegroundColor Cyan
Write-Host '================================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host "  Backend endpoint: http://localhost:$Port/api/payments/webhook"
if ($originalValue) {
    $masked = $originalValue.Substring(0, [Math]::Min(20, $originalValue.Length)) + '...'
    Write-Host "  Original STRIPE_WEBHOOK_SECRET en .env: $masked"
} else {
    Write-Host '  Original STRIPE_WEBHOOK_SECRET en .env: (vacio)'
}
Write-Host ''
Write-Host '  Esperando Ready de Stripe CLI...' -ForegroundColor Yellow
Write-Host '  El script copiara automaticamente el whsec a .env.' -ForegroundColor Yellow
Write-Host ''
Write-Host '  Pulsa Ctrl+C para detener y restaurar el secret original.' -ForegroundColor DarkGray
Write-Host ''

# 2) Lanzar `stripe listen` capturando su salida.
$runId = "$PID-" + (Get-Random)
$tempLog = Join-Path $env:TEMP "stripe-listen-$Port-$runId.log"
$tempErr = Join-Path $env:TEMP "stripe-listen-$Port-$runId.err.log"

# `stripe` en Windows se puede instalar como `stripe.cmd` o `stripe.ps1`.
# `Start-Process -FilePath 'stripe'` falla con "%1 no es una aplicación
# Win32 válida" porque no hay un .exe; tenemos que resolver el path
# completo. Forzamos la versión .cmd porque `.ps1` tampoco arranca con
# Start-Process directamente (PowerShell 5.1 no lo trata como ejecutable).
$stripeCmd = (Get-Command 'stripe.cmd' -ErrorAction SilentlyContinue).Source
# Desde la CLI moderna, `stripe listen` exige indicar los eventos a reenviar.
# Coincidimos con los 4 eventos que gestiona el webhook del backend.
$stripeArgs = @(
    'listen',
    '--forward-to', "localhost:$Port/api/payments/webhook",
    '--events', 'payment_intent.succeeded,payment_intent.processing,payment_intent.payment_failed,payment_intent.canceled'
)

if (-not $stripeCmd) {
    # Fallback: si no hay .cmd, buscamos el .ps1 y lo invocamos a través de powershell.
    $stripePs1 = (Get-Command 'stripe' -ErrorAction SilentlyContinue).Source
    if ($stripePs1 -and $stripePs1.EndsWith('.ps1')) {
        $proc = Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $stripePs1) + $stripeArgs `
            -NoNewWindow -PassThru `
            -RedirectStandardOutput $tempLog `
            -RedirectStandardError $tempErr
    } else {
        Write-Host "❌ No se encontró la Stripe CLI en PATH. Ejecuta 'stripe --version' para diagnosticarlo." -ForegroundColor Red
        exit 1
    }
} else {
    $proc = Start-Process -FilePath $stripeCmd `
        -ArgumentList $stripeArgs `
        -NoNewWindow -PassThru `
        -RedirectStandardOutput $tempLog `
        -RedirectStandardError $tempErr
}

$secretCaptured = $false

# Cleanup al salir: restaurar el secret original y matar el árbol de procesos.
function Invoke-Cleanup {
    param([Parameter(Mandatory)]$Process,
          [Parameter(Mandatory)]$EnvPath,
          [Parameter(Mandatory)]$Regex,
          [Parameter(Mandatory)]$OriginalValue,
          [Parameter(Mandatory)]$SecretCaptured)

    Write-Host ''
    Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
    if ($SecretCaptured) {
        Write-Host '  Restaurando STRIPE_WEBHOOK_SECRET original en .env...' -ForegroundColor Yellow
        try {
            $c = Get-Content $EnvPath -Raw
            $replacement = "STRIPE_WEBHOOK_SECRET=$OriginalValue"
            $c = [regex]::Replace($c, $Regex, $replacement)
            Set-Content -Path $EnvPath -Value $c -NoNewline
            Write-Host '  OK - Restaurado.' -ForegroundColor Green
        } catch {
            Write-Host "  Error restaurando: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
    if ($null -ne $Process -and -not $Process.HasExited) {
        try {
            taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
        } catch {
            try { Stop-Process -Id $Process.Id -Force } catch {}
        }
    }
    if (Test-Path $tempLog) { Remove-Item $tempLog -Force -ErrorAction SilentlyContinue }
    if (Test-Path $tempErr) { Remove-Item $tempErr -Force -ErrorAction SilentlyContinue }
}

$logLinesProcessed = 0
$errLinesProcessed = 0

try {
    while (-not $proc.HasExited) {
        Start-Sleep -Milliseconds 600

        $outRaw = if (Test-Path $tempLog) { Get-Content $tempLog -Raw -ErrorAction SilentlyContinue } else { '' }
        $errRaw = if (Test-Path $tempErr) { Get-Content $tempErr -Raw -ErrorAction SilentlyContinue } else { '' }
        $combined = "$outRaw`n$errRaw"

        # Captura el whsec_xxx (Stripe CLI lo envia por stderr).
        if (-not $secretCaptured) {
            $whsecMatch = [regex]::Match($combined, 'whsec_[a-zA-Z0-9_]+')
            if ($whsecMatch.Success) {
                $newSecret = $whsecMatch.Value

                Write-Host "  Webhook signing secret capturado: $($newSecret.Substring(0, 14))..." -ForegroundColor Green
                Write-Host '  Actualizando .env...' -ForegroundColor Gray

                $c = Get-Content $envPath -Raw
                if ($match.Success) {
                    $c = [regex]::Replace($c, $regex, "STRIPE_WEBHOOK_SECRET=$newSecret")
                } else {
                    $c = $c.TrimEnd() + $NL + "STRIPE_WEBHOOK_SECRET=$newSecret" + $NL
                }
                Set-Content -Path $envPath -Value $c -NoNewline

                Write-Host '  OK - .env actualizado. Reinicia tu backend para que tome el nuevo secret.' -ForegroundColor Yellow
                Write-Host ''
                Write-Host '------------------------------------------------------------' -ForegroundColor Green
                Write-Host '  Listo. Stripe CLI esta reenviando eventos en vivo.' -ForegroundColor Green
                Write-Host '  Si haces un pago en el frontend, lo veras aqui abajo.' -ForegroundColor Green
                Write-Host '------------------------------------------------------------' -ForegroundColor Green
                Write-Host ''

                $secretCaptured = $true

                if (Test-Path $tempLog) {
                    $logLinesProcessed = @(Get-Content $tempLog -ErrorAction SilentlyContinue).Count
                }
                if (Test-Path $tempErr) {
                    $errLinesProcessed = @(Get-Content $tempErr -ErrorAction SilentlyContinue).Count
                }
            }
        } else {
            # A partir de aqui mostramos la salida en vivo (Stripe suele loguear eventos por stderr).
            if (Test-Path $tempErr) {
                $errLines = @(Get-Content $tempErr -ErrorAction SilentlyContinue)
                if ($errLines.Count -gt $errLinesProcessed) {
                    for ($i = $errLinesProcessed; $i -lt $errLines.Count; $i++) {
                        $line = $errLines[$i]
                        if ($line -match 'Ready!|Getting ready|whsec_') { continue }
                        if ($line.Trim().Length -gt 0) {
                            Write-Host $line
                        }
                    }
                    $errLinesProcessed = $errLines.Count
                }
            }

            if (Test-Path $tempLog) {
                $outLines = @(Get-Content $tempLog -ErrorAction SilentlyContinue)
                if ($outLines.Count -gt $logLinesProcessed) {
                    for ($i = $logLinesProcessed; $i -lt $outLines.Count; $i++) {
                        $line = $outLines[$i]
                        if ($line -match 'Checking for new versions') { continue }
                        if ($line.Trim().Length -gt 0) {
                            Write-Host $line
                        }
                    }
                    $logLinesProcessed = $outLines.Count
                }
            }
        }
    }
} finally {
    Invoke-Cleanup -Process $proc -EnvPath $envPath -Regex $regex -OriginalValue $originalValue -SecretCaptured $secretCaptured
}