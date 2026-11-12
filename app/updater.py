# -*- coding: utf-8 -*-
"""自动更新：从 GitHub Releases 取最新版，后台下载好，点一下就替换并重启。

流程：
1. 启动后（之后每 6 小时）查一次 GitHub 上最新发布的版本；
2. 比当前新就在后台下载安装包、解压到 %LOCALAPPDATA%\\D365Workbench\\update；
3. 界面上出现“重启并更新”。点了之后，启动下载好的新版本（带 --apply-update 参数）然后自己退出；
   新版本等旧版本完全退出，把自己整个文件夹复制到旧版本目录（文件被占用会重试），再从那里启动。

程序自己下载的文件不带“来自网络”的标记，所以更新后不会再弹 SmartScreen 提醒。
执行引擎（油猴脚本）本来就是每次启动在线取最新的，不需要走这里。
"""
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


def _log_update(text):
    try:
        with open(paths.data_path('logs', 'update.log'), 'a', encoding='utf-8') as f:
            f.write('%s %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), text))
    except OSError:
        pass


def _wait_pid(pid, timeout):
    """等某个进程退出（Windows）。"""
    if sys.platform != 'win32':
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                os.kill(pid, 0)
            except OSError:
                return True
            time.sleep(0.5)
        return False
    import ctypes
    synchronize = 0x00100000
    handle = ctypes.windll.kernel32.OpenProcess(synchronize, False, pid)
    if not handle:
        return True  # 已经不在了
    try:
        return ctypes.windll.kernel32.WaitForSingleObject(handle, int(timeout * 1000)) == 0
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def run_apply_update(argv):
    """由“新版本自己”执行的更新：等旧版本退出 → 把自己整个文件夹复制到旧版本目录 → 从旧目录启动新版本。

    不用 PowerShell：公司电脑的安全软件经常拦截“程序悄悄启动隐藏的 PowerShell”这种操作。
    """
    dst = argv[argv.index('--apply-update') + 1]
    pid = int(argv[argv.index('--wait-pid') + 1]) if '--wait-pid' in argv else 0
    src = os.path.dirname(os.path.abspath(sys.executable))
    _log_update('开始更新：%s → %s（等待旧版本 pid %s 退出）' % (src, dst, pid))
    if pid and not _wait_pid(pid, 90):
        _log_update('旧版本 90 秒内没有退出，继续尝试复制')
    time.sleep(1.5)
    last = None
    for attempt in range(25):
        try:
            shutil.copytree(src, dst, dirs_exist_ok=True)
            last = None
            break
        except OSError as e:  # 文件还被占用：等一下再试
            last = e
            time.sleep(2)
    if last:
        _log_update('更新失败：%s' % last)
    else:
        _log_update('新文件已复制完成（第 %d 次）' % (attempt + 1))
    exe = os.path.join(dst, EXE_NAME)
    if not os.path.isfile(exe) or last:
        exe = os.path.join(src, EXE_NAME)  # 复制失败就先从下载目录启动新版本，至少能用
    subprocess.Popen([exe], cwd=os.path.dirname(exe), close_fds=True,
                     creationflags=getattr(subprocess, 'DETACHED_PROCESS', 0))
    _log_update('已启动：%s' % exe)


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
        """启动下载好的新版本去做替换。调用方随后要让程序退出。"""
        if not self.frozen:
            raise RuntimeError('开发模式下不能自动更新')
        if self.state['status'] != 'ready' or not self._ready_dir:
            raise RuntimeError('新版本还没下载好')
        dst = os.path.dirname(sys.executable)
        new_exe = os.path.join(self._ready_dir, EXE_NAME)
        subprocess.Popen(
            [new_exe, '--apply-update', dst, '--wait-pid', str(os.getpid())],
            cwd=self._ready_dir, close_fds=True,
            creationflags=getattr(subprocess, 'DETACHED_PROCESS', 0) | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0),
        )
        log.info('启动新版本做替换：%s → %s', self._ready_dir, dst)
        self._set(status='applying')
        return True
