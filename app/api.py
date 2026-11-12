# -*- coding: utf-8 -*-
"""工作台界面能调用的方法。界面用 POST /api/<方法名>（参数是 JSON 数组）调用。"""
import base64
import json
import logging
import threading
import webbrowser
from urllib.parse import urlparse

from . import APP_NAME, APP_VERSION, excel_io, paths
from .browser import NeedLogin

log = logging.getLogger('workbench')

ENGINE_LOAD_JS = '(job) => window.__d365BatchBridge.loadJob(job)'
CONTROL_JS = '''(id) => {
  const root = document.getElementById('d365-pdi-rust-batch');
  const el = root && (root.shadowRoot || root).getElementById(id);
  if (!el) return false;
  el.click();
  return true;
}'''


class Api:
    def __init__(self, app):
        self._app = app
        self._login_lock = threading.Lock()

    # ---- 基本信息 ----
    def app_info(self):
        a = self._app
        return {
            'name': APP_NAME, 'version': APP_VERSION,
            'engineVersion': a.engine.version, 'engineOrigin': a.engine.origin,
            'd365Url': a.settings['d365_url'], 'showWorker': bool(a.settings.get('show_worker')),
            'dataDir': paths.data_dir(),
        }

    def schema(self):
        return {'columns': excel_io.column_defs(), 'funcs': excel_io.func_defs()}

    # ---- D365 ----
    def d365_status(self):
        return self._app.browser.status()

    def d365_login(self):
        if not self._login_lock.acquire(blocking=False):
            raise RuntimeError('登录窗口已经开着了')
        try:
            self._app.browser.login()
            return self._app.browser.status()
        finally:
            self._login_lock.release()

    def d365_request(self, path, method='GET', body=None, headers=None):
        return self._app.browser.fetch(path, method, body, headers)

    def open_record(self, entity, record_id):
        """在你平时用的浏览器里打开这张单（那边你本来就登录着 D365）。"""
        u = urlparse(self._app.settings['d365_url'])
        url = '%s://%s/main.aspx?pagetype=entityrecord&etn=%s&id=%s' % (u.scheme, u.netloc, entity, record_id)
        webbrowser.open(url)
        return url

    # ---- 后台执行 ----
    def engine_load_job(self, job):
        job = dict(job or {})
        job['autoStart'] = True
        result = self._app.browser.engine_eval(ENGINE_LOAD_JS, job, timeout=180)
        log.info('送入任务：%s → %s', job.get('title'), result)
        return result

    def engine_state(self):
        return self._app.browser.engine_state()

    def engine_control(self, action):
        ids = {'pause': 'pause', 'resume': 'reauthorize', 'skip': 'skip'}
        if action not in ids:
            raise ValueError('不支持的操作：%s' % action)
        return self._app.browser.engine_eval(CONTROL_JS, ids[action], timeout=60)

    def engine_wake(self):
        """打开后台执行页面（有没做完的任务时引擎会自动继续）。"""
        return self._app.browser.ensure_worker()

    def set_show_worker(self, show):
        self._app.settings['show_worker'] = bool(show)
        paths.save_settings(self._app.settings)
        self._app.browser.relaunch()
        return bool(show)

    # ---- 自动更新 ----
    def update_status(self):
        return self._app.updater.snapshot()

    def update_check(self):
        return self._app.updater.check_and_download()

    def update_apply(self):
        from .main import task_running
        if task_running(self._app):
            raise RuntimeError('后台还有任务在跑，等跑完再更新')
        self._app.updater.apply()
        self._app.exit_requested = True
        return True

    # ---- Excel ----
    def parse_excel(self, name, data_b64):
        data = base64.b64decode(data_b64)
        return excel_io.read_table_bytes(name, data)

    def ping(self):
        return True


def call(api, method, args):
    if method.startswith('_') or not hasattr(api, method):
        raise AttributeError('没有这个功能：%s' % method)
    fn = getattr(api, method)
    try:
        return {'ok': True, 'value': fn(*(args or []))}
    except NeedLogin as e:
        return {'ok': False, 'error': str(e), 'needLogin': True}
    except Exception as e:  # noqa: BLE001 - 原样告诉界面
        log.exception('调用 %s 出错', method)
        return {'ok': False, 'error': str(e) or e.__class__.__name__}


def to_json(value):
    return json.dumps(value, ensure_ascii=False).encode('utf-8')
