# -*- coding: utf-8 -*-
"""不需要 D365 的基础测试（CI 每次打包前跑）。"""
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ['D365_WORKBENCH_DATA'] = tempfile.mkdtemp()

from app import excel_io, paths  # noqa: E402
from app.api import Api  # noqa: E402
from app.engine import Engine, version_of  # noqa: E402
from app.server import make_server  # noqa: E402


class FakeBrowser:
    def status(self):
        return {'loggedIn': True, 'user': '测试', 'userId': 'u1'}

    def fetch(self, path, method='GET', body=None, headers=None):
        return {'status': 200, 'body': json.dumps({'path': path, 'method': method})}

    def engine_state(self):
        return {'state': None, 'log': '', 'dialogs': [], 'workerRunning': False, 'headed': False}

    def has_worker(self):
        return False

    def ops_step(self, source, version, kind, item, opts):
        # 模拟 ops.js：每台三步；机号 BAD 第二步出错，机号 SKIP 第一步跳过，机号 STOP 暂停一次
        item = dict(item)
        step = int(item.get('step') or 0)
        self.calls = getattr(self, 'calls', []) + [(item.get('machineNo'), step, opts['dryRun'])]
        if item.get('machineNo') == 'SKIP':
            item['stage'] = 'skipped'
            item['skipReason'] = '没有 PDI'
            return {'item': item, 'logs': ['跳过'], 'done': True}
        if item.get('machineNo') == 'BAD' and step == 1:
            return {'item': item, 'logs': ['出错'], 'done': False, 'error': '坏了'}
        if item.get('machineNo') == 'STOP' and step == 1 and not item.get('paused'):
            item['paused'] = True
            return {'item': item, 'logs': ['要填联系人'], 'done': False, 'pause': '要填联系人'}
        item['step'] = step + 1
        item['stage'] = 'done' if step + 1 >= 3 else 'working'
        return {'item': item, 'logs': ['第 %d 步' % (step + 1)], 'done': step + 1 >= 3}


class FakeApp:
    def __init__(self):
        self.settings = paths.load_settings()
        self.engine = Engine(self.settings['engine_url'])
        self.browser = FakeBrowser()
        from app.ops import OpsRunner
        self.ops = OpsRunner(self.browser)


