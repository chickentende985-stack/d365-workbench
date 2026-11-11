# -*- coding: utf-8 -*-
"""D365 工作台入口（打包后就是 D365Workbench.exe）。"""
import os
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from app import paths  # noqa: E402


def main():
    paths.ensure_dirs()
    log = paths.setup_logging()
    try:
        from app.main import run
        run(sys.argv[1:])
    except Exception:  # noqa: BLE001 - 写进崩溃记录，再弹窗告诉你
        text = traceback.format_exc()
        log.error('程序异常退出：\n%s', text)
        with open(paths.data_path('logs', 'app-crash.log'), 'w', encoding='utf-8') as f:
            f.write(text)
        if sys.platform == 'win32':
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, '程序出错退出了，请把这段截图发给开发者：\n\n' + text[-1500:], 'D365 工作台', 0x10)
        raise


if __name__ == '__main__':
    main()
