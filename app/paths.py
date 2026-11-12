# -*- coding: utf-8 -*-
"""程序资源、数据目录、设置文件和日志。

所有会变的东西（D365 登录状态、日志、执行引擎缓存、设置）都放在
%LOCALAPPDATA%\\D365Workbench 下，程序目录本身只读，升级时整个替换即可。
"""
import json
import logging
import os
import sys
from logging.handlers import RotatingFileHandler

# 打包成 exe 后，资源文件解压在 sys._MEIPASS；开发时就是代码目录
RES_DIR = getattr(sys, '_MEIPASS', os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
APP_DIR = os.path.join(RES_DIR, 'app')

DEFAULT_SETTINGS = {
    # 公司的 D365 地址
    'd365_url': 'https://sany.crm4.dynamics.com/main.aspx',
    # 执行引擎（就是油猴里那个脚本）的在线地址：每次启动先取最新版，取不到就用缓存或程序自带的
    'engine_url': 'https://gist.githubusercontent.com/chickentende985-stack/'
                  '34a655254f34696ae299d67386621d95/raw/d365-pdi-rust-batch.user.js',
    # 浏览器：auto = 先 Edge 再 Chrome
    'browser_channel': 'auto',
    # 后台执行时是否显示执行窗口（排查问题时打开）
    'show_worker': False,
    # 自动更新：从这个 GitHub 仓库的 Releases 取新版本（要是公开仓库）
    'update_repo': 'chickentende985-stack/d365-workbench',
}


def resource(*parts):
    return os.path.join(APP_DIR, *parts)


def data_dir():
    override = os.environ.get('D365_WORKBENCH_DATA')
    if override:
        return override
    base = os.environ.get('LOCALAPPDATA') or os.path.join(os.path.expanduser('~'), '.local', 'share')
    return os.path.join(base, 'D365Workbench')


def data_path(*parts):
    return os.path.join(data_dir(), *parts)


def ensure_dirs():
    for sub in ('', 'logs', 'engine', 'browser-profile', 'ui-profile'):
        os.makedirs(data_path(sub), exist_ok=True)


def setup_logging():
    log = logging.getLogger('workbench')
    if log.handlers:
        return log
    log.setLevel(logging.INFO)
    handler = RotatingFileHandler(data_path('logs', 'app.log'), maxBytes=1_000_000, backupCount=3, encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
    log.addHandler(handler)
    if sys.stderr:
        log.addHandler(logging.StreamHandler())
    return log


def load_settings():
    settings = dict(DEFAULT_SETTINGS)
    try:
        with open(data_path('settings.json'), encoding='utf-8') as f:
            settings.update(json.load(f))
    except (OSError, ValueError):
        pass
    return settings


def save_settings(settings):
    with open(data_path('settings.json'), 'w', encoding='utf-8') as f:
        json.dump(settings, f, ensure_ascii=False, indent=2)
