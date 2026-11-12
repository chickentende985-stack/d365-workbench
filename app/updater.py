# -*- coding: utf-8 -*-
"""自动更新：从 GitHub Releases 取最新版，后台下载好，点一下就替换并重启。

流程：
1. 启动后（之后每 6 小时）查一次 GitHub 上最新发布的版本；
2. 比当前新就在后台下载安装包、解压到 %LOCALAPPDATA%\\D365Workbench\\update；
3. 界面上出现“重启并更新”。点了之后，程序启动一个小的 PowerShell 脚本然后退出；
   脚本等程序完全退出，把新文件复制到程序目录（robocopy，文件被占用会重试），再启动新版。

程序自己下载的文件不带“来自网络”的标记，所以更新后不会再弹 SmartScreen 提醒。
执行引擎（油猴脚本）本来就是每次启动在线取最新的，不需要走这里。
"""
import base64
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile

from . import APP_VERSION, paths

log = logging.getLogger('workbench')

ASSET_NAME = 'D365Workbench-windows.zip'
EXE_NAME = 'D365Workbench.exe'
CHECK_EVERY = 6 * 3600


def parse_version(text):
    m = re.search(r'(\d+(?:\.\d+)*)', str(text or ''))
    return tuple(int(x) for x in m.group(1).split('.')) if m else (0,)


def is_newer(remote, local=APP_VERSION):
    return parse_version(remote) > parse_version(local)


def apply_script(pid, src, dst, log_file):
    """生成更新脚本（PowerShell）。用 -EncodedCommand 传进去，路径里有中文、空格都没问题。"""
    q = lambda s: "'" + str(s).replace("'", "''") + "'"  # noqa: E731 - PowerShell 单引号字符串
    return '\n'.join([
        "$ErrorActionPreference = 'Continue'",
        '$log = %s' % q(log_file),
        "function Note($t) { Add-Content -Path $log -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $t) -Encoding UTF8 }",
        'Note "等待旧版本退出（pid %d）"' % pid,
        'Wait-Process -Id %d -Timeout 90 -ErrorAction SilentlyContinue' % pid,
        'Start-Sleep -Seconds 2',
        '$ok = $false',
        'for ($i = 0; $i -lt 15; $i++) {',
        '  robocopy %s %s /E /IS /IT /R:3 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null' % (q(src), q(dst)),
        '  if ($LASTEXITCODE -lt 8) { $ok = $true; break }',
        '  Note "复制失败（robocopy $LASTEXITCODE），可能文件还被占用，重试"',
        '  Start-Sleep -Seconds 2',
        '}',
        'if ($ok) { Note "新文件已复制到 %s" } else { Note "更新失败：文件一直被占用" }' % str(dst).replace('"', '`"'),
        'Start-Process -FilePath %s' % q(os.path.join(dst, EXE_NAME)),
    ])


class Updater:
    def __init__(self, get_settings):
        self.get_settings = get_settings
        self.state = {'status': 'idle', 'current': APP_VERSION, 'latest': '', 'notes': '', 'error': '', 'progress': 0}
        self._lock = threading.Lock()
        self._ready_dir = None

    @property
    def frozen(self):
        return bool(getattr(sys, 'frozen', False))

    def _set(self, **kw):
        with self._lock:
            self.state.update(kw)

    def snapshot(self):
        with self._lock:
            return dict(self.state, canApply=self.frozen)

    def start(self):
        threading.Thread(target=self._loop, name='updater', daemon=True).start()

    def _loop(self):
        time.sleep(5)  # 让程序先启动好
        while True:
            try:
                self.check_and_download()
            except Exception as e:  # noqa: BLE001 - 没网时下次再试
                log.warning('检查更新失败：%s', e)
                self._set(status='error', error=str(e))
            time.sleep(CHECK_EVERY)

    def _get(self, url, timeout=20):
        req = urllib.request.Request(url, headers={'User-Agent': 'D365Workbench/%s' % APP_VERSION,
                                                   'Accept': 'application/vnd.github+json'})
        return urllib.request.urlopen(req, timeout=timeout)

    def check_and_download(self):
        if self.state['status'] in ('downloading', 'ready'):
            return self.snapshot()
        repo = self.get_settings().get('update_repo')
        if not repo:
            return self.snapshot()
        self._set(status='checking', error='')
        with self._get('https://api.github.com/repos/%s/releases/latest' % repo) as r:
            rel = json.loads(r.read().decode('utf-8'))
        latest = rel.get('tag_name') or ''
        self._set(latest=latest.lstrip('v'), notes=(rel.get('body') or '')[:2000])
        if not is_newer(latest):
            self._set(status='latest')
            return self.snapshot()
        asset = next((a for a in rel.get('assets') or [] if a.get('name') == ASSET_NAME), None)
        if not asset:
            raise RuntimeError('新版本 %s 里没有安装包' % latest)
        self._download(latest.lstrip('v'), asset['browser_download_url'], int(asset.get('size') or 0))
        return self.snapshot()

    def _download(self, version, url, size):
        base = paths.data_path('update')
        shutil.rmtree(base, ignore_errors=True)
        os.makedirs(base, exist_ok=True)
        zip_path = os.path.join(base, ASSET_NAME)
        self._set(status='downloading', progress=0)
        log.info('下载新版本 %s', version)
        done = 0
        with self._get(url, timeout=60) as r, open(zip_path, 'wb') as f:
            while True:
                chunk = r.read(256 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if size:
                    self._set(progress=int(done * 100 / size))
        if size and done != size:
            raise RuntimeError('安装包没下载完整（%d / %d）' % (done, size))
        out = os.path.join(base, 'v' + version)
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(out)
        os.remove(zip_path)
        # 压缩包里是 D365Workbench\D365Workbench.exe
        root = os.path.join(out, 'D365Workbench')
        if not os.path.isfile(os.path.join(root, EXE_NAME)):
            raise RuntimeError('安装包里没有 %s' % EXE_NAME)
        self._ready_dir = root
        self._set(status='ready', progress=100)
        log.info('新版本 %s 已下载好：%s', version, root)

    def apply(self):
        """启动更新脚本。调用方随后要让程序退出。"""
        if not self.frozen:
            raise RuntimeError('开发模式下不能自动更新')
        if self.state['status'] != 'ready' or not self._ready_dir:
            raise RuntimeError('新版本还没下载好')
        dst = os.path.dirname(sys.executable)
        script = apply_script(os.getpid(), self._ready_dir, dst, paths.data_path('logs', 'update.log'))
        encoded = base64.b64encode(script.encode('utf-16-le')).decode('ascii')
        flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0) | getattr(subprocess, 'DETACHED_PROCESS', 0)
        subprocess.Popen(
            ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
            creationflags=flags, close_fds=True,
        )
        log.info('启动更新脚本：%s → %s', self._ready_dir, dst)
        self._set(status='applying')
        return True
