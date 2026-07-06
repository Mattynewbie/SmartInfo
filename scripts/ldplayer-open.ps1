$ErrorActionPreference = "Stop"

$adb = "C:\LDPlayer\LDPlayer9\adb.exe"
$device = "emulator-5554"
$metroPort = "8082"
$voicePort = "8787"

if (-not (Test-Path -LiteralPath $adb)) {
  throw "LDPlayer adb not found at $adb"
}

& $adb -s $device reverse "tcp:$metroPort" "tcp:$metroPort" | Out-Null
& $adb -s $device reverse "tcp:$voicePort" "tcp:$voicePort" | Out-Null
& $adb -s $device shell pm grant host.exp.exponent android.permission.RECORD_AUDIO 2>$null
& $adb -s $device shell am start -a android.intent.action.VIEW -d "exp://127.0.0.1:$metroPort" host.exp.exponent
