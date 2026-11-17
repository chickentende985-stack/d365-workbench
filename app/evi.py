# -*- coding: utf-8 -*-
"""EVI（Fleet Management System，https://fmseu.sanygroup.com）：按机号查机器的实时位置。

登录要在弹出的浏览器窗口里自己输邮箱、密码、拖滑块；登录后 EVI 把一个令牌（user-token）放在网页里，
工作台把它记下来（存在 %LOCALAPPDATA%\\D365Workbench\\evi.json），之后直接用它调 EVI 的接口，不用再开网页。
用到的接口（和 EVI 网页自己调的一样，只读）：
  /api/fms/clusterDynamic/getMachineInfoByKeyword  按机号找设备（拿登录号 loginId）
  /api/fms/clusterDynamic/getRealTimeData           这台机的实时数据：经纬度、最后上报时间、在线、总工时
  /api/fms/user/queryDeviceList                     账号下所有设备（里面有所在国家 / 郡 / 区，缓存半小时）
地址：用经纬度去 OpenStreetMap 查一下街道地址（查不到也没关系，地图链接照样能用）。
"""
import json
import logging
import re
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from . import APP_VERSION, paths

log = logging.getLogger('workbench')

EVI_BASE = 'https://fmseu.sanygroup.com'
TOKEN_FILE = 'evi.json'


class EviNeedLogin(Exception):
    pass


def _parse_tags(text):
    """deviceTags 是这样的字符串：{nation:GB,"nationName:United Kingdom",region1:GB-ESX,"region1Name:East Sussex",...}"""
    out = {}
    for key, value in re.findall(r'"?(nationName|region1Name|region2Name|region3Name):([^",}]*)"?', str(text or '')):
        out[key] = value.strip()
    return out


class Evi:
    def __init__(self, browser):
        self.browser = browser
        self._lock = threading.Lock()
        self._devices = None
        self._devices_at = 0
        self._addr_cache = {}
        self.state = self._load()

    # ---- 令牌 ----
    def _load(self):
        try:
            with open(paths.data_path(TOKEN_FILE), encoding='utf-8') as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def _save(self):
        with open(paths.data_path(TOKEN_FILE), 'w', encoding='utf-8') as f:
            json.dump(self.state, f, ensure_ascii=False)

    def status(self):
        return {'loggedIn': bool(self.state.get('token')), 'user': self.state.get('user', ''), 'savedAt': self.state.get('savedAt', '')}

    def login(self):
        info = self.browser.evi_login(EVI_BASE)
        self.state = {'token': info['token'], 'user': info.get('user', ''), 'savedAt': time.strftime('%Y-%m-%d %H:%M')}
        self._save()
        self._devices = None
        return self.status()

    def logout(self):
        self.state = {}
        self._save()

    # ---- 接口 ----
    def _request(self, path, method='GET', params=None, body=None, timeout=30):
        token = self.state.get('token')
        if not token:
            raise EviNeedLogin('还没登录 EVI，请点右上角“登录 EVI”')
        url = EVI_BASE + path + ('?' + urllib.parse.urlencode(params) if params else '')
        headers = {
            'Authorization': token, 'Accept-Language': 'en-US', 'new-flag-header': 'true', 'version': '1.0.0',
            'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 D365Workbench/%s' % APP_VERSION,
        }
        data = None
        if body is not None:
            data = json.dumps(body).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                payload = json.loads(r.read().decode('utf-8') or '{}')
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise EviNeedLogin('EVI 登录已过期，请点右上角“登录 EVI”重新登录')
            raise RuntimeError('EVI 返回 HTTP %s' % e.code)
        code = str(payload.get('statusCodeValue') or '')
        if code in ('401', '403') or 'hasn\'t token' in json.dumps(payload):
            raise EviNeedLogin('EVI 登录已过期，请点右上角“登录 EVI”重新登录')
        return payload.get('body', payload)

    def _device_tags(self, serial):
        with self._lock:
            if self._devices is None or time.time() - self._devices_at > 1800:
                rows = self._request('/api/fms/user/queryDeviceList', 'POST', body={}, timeout=60) or []
                self._devices = {str(r.get('serialNo', '')).upper(): r for r in rows if isinstance(r, dict)}
                self._devices_at = time.time()
            return self._devices.get(serial.upper())

    def _address(self, lat, lng):
        key = (round(lat, 4), round(lng, 4))
        if key in self._addr_cache:
            return self._addr_cache[key]
        addr = ''
        try:
            url = 'https://nominatim.openstreetmap.org/reverse?' + urllib.parse.urlencode(
                {'format': 'jsonv2', 'lat': lat, 'lon': lng, 'zoom': 18, 'accept-language': 'en'})
            req = urllib.request.Request(url, headers={'User-Agent': 'D365Workbench/%s (SANY UK internal tool)' % APP_VERSION})
            with urllib.request.urlopen(req, timeout=8) as r:
                addr = json.loads(r.read().decode('utf-8')).get('display_name', '')
        except Exception as e:  # noqa: BLE001 - 查不到地址不影响
            log.info('查地址失败：%s', e)
        self._addr_cache[key] = addr
        return addr

    def locate(self, serial):
        serial = str(serial or '').strip().upper()
        if not serial:
            raise ValueError('没填机号')
        found = self._request('/api/fms/clusterDynamic/getMachineInfoByKeyword', params={'keyword': serial}) or []
        if not isinstance(found, list):
            found = []
        hit = next((x for x in found if str(x.get('serialNo', '')).upper() == serial), None) \
            or next((x for x in found if str(x.get('loginId', '')).upper() == serial), None)
        if not hit:
            return {'found': False, 'serial': serial,
                    'similar': [x.get('serialNo') for x in found[:8] if x.get('serialNo')]}
        login_id = hit.get('loginId') or serial
        d = self._request('/api/fms/clusterDynamic/getRealTimeData', params={'loginId': login_id}) or {}
        lat = _num(d.get('latitude'))
        lng = _num(d.get('longitude'))
        has_pos = lat is not None and lng is not None and not (lat == 0 and lng == 0)
        tags = {}
        try:
            tags = _parse_tags((self._device_tags(hit.get('serialNo') or serial) or {}).get('deviceTags'))
        except EviNeedLogin:
            raise
        except Exception as e:  # noqa: BLE001
            log.info('读设备所在地区失败：%s', e)
        region = ', '.join(dict.fromkeys(v for v in (tags.get('region3Name'), tags.get('region2Name'),
                                                     tags.get('region1Name'), tags.get('nationName')) if v))
        return {
            'found': True, 'serial': hit.get('serialNo') or serial, 'loginId': login_id,
            'model': d.get('machineTypeName', ''), 'online': bool(d.get('isOnLine')),
            'lat': lat if has_pos else None, 'lng': lng if has_pos else None,
            'positionTime': _ms_to_text(d.get('receiveTimeValidLal')), 'reportTime': _ms_to_text(d.get('receiveTime')),
            'positionAgeDays': _age_days(d.get('receiveTimeValidLal')),
            'totalHours': _num(d.get('totalWorkTime')), 'region': region,
            'address': self._address(lat, lng) if has_pos else '',
            'mapUrl': 'https://www.google.com/maps?q=%s,%s' % (lat, lng) if has_pos else '',
        }


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _ms_to_text(v):
    n = _num(v)
    if not n:
        return ''
    return datetime.fromtimestamp(n / 1000).strftime('%Y-%m-%d %H:%M')


def _age_days(v):
    n = _num(v)
    if not n:
        return None
    return round((time.time() * 1000 - n) / 86400000, 1)
