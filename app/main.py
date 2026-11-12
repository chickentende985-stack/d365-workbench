# -*- coding: utf-8 -*-
"""D365 工作台主程序。

界面：本机起一个小网站，用 Edge 的“应用模式”打开（没有地址栏，看起来就是一个软件窗口）。
后台：Playwright 驱动一个隐藏的 Edge 保持 D365 登录、读数据、执行任务（见 browser.py）。
关掉工作台窗口，程序就退出：看我们启动的那个 Edge 窗口进程还在不在。
（以前靠界面每 5 秒报平安、30 秒没消息就退出；但窗口被别的窗口挡住或最小化时，
Edge 会把后台网页的定时器放慢到一分钟一次，程序就被误判成“窗口关了”而退出。）
后台还有任务在跑时，即使窗口关了也等任务跑完再退出。
"""
import argparse
import logging
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import webbrowser

from . import APP_VERSION, paths
from .api import Api
from .browser import Browser
from .engine import Engine
from .server import make_server

log = logging.getLogger('workbench')

IDLE_EXIT = 15 * 60   # 找不到窗口进程时：界面这么久完全没消息才退出
FIRST_CONTACT = 180    # 启动后这么久界面都没连上，也退出（窗口没打开）
TASK_WAIT = 3 * 3600   # 窗口关了但后台任务还在跑：最多再等这么久


def find_edge():
    if sys.platform != 'win32':
        return shutil.which('microsoft-edge') or shutil.which('msedge')
    for base in (os.environ.get('ProgramFiles(x86)'), os.environ.get('ProgramFiles'), os.environ.get('LOCALAPPDATA')):
        if base:
            p = os.path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
            if os.path.exists(p):
                return p
    return shutil.which('msedge')


def open_window(url):
    """打开界面窗口。用 Edge 时返回那个 Edge 进程（窗口关掉它就结束），否则返回 None。"""
    edge = find_edge()
    if edge:
        proc = subprocess.Popen([
            edge, '--app=%s' % url, '--user-data-dir=%s' % paths.data_path('ui-profile'),
            '--window-size=1320,880', '--no-first-run', '--no-default-browser-check',
            '--disable-background-mode',
        ])
        log.info('用 Edge 应用窗口打开界面：%s', url)
        return proc
    webbrowser.open(url)
    log.info('没找到 Edge，用默认浏览器打开：%s', url)
    return None


def task_running(app):
    if not app.browser.has_worker():  # 后台执行页面都没开过，就不可能有任务在跑（也别为了检查去启动浏览器）
        return False
    try:
        state = app.api.engine_state().get('state')
        return bool(state and state.get('status') == 'running')
    except Exception:  # noqa: BLE001 - 读不到就当没在跑
        return False


def existing_instance():
    """程序已经开着：返回它的地址。"""
    try:
        with open(paths.data_path('app.port'), encoding='ascii') as f:
            port = int(f.read().strip())
        with urllib.request.urlopen('http://127.0.0.1:%d/__ping' % port, timeout=2) as r:
            if r.read() == b'ok':
                return 'http://127.0.0.1:%d/' % port
    except Exception:  # noqa: BLE001
        pass
    return None


class App:
    def __init__(self):
        self.settings = paths.load_settings()
        self.engine = Engine(self.settings['engine_url'])
        self.browser = Browser(lambda: self.settings, self.engine)
        self.api = Api(self)


def run(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--web', action='store_true', help='不用 Edge 应用窗口，用默认浏览器打开')
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--no-window', action='store_true', help='不打开窗口（测试用）')
    args = parser.parse_args(argv)

    url = existing_instance()
    if url:
        log.info('程序已经在运行，直接打开窗口')
        if not args.no_window:
            open_window(url)
        return

    app = App()
    app.engine.refresh_async()
    httpd = make_server(app.api, args.port)
    port = httpd.server_address[1]
    with open(paths.data_path('app.port'), 'w', encoding='ascii') as f:
        f.write(str(port))
    url = 'http://127.0.0.1:%d/' % port
    log.info('D365 工作台 %s 已启动：%s', APP_VERSION, url)
    proc = None
    if args.web:
        webbrowser.open(url)
    elif not args.no_window:
        proc = open_window(url)

    started = time.time()
    first_seen = httpd.last_seen
    closed_at = None
    last_check = 0.0
    running = False
    try:
        while True:
            time.sleep(1)
            now = time.time()
            contacted = httpd.last_seen > first_seen
            idle = now - httpd.last_seen
            if not contacted:
                if now - started > FIRST_CONTACT and not args.no_window:
                    log.info('界面一直没有打开，退出')
                    break
                continue
            if args.no_window:
                window_closed = idle > 30
            else:
                # 我们启动的 Edge 窗口进程结束 = 窗口关了；找不到进程（或 Edge 关窗后进程还挂着）时，
                # 界面 15 分钟完全没消息也算关了
                gone = proc is not None and proc.poll() is not None
                window_closed = (gone and idle > 20) or idle > IDLE_EXIT
            if not window_closed:
                closed_at = None
                continue
            if closed_at is None:
                closed_at = now
                last_check = 0.0
            if now - closed_at < TASK_WAIT:
                if now - last_check >= 30:
                    last_check = now
                    running = task_running(app)
                    if running:
                        log.info('窗口关了，但后台任务还在跑：等任务跑完再退出')
                if running:
                    continue
            log.info('窗口已关闭，退出')
            break
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
        app.browser.shutdown()
        try:
            os.remove(paths.data_path('app.port'))
        except OSError:
            pass
