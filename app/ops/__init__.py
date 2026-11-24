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

from .. import paths, photos

log = logging.getLogger('workbench')

OPS_JS = os.path.join(paths.APP_DIR, 'ops', 'ops.js')
STATE_FILE = 'ops-state.json'

# Excel 里的功能 → 内置流程（ops.js 里的 kind）
NATIVE_FUNCS = {
    'full|chain': 'chain',
    'full|pdi': 'pdi',
    'full|pdi-dealer': 'pdi-dealer',
    'full|pdi-dealer-nophoto': 'pdi-dealer-nophoto',
    'full|rust': 'rust',
    'full|handover': 'handover',
    'full|handover-pdi': 'handover-pdi',
    'transfer|pdi': 'pdi-transfer',
    'transfer|pdi-dealer': 'dealer-pdi-assign',
    'transfer|pdi-shipment': 'shipment-transfer',
    'rust-dispatch|rust': 'rust-dispatch',
    'equipment-change|pdi': 'equipment-change',
}
# 要用照片文件夹的流程
FOLDER_KINDS = {'chain', 'pdi', 'pdi-dealer', 'rust', 'handover'}
CHAIN_STEPS = (('pdi', '到港 PDI'), ('rust', '防锈'), ('pdi-dealer', '经销商 PDI'))
FINISHED = ('done', 'skipped', 'failed')
RETRY_DELAY = 5  # 出错后等几秒重试一次
TEMP_TAG = '[临时出错]'  # ops.js 给服务器 502/503/504、网络断开这类错误加的前缀
TEMP_RETRY_DELAYS = (15, 30, 60)  # 临时出错：等久一点，多试几次
STEP_LABELS = {
    'resolve': '找设备 / 找订单', 'prepare': '准备', 'accept': '接单', 'setOff': '出发', 'arrive': '到达',
    'photos': '上传照片', 'fields': '填字段', 'onSite': '现场完工', 'ticket': '生成服务工单', 'submit': '提交审核',
    'transfer': '转单', 'description': '写描述', 'assign': '指派', 'fill': '填设备变更',
}


def ops_source():
    with open(OPS_JS, encoding='utf-8') as f:
        return f.read()


def ops_version(source):
    m = re.search(r"const VERSION = '([\d.]+)'", source)
    return m.group(1) if m else '0'


def parse_items(job, photo_root=''):
    """把任务里粘贴的机号 / 单号变成一台一项；要照片的流程顺便把这台机的照片文件夹找好。"""
    kind = NATIVE_FUNCS[job['func']]
    fields = job.get('fields') or {}
    items = []
    if kind == 'shipment-transfer':
        for line in str(fields.get('shipOrders') or '').splitlines():
            no = line.strip()
            if no:
                items.append({'orderNumberInput': no, 'machineNo': '', 'stage': 'pending'})
    else:
        text = fields.get('pasteMachines') or fields.get('ecMachines') or ''
        for line in str(text).splitlines():
            parts = re.split(r'[\s,，;；]+', line.strip())
            parts = [p for p in parts if p]
            if not parts:
                continue
            item = {'machineNo': parts[0], 'stage': 'pending'}
            hours = next((p.rstrip('hH') for p in parts[1:] if re.match(r'^\d+(?:\.\d+)?[hH]?$', p)), None)
            if hours is not None:
                item['workingHours'] = hours
            items.append(item)
    seen = set()
    unique = []
    for it in items:
        key = it.get('orderNumberInput') or it['machineNo']
        if key.upper() in seen:
            continue
        seen.add(key.upper())
        unique.append(it)
    if kind in FOLDER_KINDS:
        folders = photos.scan(photo_root) if photo_root else {}
        for it in unique:
            f = folders.get(it['machineNo'].upper())
            if not f:
                it['stage'] = 'failed'
                it['error'] = ('照片文件夹里没有“%s_机型_吨位_工作时间”这个子文件夹' % it['machineNo']) if photo_root \
                    else '还没在“设置”里选照片总文件夹'
                continue
            it['folder'] = {k: f[k] for k in ('dir', 'path', 'model', 'tonnage', 'hours', 'files')}
    if kind == 'chain':
        expanded = []
        for it in unique:
            for sub, label in CHAIN_STEPS:
                x = json.loads(json.dumps(it))
                x.update(kind=sub, chain=True, chainLabel=label)
                expanded.append(x)
        unique = expanded
    return kind, unique


