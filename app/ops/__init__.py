# -*- coding: utf-8 -*-
"""工作台内置的操作逻辑（不再依赖油猴脚本）。

具体每一步怎么调 D365 接口写在 ops.js 里（在后台的 D365 页面里运行，带你的登录状态）；
这里负责“排队一台一台做、每做完一步就存盘、暂停 / 继续 / 跳过”。
程序关掉再打开，会从存盘的那一步接着做。
"""
import json
import logging
import os
import re
import threading
import time

from .. import paths

log = logging.getLogger('workbench')

OPS_JS = os.path.join(paths.APP_DIR, 'ops', 'ops.js')
STATE_FILE = 'ops-state.json'

# Excel 里的功能 → 内置流程
NATIVE_FUNCS = {
    'full|handover-pdi': 'handover-pdi',
    'transfer|pdi-shipment': 'shipment-transfer',
}
FINISHED = ('done', 'skipped', 'failed')
RETRY_DELAY = 5  # 出错后等几秒重试一次


def ops_source():
    with open(OPS_JS, encoding='utf-8') as f:
        return f.read()


def ops_version(source):
    m = re.search(r"const VERSION = '([\d.]+)'", source)
    return m.group(1) if m else '0'


def parse_items(job):
    """把任务里粘贴的机号 / 单号变成一台一项。"""
    kind = NATIVE_FUNCS[job['func']]
    fields = job.get('fields') or {}
    items = []
    if kind == 'shipment-transfer':
        for line in str(fields.get('shipOrders') or '').splitlines():
            no = line.strip()
            if no:
                items.append({'orderNumberInput': no, 'machineNo': '', 'stage': 'pending'})
    else:
        for line in str(fields.get('pasteMachines') or '').splitlines():
            parts = line.split()
            if not parts:
                continue
            item = {'machineNo': parts[0], 'stage': 'pending'}
            if len(parts) > 1:
                item['workingHours'] = parts[1]
            items.append(item)
    seen = set()
    unique = []
    for it in items:
        key = it.get('orderNumberInput') or it['machineNo']
        if key.upper() in seen:
            continue
        seen.add(key.upper())
        unique.append(it)
    return kind, unique


