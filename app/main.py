# -*- coding: utf-8 -*-
"""D365 工作台主程序。

界面：本机起一个小网站，用 Edge 的“应用模式”打开（没有地址栏，看起来就是一个软件窗口）。
后台：Playwright 驱动一个隐藏的 Edge 保持 D365 登录、读数据、执行任务（见 browser.py）。
关掉工作台窗口，程序就退出（界面每 5 秒报一次平安，超过 30 秒没消息就当窗口关了）。
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

IDLE_EXIT = 30      # 界面这么久没消息就退出
FIRST_CONTACT = 180  # 启动后这么久界面都没连上，也退出（窗口没打开）


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
    edge = find_edge()
    if edge:
        subprocess.Popen([
            edge, '--app=%s' % url, '--user-data-dir=%s' % paths.data_path('ui-profile'),
            '--window-size=1320,880', '--no-first-run', '--no-default-browser-check',
        ])
        log.info('用 Edge 应用窗口打开界面：%s', url)
    else:
        webbrowser.open(url)
        log.info('没找到 Edge，用默认浏览器打开：%s', url)


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
    if args.web:
        webbrowser.open(url)
    elif not args.no_window:
        open_window(url)

    started = time.time()
    first_seen = httpd.last_seen
    try:
        while True:
            time.sleep(1)
            contacted = httpd.last_seen > first_seen
            idle = time.time() - httpd.last_seen
            if contacted and idle > IDLE_EXIT:
                log.info('界面 %d 秒没有消息，退出', IDLE_EXIT)
                break
            if not contacted and time.time() - started > FIRST_CONTACT and not args.no_window:
                log.info('界面一直没有打开，退出')
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