class OpsRunner:
    def __init__(self, browser, get_settings=None):
        self.browser = browser
        self.get_settings = get_settings or (lambda: {})
        self._lock = threading.RLock()
        self._thread = None
        self._pause = False
        self._skip = False
        self.state = self._load()
        if self.state:
            self.state.pop('working', None)
            self.state.pop('waiting', None)
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
            kind, items = parse_items(job, self.get_settings().get('photo_root', ''))
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
                    if self.state.get('kind') in FOLDER_KINDS:
                        self._refresh_folders()
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
                        self._log('收到跳过：%s 这一步做完就跳过（不用再点）' % (cur.get('machineNo') or cur.get('orderNumberInput')))
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
                'workingOn': self._working_text(s),
                'items': [{
                    'machineNo': (x.get('machineNo') or x.get('orderNumberInput', '')) + ('（%s）' % x['chainLabel'] if x.get('chainLabel') else ''),
                    'stage': x.get('stage', ''),
                    'error': x.get('error') or '', 'orderNumber': x.get('orderNumber') or '',
                    'skipReason': x.get('skipReason') or '', 'orderId': x.get('orderId') or '',
                } for x in s['items']],
                'log': '\n'.join(s.get('log', [])),
            }

    @staticmethod
    def _working_text(s):
        """正在做哪一项、哪一步、做了多久（一步里面的日志要等这一步做完才出来，这里先告诉你没卡住）。"""
        if s.get('status') != 'running':
            return None
        now = time.time()
        w = s.get('waiting')
        if w:
            return {'index': w['index'], 'text': '等 %d 秒后重试' % max(0, int(w['until'] - now))}
        w = s.get('working')
        if w:
            label = STEP_LABELS.get(w.get('step') or '', w.get('step') or '下一步')
            return {'index': w['index'], 'text': '正在%s… 已 %d 秒' % (label, int(now - w['since']))}
        return None

    def _refresh_folders(self):
        """继续时：之前因为找不到照片文件夹出错的，按现在的设置再找一次。"""
        root = self.get_settings().get('photo_root', '')
        try:
            folders = photos.scan(root) if root else {}
        except OSError:
            return
        for it in self.state['items']:
            f = folders.get(str(it.get('machineNo', '')).upper())
            if f:  # 文件夹里的照片可能补过：重新记一遍
                it['folder'] = {k: f[k] for k in ('dir', 'path', 'model', 'tonnage', 'hours', 'files')}

    def _ops_settings(self):
        st = self.get_settings() or {}
        return {'defaultLocation': st.get('default_location') or {}, 'ecDefaults': st.get('ec_defaults') or {}}

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

    def _wait(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            with self._lock:
                s = self.state
                if not s or self._pause or s.get('status') != 'running':
                    break
                if self._skip:  # 等重试的时候点了跳过：直接跳过这一台
                    self._skip = False
                    cur = self._current()
                    if cur:
                        cur['tries'] = 0
                        self._mark_skip(cur)
                        self._save()
                    break
            time.sleep(0.5)
        with self._lock:
            if self.state:
                self.state.pop('waiting', None)

    def _mark_skip(self, item):
        item['stage'] = 'skipped'
        item['skipReason'] = item.get('skipReason') or '你手动跳过了'
        self._log('%s：手动跳过' % (item.get('machineNo') or item.get('orderNumberInput')))

    def _spawn(self):
        if self._thread and self._thread.is_alive():
            return
        self._pause = False
        self._skip = False
        if self.state:
            self.state.pop('working', None)
            self.state.pop('waiting', None)
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
                opts = {'dryRun': bool(s.get('dryRun')), 'fields': s.get('fields') or {}, 'settings': self._ops_settings()}
            if item.get('folder') and item.get('next') == 'photos':
                try:
                    opts['photos'] = photos.read_photos(item['folder'])  # 只在上传照片这一步才读文件
                except OSError as e:
                    opts['photos'] = {}
                    log.warning('读照片失败：%s', e)
            with self._lock:
                s['working'] = {'index': idx, 'step': item.get('next') or '', 'since': time.time()}
            try:
                res = self.browser.ops_step(source, version, kind, item, opts)
            except Exception as e:  # noqa: BLE001 - 浏览器/登录问题：停下来，不算这台出错
                with self._lock:
                    s.pop('working', None)
                    s['status'] = 'paused'
                    s['pauseReason'] = str(e) or e.__class__.__name__
                    self._log('后台连不上 D365，已暂停：%s' % s['pauseReason'])
                    self._save()
                return
            retry_wait = 0
            with self._lock:
                s.pop('working', None)
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
                name = new_item.get('machineNo') or new_item.get('orderNumberInput')
                if res.get('error') and self._skip:
                    # 出错时你点了跳过：就跳过这一台，不再重试，也不把“跳过”留给下一台
                    self._skip = False
                    new_item['tries'] = 0
                    new_item['error'] = ''
                    self._mark_skip(new_item)
                elif res.get('error'):
                    tries = int(new_item.get('tries') or 0) + 1
                    temp = str(res['error']).startswith(TEMP_TAG)
                    limit = len(TEMP_RETRY_DELAYS) + 1 if temp else 2
                    if tries < limit:
                        new_item['tries'] = tries
                        retry_wait = TEMP_RETRY_DELAYS[tries - 1] if temp else RETRY_DELAY
                        if temp:
                            self._log('%s：D365 服务器暂时出错，%d 秒后重试这一步（第 %d/%d 次）' % (name, retry_wait, tries, limit - 1))
                        else:
                            self._log('%s：出错，%d 秒后重试这一步' % (name, retry_wait))
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
                if retry_wait:
                    s['waiting'] = {'index': idx, 'until': time.time() + retry_wait}
                self._save()
            if retry_wait:
                self._wait(retry_wait)  # 不占着锁等，界面照样能刷新进度；等的时候点跳过 / 暂停马上生效
