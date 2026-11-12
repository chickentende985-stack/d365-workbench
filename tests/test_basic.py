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


class FakeApp:
    def __init__(self):
        self.settings = paths.load_settings()
        self.engine = Engine(self.settings['engine_url'])
        self.browser = FakeBrowser()


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