class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        paths.ensure_dirs()
        cls.httpd = make_server(Api(FakeApp()))
        cls.base = 'http://127.0.0.1:%d' % cls.httpd.server_address[1]

    def post(self, name, *args):
        req = urllib.request.Request('%s/api/%s' % (self.base, name), data=json.dumps(list(args)).encode(), method='POST')
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())

    def _wait_ops(self, runner, timeout=30):
        deadline = time.time() + timeout
        while runner.running() and time.time() < deadline:
            time.sleep(0.05)
        return runner.snapshot()

    def test_ops_runner(self):
        from app import ops
        ops.RETRY_DELAY = 0  # 重试不用真等
        b = FakeBrowser()
        r = ops.OpsRunner(b)
        job = {'func': 'full|handover-pdi', 'title': 't', 'fields': {'pasteMachines': 'A1 10\nSKIP\nBAD\nSTOP\na1'}}
        r.start(job, dry_run=True)
        snap = self._wait_ops(r)
        self.assertEqual(snap['status'], 'paused')
        self.assertEqual(snap['pauseReason'], '要填联系人')
        self.assertEqual([x['stage'] for x in snap['items']], ['done', 'skipped', 'failed', 'working'])
        self.assertEqual(len(snap['items']), 4)  # a1 和 A1 重复，只算一次
        self.assertTrue(all(c[2] for c in b.calls))
        self.assertIn('坏了', snap['items'][2]['error'])
        r.control('resume')
        snap = self._wait_ops(r)
        self.assertEqual(snap['status'], 'completed')
        self.assertEqual(snap['items'][3]['stage'], 'done')
        # 存盘：重新创建 runner 能读回来
        r2 = ops.OpsRunner(b)
        self.assertEqual(r2.snapshot()['items'][0]['stage'], 'done')
        r2.control('clear')
        self.assertIsNone(ops.OpsRunner(b).snapshot())

    def _photo_root(self):
        root = tempfile.mkdtemp()
        d = os.path.join(root, 'SY215C123_SY215C_22_120.5h')
        os.makedirs(d)
        for n in ('1.JPG', '2.jpeg', '3.jpg', '4.png', 'note.txt'):
            with open(os.path.join(d, n), 'wb') as f:
                f.write(b'x')
        os.makedirs(os.path.join(root, 'TH936ABC_STH_9'))  # 旧格式：没有工时
        return root

    def test_photos_scan(self):
        from app import photos
        root = self._photo_root()
        found = photos.scan(root)
        f = found['SY215C123']
        self.assertEqual((f['model'], f['tonnage'], f['hours'], f['formatOk']), ('SY215C', '22', '120.5', True))
        self.assertEqual(sorted(f['files']), ['1', '2', '3', '4'])
        self.assertEqual(found['TH936ABC']['hours'], '')
        self.assertEqual(photos.read_photos(f)['1']['b64'], 'eA==')
        with self.assertRaises(FileNotFoundError):
            photos.scan(os.path.join(root, 'nope'))

    def test_parse_chain_and_folder(self):
        from app import ops
        root = self._photo_root()
        kind, items = ops.parse_items({'func': 'full|chain', 'fields': {'pasteMachines': 'SY215C123\nMISSING1'}}, root)
        self.assertEqual(kind, 'chain')
        self.assertEqual([x.get('kind') for x in items], ['pdi', 'rust', 'pdi-dealer'] * 2)
        self.assertEqual(items[0]['folder']['model'], 'SY215C')
        self.assertEqual(items[3]['stage'], 'failed')
        kind, items = ops.parse_items({'func': 'equipment-change|pdi', 'fields': {'ecMachines': 'A1 12h\nB2, 3'}})
        self.assertEqual((kind, items[0]['workingHours'], items[1]['workingHours']), ('equipment-change', '12', '3'))

    def test_photos_sent_only_for_photo_step(self):
        from app import ops
        root = self._photo_root()

        class B:
            seen = []

            def ops_step(self, source, version, kind, item, opts):
                B.seen.append((item.get('next'), sorted((opts.get('photos') or {}).keys())))
                item = dict(item)
                n = int(item.get('step') or 0) + 1
                item['step'] = n
                item['next'] = ['resolve', 'photos', 'fields', ''][n]
                item['stage'] = 'done' if n >= 3 else 'x'
                return {'item': item, 'logs': [], 'done': n >= 3}

            def has_worker(self):
                return False

        r = ops.OpsRunner(B(), lambda: {'photo_root': root})
        r.start({'func': 'full|pdi', 'fields': {'pasteMachines': 'SY215C123'}})
        self._wait_ops(r)
        self.assertEqual(B.seen, [(None, []), ('photos', ['1', '2', '3', '4']), ('fields', [])])
        r.control('clear')

    def test_settings_api(self):
        r = self.post('settings_set', {'photo_root': ' "C:\\x" ', 'ec_defaults': {'ecRemark': 'r'}, 'evil': 1})
        self.assertTrue(r['ok'])
        self.assertEqual(r['value']['photo_root'], 'C:\\x')
        self.assertEqual(r['value']['ec_defaults']['ecRemark'], 'r')
        self.assertNotIn('evil', r['value'])

    def test_remarks(self):
        r = self.post('remark_set', 't1|SY1', {'status': 'notdone', 'remark': '缺照片', 'machineNo': 'SY1', 'title': '交机'})
        self.assertTrue(r['ok'])
        self.assertEqual(self.post('remarks_get')['value']['t1|SY1']['remark'], '缺照片')
        self.assertFalse(self.post('remark_set', 't1|SY1', {'status': 'maybe'})['ok'])
        self.post('remark_set', 't1|SY1', {'status': '', 'remark': ''})  # 清空就删掉
        self.assertNotIn('t1|SY1', self.post('remarks_get')['value'])

    def test_export_xlsx(self):
        body = json.dumps({'filename': '结果/1', 'headers': ['机号', '完成情况'], 'rows': [['SY1', '没完成'], ['SY2', '完成']]}).encode()
        req = urllib.request.Request(self.base + '/download/results', data=body, method='POST')
        with urllib.request.urlopen(req, timeout=10) as r:
            self.assertIn('xlsx', r.headers['Content-Disposition'])
            data = r.read()
        import io
        import openpyxl
        ws = openpyxl.load_workbook(io.BytesIO(data)).active
        self.assertEqual(ws['B2'].value, '没完成')
        self.assertEqual(ws['A2'].fill.fgColor.rgb, '00FDE2E1')

    def test_ops_parse_shipment(self):
        from app import ops
        kind, items = ops.parse_items({'func': 'transfer|pdi-shipment', 'fields': {'shipOrders': '5226 \n\n5227'}})
        self.assertEqual(kind, 'shipment-transfer')
        self.assertEqual([x['orderNumberInput'] for x in items], ['5226', '5227'])

    def test_ops_js_present(self):
        from app import ops
        src = ops.ops_source()
        self.assertIn('window.__wbOps', src)
        self.assertRegex(ops.ops_version(src), r'^\d+\.\d+\.\d+$')

    def test_template_roundtrip(self):
        t = excel_io.read_table_bytes('t.xlsx', excel_io.template_bytes())
        self.assertEqual(t['headers'][0], '机号')
        self.assertEqual(len(t['rows']), 3)

    def test_engine_bundled(self):
        self.assertGreaterEqual(version_of(open(paths.resource('engine', 'd365-pdi-rust-batch.user.js'), encoding='utf-8').read()), (0, 10, 2))

    def test_api(self):
        self.assertTrue(self.post('app_info')['ok'])
        self.assertEqual(self.post('d365_request', 'WhoAmI')['value']['status'], 200)
        self.assertFalse(self.post('_private')['ok'])
        self.assertEqual(self.post('schema')['value']['funcs'][0]['name'], '全流程')

    def test_static_and_download(self):
        with urllib.request.urlopen(self.base + '/', timeout=10) as r:
            self.assertIn('D365 工作台', r.read().decode('utf-8'))
        with urllib.request.urlopen(self.base + '/download/template', timeout=10) as r:
            self.assertGreater(len(r.read()), 1000)
        with self.assertRaises(Exception):
            urllib.request.urlopen(self.base + '/../app/api.py', timeout=10)


