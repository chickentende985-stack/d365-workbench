"""读照片上的文字（用 Windows 自带的 OCR：Windows.Media.Ocr，不用另外装东西）。

用途：没有照片做单时，判断别的订单上的照片有没有工程师拍照时打上的“时间 + 地点”水印
（Timestamp Camera 之类的 App 打的），见 app/ops/ops.js 的 findPhotoSource。
"""
import base64
import json
import logging
import os
import subprocess
import tempfile
import threading

log = logging.getLogger(__name__)

# PowerShell 5.1 调 WinRT：异步方法要转成 Task 再等结果
PS_SCRIPT = r'''
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) {
  $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US'))
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { '{"error":"no-engine"}'; exit }
$out = @()
foreach ($p in (Get-Content -LiteralPath $env:WB_OCR_LIST -Encoding UTF8)) {
  if (-not $p) { continue }
  try {
    $f = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile])
    $s = Await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $d = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $b = Await ($d.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $r = Await ($engine.RecognizeAsync($b)) ([Windows.Media.Ocr.OcrResult])
    $lines = @($r.Lines | ForEach-Object { $_.Text })
    $out += , @{ text = ($lines -join "`n") }
    $s.Dispose()
  } catch {
    $out += , @{ error = $_.Exception.Message }
  }
}
ConvertTo-Json -InputObject @{ results = $out } -Depth 4 -Compress
'''

_lock = threading.Lock()
_state = {'available': None}


def available():
    return os.name == 'nt' and _state['available'] is not False


def read_texts(images, timeout=120):
    """images: 照片内容（bytes）的列表。返回同样长度的列表，每项 {'text': ...} 或 {'error': ...}；
    这台电脑用不了 OCR 时返回 None。"""
    if not images:
        return []
    if os.name != 'nt' or _state['available'] is False:
        return None
    with _lock, tempfile.TemporaryDirectory(prefix='wb-ocr-') as tmp:
        paths = []
        for i, data in enumerate(images):
            p = os.path.join(tmp, '%d.jpg' % i)
            with open(p, 'wb') as f:
                f.write(data)
            paths.append(p)
        lst = os.path.join(tmp, 'list.txt')
        with open(lst, 'w', encoding='utf-8') as f:
            f.write('\n'.join(paths))
        enc = base64.b64encode(PS_SCRIPT.encode('utf-16-le')).decode('ascii')
        try:
            r = subprocess.run(
                ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
                capture_output=True, timeout=timeout, env=dict(os.environ, WB_OCR_LIST=lst),
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
        except (OSError, subprocess.TimeoutExpired) as e:
            log.warning('照片文字识别失败：%s', e)
            return None
        out = r.stdout.decode('utf-8', 'replace').strip()
        try:
            data = json.loads(out.splitlines()[-1]) if out else {}
        except ValueError:
            data = {}
        if data.get('error') == 'no-engine' or 'results' not in data:
            log.warning('这台电脑用不了 Windows OCR：%s %s', out[-300:], r.stderr.decode('utf-8', 'replace')[-500:])
            _state['available'] = False
            return None
        _state['available'] = True
        res = data['results']
        if isinstance(res, dict):  # PowerShell 只有一项时不当数组输出
            res = [res]
        return res


def read_texts_b64(items):
    """给 ops.js 调：items 是 base64 字符串列表。"""
    try:
        images = [base64.b64decode(x) for x in items or []]
    except (ValueError, TypeError):
        return None
    return read_texts(images)
