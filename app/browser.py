# -*- coding: utf-8 -*-
"""用 Playwright 驱动本机自带的 Edge（没有就用 Chrome），在后台保持 D365 登录并执行任务。

- 登录：第一次弹出一个看得见的 Edge 窗口，你自己登录（含 MFA）；成功后窗口自动关掉，
  之后浏览器在后台隐藏运行，登录状态保存在 %LOCALAPPDATA%\\D365Workbench\\browser-profile。
- 读数据：在 D365 同源页面里用 fetch 调 Web API，带的是你的登录状态，和平时打开 D365 一样。
- 执行：后台开一个 D365 执行页面，执行引擎（油猴那个脚本）自动注入到这个页面里；
  工作台把任务送进去并自动开始，页面里弹出的确认框由这里自动点“确定”。

Playwright 的同步 API 只能在创建它的线程里用，所以所有浏览器操作都放在一个专用线程里排队执行。
空闲时这个线程也要不停“泵”一下 Playwright，否则页面弹出的确认框没人处理，引擎会卡住。
"""
import collections
import json
import logging
import queue
import threading
import time
from concurrent.futures import Future
from urllib.parse import urlparse

from . import paths

log = logging.getLogger('workbench')


class NeedLogin(Exception):
    pass


STATE_KEY = 'd365-pdi-rust-batch:state:v1'
ACCEPT_HEADERS = {
    'Accept': 'application/json',
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0',
}
FETCH_JS = """
async ([url, headers, method, body]) => {
  const opt = { headers, credentials: 'include', method: method || 'GET' };
  if (body !== null && body !== undefined) opt.body = body;
  const r = await fetch(url, opt);
  return { status: r.status, ct: r.headers.get('content-type') || '', body: await r.text() };
}
"""
# 隐藏运行时把 UA 里的 “Headless” 去掉，避免 D365 把它当成不支持的浏览器
HEADLESS_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
               'Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0')


def _channels(pref):
    if pref and pref != 'auto':
        return [None if pref == 'chromium' else pref]
    return ['msedge', 'chrome', None]