if __name__ == '__main__':
    unittest.main()


class UpdaterTests(unittest.TestCase):
    def test_versions(self):
        from app.updater import is_newer, parse_version
        self.assertEqual(parse_version('v0.10.2'), (0, 10, 2))
        self.assertTrue(is_newer('v0.10.0', '0.9.9'))
        self.assertFalse(is_newer('v0.2.1', '0.2.1'))

    def test_apply_update_copies(self):
        import tempfile
        from app import updater as up
        src, dst = tempfile.mkdtemp(), tempfile.mkdtemp()
        os.makedirs(os.path.join(src, '_internal'))
        open(os.path.join(src, up.EXE_NAME), 'w').write('new')
        open(os.path.join(src, '_internal', 'x.txt'), 'w').write('new')
        open(os.path.join(dst, up.EXE_NAME), 'w').write('old')
        launched = []
        real_exe, real_popen = sys.executable, up.subprocess.Popen
        try:
            sys.executable = os.path.join(src, up.EXE_NAME)
            up.subprocess.Popen = lambda args, **kw: launched.append(args)
            up.run_apply_update(['x', '--apply-update', dst, '--wait-pid', '0'])
        finally:
            sys.executable, up.subprocess.Popen = real_exe, real_popen
        self.assertEqual(open(os.path.join(dst, up.EXE_NAME)).read(), 'new')
        self.assertTrue(os.path.isfile(os.path.join(dst, '_internal', 'x.txt')))
        self.assertEqual(launched[0][0], os.path.join(dst, up.EXE_NAME))

    def test_download(self):
        import io
        import zipfile
        from app import updater as up
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as z:
            z.writestr('D365Workbench/D365Workbench.exe', b'MZ')
            z.writestr('D365Workbench/_internal/a.txt', b'x')
        data = buf.getvalue()
        rel = {'tag_name': 'v99.0.0', 'body': '更新说明', 'assets': [
            {'name': up.ASSET_NAME, 'browser_download_url': 'https://x/asset', 'size': len(data)}]}
        u = up.Updater(lambda: {'update_repo': 'o/r'})
        u._get = lambda url, timeout=20: io.BytesIO(json.dumps(rel).encode() if 'api.github.com' in url else data)
        s = u.check_and_download()
        self.assertEqual(s['status'], 'ready')
        self.assertEqual(s['latest'], '99.0.0')
        self.assertTrue(os.path.isfile(os.path.join(u._ready_dir, 'D365Workbench.exe')))
        with self.assertRaises(RuntimeError):  # 开发模式不能替换
            u.apply()


class UpdaterNewerReleaseTest(unittest.TestCase):
    def test_redownload_when_newer_release(self):
        import io
        import zipfile
        from app import updater as up
        def make(tag):
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, 'w') as z:
                z.writestr('D365Workbench/D365Workbench.exe', tag)
            return buf.getvalue()
        rel = {'tag_name': 'v98.0.0'}
        u = up.Updater(lambda: {'update_repo': 'o/r'})
        def get(url, timeout=20):
            data = make(rel['tag_name'])
            if 'api.github.com' in url:
                return io.BytesIO(json.dumps({'tag_name': rel['tag_name'], 'assets': [
                    {'name': up.ASSET_NAME, 'browser_download_url': 'x', 'size': len(data)}]}).encode())
            return io.BytesIO(data)
        u._get = get
        self.assertEqual(u.check_and_download()['latest'], '98.0.0')
        rel['tag_name'] = 'v99.0.0'
        s = u.check_and_download()
        self.assertEqual((s['status'], s['latest']), ('ready', '99.0.0'))
