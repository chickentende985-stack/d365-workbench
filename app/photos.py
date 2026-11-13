# -*- coding: utf-8 -*-
"""照片文件夹（和以前脚本一样的规则）。

总文件夹下面每台机一个子文件夹，命名“机台号_机型_吨位_工作时间”，例如 SY215C12345_SY215C_22_120.5h；
里面放 1.jpg～5.jpg（jpg / jpeg / png 都行，大小写不限）：
  1 铭牌、2 整机远照、3 工时照、4 其他照片（防锈有 5 号时：3、4 都是工时照，5 是其他照片）。
总文件夹本身就是一台机的文件夹（没有子文件夹）也可以。
"""
import base64
import os
import re

PHOTO_KEYS = ('1', '2', '3', '4', '5')
EXTS = ('.jpg', '.jpeg', '.png')


def parse_folder_name(name):
    parts = [p.strip() for p in str(name).split('_')]
    full = len(parts) >= 4
    hours = parts[-1] if full else ''
    m = re.match(r'^\d+(?:[.,]\d+)?', hours)
    return {
        'machineNo': parts[0] if parts else '',
        'model': '_'.join(parts[1:-2]) if full else (parts[1] if len(parts) == 3 else (parts[1] if len(parts) > 1 else '')),
        'tonnage': parts[-2] if full else (parts[2] if len(parts) == 3 else ''),
        'hours': m.group(0).replace(',', '.') if m else '',
        'formatOk': full and all(parts),
    }


def photo_files(path):
    """文件夹里的 1～5 号照片：{'1': '1.JPG', ...}（按 jpg、jpeg、png 的顺序取第一个）。"""
    try:
        names = {n.lower(): n for n in os.listdir(path) if os.path.isfile(os.path.join(path, n))}
    except OSError:
        return {}
    found = {}
    for key in PHOTO_KEYS:
        for ext in EXTS:
            actual = names.get(key + ext)
            if actual:
                found[key] = actual
                break
    return found


def scan(root):
    """返回 {机号大写: {dir, path, model, tonnage, hours, formatOk, files}}。"""
    root = str(root or '').strip().strip('"')
    if not root:
        return {}
    if not os.path.isdir(root):
        raise FileNotFoundError('找不到文件夹：%s' % root)
    result = {}
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        if name.startswith('.') or not os.path.isdir(path):
            continue
        info = parse_folder_name(name)
        if not info['machineNo']:
            continue
        info.update(dir=name, path=path, files=photo_files(path))
        result.setdefault(info['machineNo'].upper(), info)
    if not result:
        info = parse_folder_name(os.path.basename(os.path.normpath(root)))
        files = photo_files(root)
        if info['machineNo'] and (info['formatOk'] or files):
            info.update(dir=os.path.basename(os.path.normpath(root)), path=root, files=files)
            result[info['machineNo'].upper()] = info
    return result


def read_photos(folder):
    """把一台机文件夹里的照片读成 base64，送给 ops.js 上传。"""
    out = {}
    for key, name in (folder.get('files') or {}).items():
        with open(os.path.join(folder['path'], name), 'rb') as f:
            out[key] = {'name': name, 'b64': base64.b64encode(f.read()).decode('ascii')}
    return out
