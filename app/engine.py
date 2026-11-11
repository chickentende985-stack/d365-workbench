# -*- coding: utf-8 -*-
"""执行引擎 = 油猴里的“D365 PDI/防锈批量建单”脚本。

工作台不重写建单、转移、交机这些流程，而是把同一个脚本注入到 D365 窗口里运行，
所以油猴版修好的问题，这里自动也修好了。

启动时在后台取 Gist 上的最新版；取不到（没网、公司代理拦截）就用缓存或程序自带的那份。
"""
import logging
import os
import re
import threading
import urllib.request

from . import paths

log = logging.getLogger('workbench')

BUNDLED = os.path.join(paths.APP_DIR, 'engine', 'd365-pdi-rust-batch.user.js')
CACHED = paths.data_path('engine', 'd365-pdi-rust-batch.user.js')


def version_of(source):
    m = re.search(r'@version\s+([\d.]+)', source or '')
    return tuple(int(x) for x in m.group(1).split('.')) if m else (0,)


def version_text(source):
    return '.'.join(str(x) for x in version_of(source))


def _read(path):
    try:
        with open(path, encoding='utf-8') as f:
            return f.read()
    except OSError:
        return ''


class Engine:
    def __init__(self, url):
        self.url = url
        self.lock = threading.Lock()
        bundled, cached = _read(BUNDLED), _read(CACHED)
        self.source = cached if version_of(cached) > version_of(bundled) else bundled
        self.origin = '缓存' if self.source is cached and cached else '程序自带'

    @property
    def version(self):
        return version_text(self.source)

    def refresh_async(self, on_done=None):
        threading.Thread(target=self._refresh, args=(on_done,), daemon=True).start()

    def _refresh(self, on_done):
        try:
            req = urllib.request.Request(self.url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'D365Workbench'})
            with urllib.request.urlopen(req, timeout=15) as resp:
                text = resp.read().decode('utf-8')
            if '==UserScript==' not in text:
                raise ValueError('下载内容不是执行脚本')
            with self.lock:
                if version_of(text) > version_of(self.source):
                    self.source, self.origin = text, '在线最新'
                    with open(CACHED, 'w', encoding='utf-8') as f:
                        f.write(text)
                    log.info('执行引擎已更新到 %s', version_text(text))
                elif version_of(text) == version_of(self.source):
                    self.origin = '在线最新'
        except Exception as error:  # noqa: BLE001 - 没网时照样能用
            log.warning('取在线执行引擎失败（继续用%s的 %s）：%s', self.origin, self.version, error)
        if on_done:
            on_done()