class Browser:
    def __init__(self, get_settings, engine):
        self.get_settings = get_settings
        self.engine = engine
        self.profile = paths.data_path('browser-profile')
        self.state_file = paths.data_path('d365-session.json')
        self.dialogs = collections.deque(maxlen=30)
        self._q = queue.Queue()
        self._pw = None
        self._ctx = None
        self._headed = False
        self._api_page = None
        self._work_page = None
        threading.Thread(target=self._loop, name='browser', daemon=True).start()

    # ---------- 线程调度 ----------
    def _loop(self):
        while True:
            try:
                fn, fut = self._q.get(timeout=0.3)
            except queue.Empty:
                self._pump()
                continue
            if fn is None:
                self._close()
                if self._pw:
                    try:
                        self._pw.stop()
                    except Exception:  # noqa: BLE001
                        pass
                fut.set_result(None)
                return
            try:
                fut.set_result(fn())
            except BaseException as e:  # noqa: BLE001 - 原样交回调用方
                fut.set_exception(e)

    def _pump(self):
        """空闲时让 Playwright 处理页面事件（确认框、页面关闭等）。"""
        page = self._work_page or self._api_page
        if page is not None and not page.is_closed():
            try:
                page.wait_for_timeout(50)
            except Exception:  # noqa: BLE001
                pass

    def _run(self, fn, timeout=300):
        fut = Future()
        self._q.put((fn, fut))
        return fut.result(timeout)

    def shutdown(self):
        try:
            self._run(None, timeout=15)
        except Exception:  # noqa: BLE001
            pass

    # ---------- 浏览器（只在工作线程里调用） ----------
    def _base(self):
        u = urlparse(self.get_settings()['d365_url'])
        return '%s://%s' % (u.scheme, u.netloc)

    def _close(self):
        if self._ctx:
            try:
                self._ctx.storage_state(path=self.state_file)
            except Exception:  # noqa: BLE001
                pass
            try:
                self._ctx.close()
            except Exception:  # noqa: BLE001
                pass
        self._ctx = None
        self._api_page = None
        self._work_page = None

    def _on_dialog(self, dialog):
        self.dialogs.append({'time': time.strftime('%H:%M:%S'), 'type': dialog.type, 'message': dialog.message[:500]})
        log.info('页面弹窗（自动确定）：%s %s', dialog.type, dialog.message[:200])
        try:
            dialog.accept()
        except Exception:  # noqa: BLE001
            pass

    def _hook_page(self, page):
        page.on('dialog', self._on_dialog)

    def _launch(self, headed):
        self._close()
        if not self._pw:
            from playwright.sync_api import sync_playwright
            self._pw = sync_playwright().start()
        settings = self.get_settings()
        last = None
        for ch in _channels(settings.get('browser_channel', 'auto')):
            kw = dict(user_data_dir=self.profile, headless=not headed, accept_downloads=True,
                      args=['--disable-blink-features=AutomationControlled'])
            if headed:
                kw['no_viewport'] = True
            else:
                kw['viewport'] = {'width': 1440, 'height': 900}
                kw['user_agent'] = HEADLESS_UA
            if ch:
                kw['channel'] = ch
            try:
                self._ctx = self._pw.chromium.launch_persistent_context(**kw)
                break
            except Exception as e:  # noqa: BLE001 - 这个浏览器没装，换下一个
                last = e
        if not self._ctx:
            raise RuntimeError('没有找到可用的浏览器（Edge 或 Chrome）。\n%s' % last)
        self._headed = headed
        # 持久化目录不保存会话 Cookie，把上次保存的补回去
        try:
            with open(self.state_file, encoding='utf-8') as f:
                cookies = json.load(f).get('cookies', [])
            if cookies:
                self._ctx.add_cookies(cookies)
        except (OSError, ValueError):
            pass
        except Exception:  # noqa: BLE001
            pass
        self._ctx.on('page', self._hook_page)
        for page in self._ctx.pages:
            self._hook_page(page)
        log.info('浏览器已启动（%s，%s）', ch or 'chromium', '显示窗口' if headed else '后台')
        return self._ctx

    def _ensure(self):
        want_headed = bool(self.get_settings().get('show_worker'))
        if self._ctx is None or self._headed != want_headed:
            self._launch(want_headed)
        return self._ctx

    def _goto_d365(self, page, url):
        host = urlparse(self._base()).netloc
        try:
            page.goto(url, wait_until='domcontentloaded', timeout=60000)
        except Exception:  # noqa: BLE001 - 跳转中断不要紧，下面看最后停在哪
            pass
        deadline = time.time() + 30
        while urlparse(page.url).netloc != host and time.time() < deadline:
            try:  # 停在微软登录页、要输账号密码 = 没法自动登录
                if page.locator('input[type=email]:visible, input[type=password]:visible').count():
                    break
            except Exception:  # noqa: BLE001
                pass
            page.wait_for_timeout(500)
        if urlparse(page.url).netloc != host:
            raise NeedLogin('D365 未登录或登录已过期，请点“登录 D365”')

    def _api(self):
        page = self._api_page
        host = urlparse(self._base()).netloc
        if page is None or page.is_closed() or urlparse(page.url).netloc != host:
            ctx = self._ensure()
            page = ctx.new_page()
            try:
                self._goto_d365(page, self._base() + '/')
                page.goto(self._base() + '/api/data/v9.2/WhoAmI', wait_until='domcontentloaded', timeout=60000)
            except Exception:
                page.close()
                raise
            self._api_page = page
        return page

    def _work(self):
        page = self._work_page
        host = urlparse(self._base()).netloc
        if page is None or page.is_closed() or urlparse(page.url).netloc != host:
            ctx = self._ensure()
            page = ctx.new_page()
            # 执行引擎只注入到这个执行页面（读数据用的页面不注入，避免两个页面同时去跑同一个任务）
            page.add_init_script(
                'if (location.host === %s) {\n' % json.dumps(host) + self.engine.source + '\n}'
            )
            self._goto_d365(page, self.get_settings()['d365_url'])
            self._work_page = page
        # 等执行引擎在页面里启动
        for _ in range(120):
            if page.evaluate('() => !!window.__d365BatchBridge'):
                return page
            page.wait_for_timeout(500)
        raise RuntimeError('执行引擎 60 秒内没有在 D365 页面里启动')

    def _fetch(self, path, method='GET', body=None, headers=None):
        page = self._api()
        hdr = dict(ACCEPT_HEADERS, **(headers or {}))
        if body is not None:
            hdr['Content-Type'] = 'application/json; charset=utf-8'
        r = page.evaluate(FETCH_JS, [self._base() + '/api/data/v9.2/' + path, hdr, method, body])
        if r['status'] == 401 or (r['status'] < 400 and r['body'] and 'json' not in r['ct']):
            self._api_page = None
            raise NeedLogin('D365 拒绝访问（HTTP %s），请重新登录' % r['status'])
        return {'status': r['status'], 'body': r['body']}

    # ---------- 对外接口（任意线程） ----------
    def login(self, timeout=300):
        """弹出看得见的浏览器让你登录；能调通 D365 API 后保存登录状态并关窗，之后在后台运行。"""
        def fn():
            ctx = self._launch(headed=True)
            host = urlparse(self._base()).netloc
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            try:
                page.goto(self.get_settings()['d365_url'], wait_until='domcontentloaded', timeout=60000)
            except Exception:  # noqa: BLE001
                pass
            page.bring_to_front()
            deadline = time.time() + timeout
            while time.time() < deadline:
                if page.is_closed():
                    self._close()
                    raise NeedLogin('登录窗口被关闭了')
                if urlparse(page.url).netloc == host:
                    try:
                        r = page.evaluate(FETCH_JS, [self._base() + '/api/data/v9.2/WhoAmI', ACCEPT_HEADERS, 'GET', None])
                        if r['status'] == 200:
                            self._close()  # 保存登录状态并关窗，之后在后台运行
                            return True
                    except Exception:  # noqa: BLE001 - 页面还在跳转
                        pass
                page.wait_for_timeout(1500)
            self._close()
            raise NeedLogin('%s 分钟内没有完成登录' % (timeout // 60))
        return self._run(fn, timeout=timeout + 90)

    def fetch(self, path, method='GET', body=None, headers=None):
        return self._run(lambda: self._fetch(path, method, body, headers), timeout=180)

    def status(self):
        def fn():
            r = self._fetch('WhoAmI')
            if r['status'] != 200:
                return {'loggedIn': False}
            user_id = json.loads(r['body'])['UserId']
            me = self._fetch('systemusers(%s)?$select=fullname' % user_id)
            name = json.loads(me['body']).get('fullname', '') if me['status'] == 200 else ''
            return {'loggedIn': True, 'userId': user_id, 'user': name}
        try:
            return self._run(fn, timeout=120)
        except NeedLogin as e:
            return {'loggedIn': False, 'error': str(e)}

    def engine_eval(self, js_function, arg=None, timeout=120):
        """在后台的 D365 执行页面里执行一段函数，例如 '(job) => window.__d365BatchBridge.loadJob(job)'。"""
        return self._run(lambda: self._work().evaluate(js_function, arg), timeout=timeout)

    def engine_state(self):
        """读执行进度：直接读 D365 同源页面的 localStorage，不打扰正在跑的执行页面。"""
        def fn():
            raw = self._api().evaluate('(k) => localStorage.getItem(k)', STATE_KEY)
            log_text = ''
            page = self._work_page
            if page is not None and not page.is_closed():
                try:
                    log_text = page.evaluate('() => window.__d365BatchBridge ? window.__d365BatchBridge.logText() : ""')
                except Exception:  # noqa: BLE001 - 页面正在跳转
                    pass
            return raw, log_text
        raw, log_text = self._run(fn, timeout=60)
        state = json.loads(raw) if raw else None
        if state:
            state = {
                'status': state.get('status'),
                'currentIndex': state.get('currentIndex', 0),
                'items': [{
                    'machineNo': x.get('machineNo', ''), 'stage': x.get('stage', ''), 'error': x.get('error') or '',
                    'orderNumber': x.get('orderNumber') or '', 'skipReason': x.get('skipReason') or '',
                } for x in state.get('items') or []],
            }
        return {'state': state, 'log': log_text, 'dialogs': list(self.dialogs),
                'workerRunning': self._work_page is not None, 'headed': self._headed}

    def ensure_worker(self):
        """确保后台执行页面开着（有未完成任务时，引擎会在页面里自动继续）。"""
        return self._run(lambda: bool(self._work()), timeout=180)

    def relaunch(self):
        """切换显示/隐藏执行窗口：重启浏览器。进行中的任务保存在 D365 页面的本地存储里，重开后会自动继续。"""
        def fn():
            had_worker = self._work_page is not None
            self._close()
            self._ensure()
            if had_worker:
                self._work()
            return True
        return self._run(fn, timeout=240)
