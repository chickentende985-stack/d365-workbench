# -*- coding: utf-8 -*-
"""本机小网站：界面文件 + /api/<方法名>。只监听 127.0.0.1，别的电脑访问不到。"""
import json
import mimetypes
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import excel_io, paths
from .api import call, to_json


def make_server(api, port=0):
    ui_dir = os.path.realpath(paths.resource('ui'))

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, code, body, ctype, extra=None):
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _download(self, data, filename):
            from urllib.parse import quote
            self._send(200, data, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                       {'Content-Disposition': "attachment; filename*=UTF-8''%s" % quote(filename)})

        def do_GET(self):
            self.server.last_seen = time.time()
            path = self.path.split('?')[0]
            if path == '/__ping':
                return self._send(200, b'ok', 'text/plain')
            if path == '/download/template':
                return self._download(excel_io.template_bytes(), 'D365工作台-导入模板.xlsx')
            rel = path.lstrip('/') or 'index.html'
            full = os.path.realpath(os.path.join(ui_dir, rel))
            if not full.startswith(ui_dir + os.sep) or not os.path.isfile(full):
                return self._send(404, b'not found', 'text/plain')
            ctype = mimetypes.guess_type(full)[0] or 'application/octet-stream'
            if ctype.startswith('text/') or ctype.endswith('javascript'):
                ctype += '; charset=utf-8'
            with open(full, 'rb') as f:
                self._send(200, f.read(), ctype)

        def do_POST(self):
            self.server.last_seen = time.time()
            n = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(n) if n else b''
            if self.path == '/__bye':  # 界面关闭（或刷新）时发来的
                self.server.bye_at = self.server.last_seen
                return self._send(200, b'ok', 'text/plain')
            if self.path == '/download/results':
                data = json.loads(raw or b'{}')
                return self._download(excel_io.results_bytes(data.get('headers', []), data.get('rows', [])), '检查结果.xlsx')
            if not self.path.startswith('/api/'):
                return self._send(404, b'not found', 'text/plain')
            try:
                args = json.loads(raw or b'[]')
                result = call(api, self.path[5:], args if isinstance(args, list) else [args])
            except Exception as e:  # noqa: BLE001
                result = {'ok': False, 'error': str(e)}
            self._send(200, to_json(result), 'application/json; charset=utf-8')

    httpd = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    httpd.daemon_threads = True
    httpd.last_seen = time.time()
    httpd.bye_at = 0.0
    threading.Thread(target=httpd.serve_forever, name='http', daemon=True).start()
    return httpd