class OpsRunner:
    def __init__(self, browser):
        self.browser = browser
        self._lock = threading.RLock()
        self._thread = None
        self._pause = False
        self._skip = False
        self.state = self._load()
        if self.state and self.state.get('status') == 'running':
            # 上次程序关掉时还在跑：先停着，等你点“继续”（避免一打开程序就自动改数据）
            self.state['status'] = 'paused'
            self.state['pauseReason'] = '程序重新打开了，点“继续”接着做'
            self._save()

    # ---- 存盘 ----
    def _load(self):
        try:
            with open(paths.data_path(STATE_FILE), encoding='utf-8') as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def _save(self):
        tmp = paths.data_path(STATE_FILE + '.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(self.state, f, ensure_ascii=False, indent=1)
        os.replace(tmp, paths.data_path(STATE_FILE))

    def _log(self, text):
        line = '%s %s' % (time.strftime('%H:%M:%S'), text)
        self.state.setdefault('log', []).append(line)
        self.state['log'] = self.state['log'][-400:]
        log.info('[内置] %s', text)

    # ---- 对外 ----
    def running(self):
        return bool(self.state and self.state.get('status') == 'running')

    def start(self, job, dry_run=False):
        with self._lock:
            if self.running():
                raise RuntimeError('后台已经有任务在跑，等它做完或先暂停')
            kind, items = parse_items(job)
            if not items:
                raise RuntimeError('任务里没有机号 / 单号')
            self.state = {
                'engine': 'native', 'kind': kind, 'title': job.get('title') or kind, 'func': job['func'],
                'fields': job.get('fields') or {}, 'dryRun': bool(dry_run), 'status': 'running',
                'items': items, 'currentIndex': 0, 'log': [], 'createdAt': time.strftime('%Y-%m-%d %H:%M:%S'),
                'pauseReason': '',
            }
            self._log('开始%s：%s，共 %d 项' % ('演练（只读，不改 D365）' if dry_run else '执行', self.state['title'], len(items)))
            self._save()
            self._spawn()
            return {'ok': True, 'count': len(items), 'dryRun': bool(dry_run)}

    def control(self, action):
        with self._lock:
            if not self.state:
                raise RuntimeError('没有任务')
            if action == 'pause':
                if self.running():
                    self._pause = True
                    self._log('收到暂停：做完当前这一步就停')
                return True
            if action == 'resume':
                if self.state['status'] in ('paused', 'completed') and self._next_index() is not None:
                    self.state['status'] = 'running'
                    self.state['pauseReason'] = ''
                    retry = 0
                    for it in self.state['items']:
                        if it.get('stage') == 'failed':  # 出错的那几台：从出错的那一步重做
                            it['stage'] = 'retry'
                            it['error'] = ''
                            retry += 1
                    self._log('继续' + ('（重做出错的 %d 项）' % retry if retry else ''))
                    self._save()
                    self._spawn()
                return True
            if action == 'skip':
                cur = self._current()
                if cur:
                    if self.running():
                        self._skip = True
                    else:
                        self._mark_skip(cur)
                        self._save()
                return True
            if action == 'clear':
                if self.running():
                    raise RuntimeError('任务还在跑，先暂停')
                self.state = None
                try:
                    os.remove(paths.data_path(STATE_FILE))
                except OSError:
                    pass
                return True
        raise ValueError('不支持的操作：%s' % action)

    def snapshot(self):
        with self._lock:
            s = self.state
            if not s:
                return None
            return {
                'engine': 'native', 'status': s['status'], 'title': s.get('title'), 'dryRun': s.get('dryRun'),
                'createdAt': s.get('createdAt', ''),
                'currentIndex': s.get('currentIndex', 0), 'pauseReason': s.get('pauseReason', ''),
                'items': [{
                    'machineNo': x.get('machineNo') or x.get('orderNumberInput', ''), 'stage': x.get('stage', ''),
                    'error': x.get('error') or '', 'orderNumber': x.get('orderNumber') or '',
                    'skipReason': x.get('skipReason') or '', 'orderId': x.get('orderId') or '',
                } for x in s['items']],
                'log': '\n'.join(s.get('log', [])),
            }

    # ---- 执行 ----
    def _current(self):
        i = self.state.get('currentIndex', 0)
        items = self.state['items']
        return items[i] if 0 <= i < len(items) else None

    def _next_index(self):
        for i, it in enumerate(self.state['items']):
            if it.get('stage') not in ('done', 'skipped'):
                return i
        return None

    def _mark_skip(self, item):
        item['stage'] = 'skipped'
        item['skipReason'] = item.get('skipReason') or '你手动跳过了'
        self._log('%s：手动跳过' % (item.get('machineNo') or item.get('orderNumberInput')))

    def _spawn(self):
        if self._thread and self._thread.is_alive():
            return
        self._pause = False
        self._skip = False
        self._thread = threading.Thread(target=self._run, name='ops', daemon=True)
        self._thread.start()

    def _run(self):
        try:
            self._loop()
        except Exception as e:  # noqa: BLE001
            log.exception('内置任务出错')
            with self._lock:
                self.state['status'] = 'paused'
                self.state['pauseReason'] = '后台出错：%s' % e
                self._log('后台出错，已暂停：%s' % e)
                self._save()

    def _loop(self):
        source = ops_source()
        version = ops_version(source)
        while True:
            with self._lock:
                s = self.state
                if not s or s['status'] != 'running':
                    return
                if self._pause:
                    self._pause = False
                    s['status'] = 'paused'
                    s['pauseReason'] = '你点了暂停'
                    self._log('已暂停')
                    self._save()
                    return
                idx = None
                for i, it in enumerate(s['items']):
                    if it.get('stage') not in FINISHED:
                        idx = i
                        break
                if idx is None:
                    s['status'] = 'completed'
                    n = {k: sum(1 for x in s['items'] if x.get('stage') == k) for k in FINISHED}
                    self._log('全部做完：完成 %d，跳过 %d，出错 %d' % (n['done'], n['skipped'], n['failed']))
                    self._save()
                    return
                s['currentIndex'] = idx
                item = dict(s['items'][idx])
                kind = s['kind']
                opts = {'dryRun': bool(s.get('dryRun')), 'fields': s.get('fields') or {}}
            try:
                res = self.browser.ops_step(source, version, kind, item, opts)
            except Exception as e:  # noqa: BLE001 - 浏览器/登录问题：停下来，不算这台出错
                with self._lock:
                    s['status'] = 'paused'
                    s['pauseReason'] = str(e) or e.__class__.__name__
                    self._log('后台连不上 D365，已暂停：%s' % s['pauseReason'])
                    self._save()
                return
            retry_wait = False
            with self._lock:
                new_item = res.get('item') or item
                for line in res.get('logs') or []:
                    self._log(line)
                if res.get('pause'):
                    s['items'][idx] = new_item
                    s['status'] = 'paused'
                    s['pauseReason'] = res['pause']
                    self._save()
                    return
                if res.get('error') and re.search(r'\b401\b|Unauthorized|not authenticated', res['error'], re.I):
                    s['items'][idx] = new_item
                    s['status'] = 'paused'
                    s['pauseReason'] = 'D365 登录过期了，请点右上角“登录 D365”后再点“继续”'
                    self._log(s['pauseReason'])
                    self._save()
                    return
                if res.get('error'):
                    tries = int(new_item.get('tries') or 0) + 1
                    if tries < 2:
                        new_item['tries'] = tries
                        self._log('%s：出错，%d 秒后重试这一步' % (new_item.get('machineNo') or new_item.get('orderNumberInput'), RETRY_DELAY))
                        retry_wait = True
                    else:
                        new_item['stage'] = 'failed'
                        new_item['error'] = res['error']
                        new_item['tries'] = 0
                else:
                    new_item['tries'] = 0
                    if res.get('done'):
                        self._skip = False
                    elif self._skip:
                        self._skip = False
                        self._mark_skip(new_item)
                s['items'][idx] = new_item
                self._save()
            if retry_wait:
                time.sleep(RETRY_DELAY)  # 不占着锁等，界面照样能刷新进度
