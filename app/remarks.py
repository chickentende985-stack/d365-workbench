# -*- coding: utf-8 -*-
"""每台机 / 每张单的完成情况和备注（你自己记的，和 D365 无关）。

存在 %LOCALAPPDATA%\\D365Workbench\\remarks.json，清除任务、升级程序都不会丢。
键是“任务开始时间|机号或单号”，同一台机在不同任务里各记各的。
"""
import json
import os
import threading
import time

from . import paths

FILE = 'remarks.json'
STATUSES = ('', 'done', 'notdone')  # '' = 跟着执行结果自动判断
_lock = threading.Lock()


def _load():
    try:
        with open(paths.data_path(FILE), encoding='utf-8') as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(data):
    tmp = paths.data_path(FILE + '.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, paths.data_path(FILE))


def get_all():
    with _lock:
        return _load()


def set_one(key, record):
    key = str(key or '').strip()
    if not key:
        raise ValueError('缺少记录的键')
    record = dict(record or {})
    status = record.get('status') or ''
    if status not in STATUSES:
        raise ValueError('完成情况只能是 完成 / 没完成')
    with _lock:
        data = _load()
        old = data.get(key, {})
        new = {
            'status': status,
            'remark': str(record.get('remark') or '')[:2000],
            'machineNo': str(record.get('machineNo') or old.get('machineNo') or ''),
            'orderNumber': str(record.get('orderNumber') or old.get('orderNumber') or ''),
            'orderId': str(record.get('orderId') or old.get('orderId') or ''),
            'title': str(record.get('title') or old.get('title') or ''),
            'stage': str(record.get('stage') or old.get('stage') or ''),
            'updatedAt': time.strftime('%Y-%m-%d %H:%M'),
        }
        if not new['status'] and not new['remark']:
            data.pop(key, None)  # 什么都没记：删掉这条
        else:
            data[key] = new
        _save(data)
        return data.get(key)
