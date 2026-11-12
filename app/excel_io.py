# -*- coding: utf-8 -*-
"""Excel 模板和导入。

一行一台机，一列一个信息；空着的格子在工作台里用默认值或保持原值。
列名可以用中文或英文（见 aliases），顺序随意。
"""
import csv
import datetime as dt
import os

COLUMNS = [
    # key, 表头, 其他认得的写法, 列宽, 说明
    ('machine', '机号', ['机台号', '序列号', 'serial', 'serial number', 'serial no', 'machine', 'machine no', 'equipment'], 22,
     '必填（Shipment 转移可以只填单号）。机号后面不要带别的字'),
    ('func', '要做的事', ['功能', '操作', 'task', 'action', 'function'], 16, '必填，从下拉里选'),
    ('hours', '工时', ['工作小时', '工作时间', 'hours', 'working hours', 'operating hours'], 8,
     '交机无照片、设备变更用；不填：交机用 PDI 里的工时，设备变更用默认工时'),
    ('handoverDate', '交机日期', ['handover date', '日期'], 12, '交机无照片用；不填就是当天'),
    ('orderNo', '单号', ['订单号', 'order', 'order no', 'order number'], 14, 'Shipment 转移用：要派的单号'),
    ('description', 'Description', ['描述', '说明'], 30, 'Shipment 转移用：写进订单 Description，不填不改'),
    ('transferTo', '转移给', ['transfer to', '转派给', '派给'], 18, '服务转移/派单用：转给谁'),
    ('dealerMain', 'Dealer', ['经销商', 'dealer main'], 24, '设备变更用；不填就和 Service Dealer 一样'),
    ('dealer', 'Service Dealer', ['服务经销商'], 24, '设备变更用；不填不改'),
    ('engineer', '负责工程师', ['responsible service engineer', 'engineer', '工程师'], 20, '设备变更用；不填用默认'),
    ('manager', '服务经理', ['service manager', 'manager'], 20, '设备变更用；不填用默认'),
    ('remark', 'Change Remarks', ['变更备注', '变更说明', 'remark', 'remarks'], 22, '设备变更用；不填用默认'),
    ('equipmentType', 'Equipment Type', ['设备类型', 'type'], 20, '设备变更用；不填不改'),
    ('warrantyValue', '质保数值', ['warranty policy value', 'warranty value'], 10, '设备变更用；不填不改'),
    ('warrantyMonth', '质保月数', ['warranty policy month', 'warranty month'], 10, '设备变更用；1～60，不填不改'),
    ('note', '备注', ['note', 'notes', 'comment'], 20, '自己看的，工作台不用'),
]

FUNCS = [
    # 表格里写的, 执行引擎功能, 需要照片文件夹, 说明
    ('全流程', 'full|chain', True, '到港 PDI → 防锈 → 经销商 PDI（经销商设备才做）'),
    ('PDI', 'full|pdi', True, '到港预验收 PDI'),
    ('经销商PDI', 'full|pdi-dealer', True, '代理商入库预验收'),
    ('防锈', 'full|rust', True, '防锈运转'),
    ('交机', 'full|handover', True, '用文件夹里的照片交机'),
    ('交机无照片', 'full|handover-pdi', False, '照片和工时从这台机的 PDI 里拿'),
    ('PDI转移', 'transfer|pdi', True, 'PDI 创建 → 服务转移（要填“转移给”）'),
    ('经销商PDI派单', 'transfer|pdi-dealer', True, '经销商 PDI 创建 → Assign 派单（要填“转移给”）'),
    ('Shipment转移', 'transfer|pdi-shipment', False, '按单号写 Description 并服务转移（要填“单号”“转移给”）'),
    ('防锈派单', 'rust-dispatch|rust', True, '防锈：检查 → 派单'),
    ('设备变更', 'equipment-change|pdi', False, '新建并提交设备变更单'),
]

EQUIPMENT_TYPES = ['Host', 'Second-hand Machine', 'Sample Machine', 'Legal Machine', 'Trial Machine',
                   'Spare Machine', 'Rental Machine']


def column_defs():
    return [{'key': k, 'header': h, 'aliases': a, 'note': n} for k, h, a, _w, n in COLUMNS]


def func_defs():
    return [{'name': n, 'func': f, 'needsFolder': d, 'note': note} for n, f, d, note in FUNCS]


def _cell_text(value):
    if value is None:
        return ''
    if isinstance(value, dt.datetime):
        return value.strftime('%Y-%m-%d')
    if isinstance(value, dt.date):
        return value.strftime('%Y-%m-%d')
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else repr(value)
    return str(value).strip()


def read_table(path):
    """读 .xlsx/.xlsm/.csv，返回 {'sheet': 名字, 'headers': [...], 'rows': [[...], ...]}（全部转成文字）。"""
    ext = os.path.splitext(path)[1].lower()
    if ext == '.csv':
        raw = open(path, 'rb').read()
        for enc in ('utf-8-sig', 'gbk', 'latin-1'):
            try:
                text = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        table = [row for row in csv.reader(text.splitlines())]
        sheet = os.path.basename(path)
    else:
        from openpyxl import load_workbook
        wb = load_workbook(path, data_only=True, read_only=True)
        ws = wb['任务'] if '任务' in wb.sheetnames else wb.worksheets[0]
        sheet = ws.title
        table = [[_cell_text(v) for v in row] for row in ws.iter_rows(values_only=True)]
        wb.close()
    table = [[_cell_text(v) for v in row] for row in table]
    # 第一行非空的当表头
    while table and not any(table[0]):
        table.pop(0)
    if not table:
        return {'sheet': sheet, 'headers': [], 'rows': []}
    headers = table[0]
    rows = [r for r in table[1:] if any(c for c in r)]
    return {'sheet': sheet, 'headers': headers, 'rows': rows}


def write_template(path):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.datavalidation import DataValidation

    wb = Workbook()
    ws = wb.active
    ws.title = '任务'
    head_fill = PatternFill('solid', fgColor='1F4E79')
    for i, (_k, header, _a, width, note) in enumerate(COLUMNS, start=1):
        cell = ws.cell(row=1, column=i, value=header)
        cell.font = Font(bold=True, color='FFFFFF')
        cell.fill = head_fill
        cell.alignment = Alignment(horizontal='center', vertical='center')
        ws.column_dimensions[get_column_letter(i)].width = width
    examples = [
        {'machine': 'SYK11001AT5C03785', 'func': '交机无照片', 'hours': '2.5', 'handoverDate': '2026-11-10', 'note': '示例，可删除'},
        {'machine': 'SY005RCBA1188', 'func': '设备变更', 'hours': '3', 'dealer': 'Sleator Plant Machinery Ltd',
         'equipmentType': 'Second-hand Machine', 'warrantyMonth': '12', 'remark': 'Dealer Machines', 'note': '示例，可删除'},
        {'machine': '', 'func': 'Shipment转移', 'orderNo': '5226111404', 'description': 'Customer: ...\nETA of Delivery: ...',
         'transferTo': 'Winzar Charles', 'note': '示例，可删除'},
    ]
    keys = [c[0] for c in COLUMNS]
    for r, ex in enumerate(examples, start=2):
        for c, key in enumerate(keys, start=1):
            if key in ex:
                cell = ws.cell(row=r, column=c, value=ex[key])
                cell.font = Font(color='808080', italic=True)
    ws.freeze_panes = 'B2'

    func_col = get_column_letter(keys.index('func') + 1)
    dv = DataValidation(type='list', formula1='"' + ','.join(n for n, *_ in FUNCS) + '"', allow_blank=True)
    dv.error, dv.errorTitle = '请从下拉列表里选', '要做的事'
    ws.add_data_validation(dv)
    dv.add(f'{func_col}2:{func_col}1000')
    type_col = get_column_letter(keys.index('equipmentType') + 1)
    dv2 = DataValidation(type='list', formula1='"' + ','.join(EQUIPMENT_TYPES) + '"', allow_blank=True)
    ws.add_data_validation(dv2)
    dv2.add(f'{type_col}2:{type_col}1000')

    info = wb.create_sheet('说明')
    info.column_dimensions['A'].width = 18
    info.column_dimensions['B'].width = 70
    info.append(['怎么用', '一行一台机。只填这一行要用到的列，其余留空。灰色斜体的三行是示例，可以删掉。'])
    info.append(['', '照片还是放在文件夹里：带“要照片”的功能，开始前在 D365 窗口的面板里选照片总文件夹。'])
    info.append([])
    info.append(['要做的事', '说明'])
    for name, _f, needs_folder, note in FUNCS:
        info.append([name, note + ('（要照片文件夹）' if needs_folder else '')])
    info.append([])
    info.append(['列', '说明'])
    for _k, header, _a, _w, note in COLUMNS:
        info.append([header, note])
    for row in info.iter_rows():
        if row[0].value in ('怎么用', '要做的事', '列'):
            for cell in row:
                cell.font = Font(bold=True)
    wb.save(path)


def write_results(path, headers, rows):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    wb = Workbook()
    ws = wb.active
    ws.title = '结果'
    ws.append(headers)
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill('solid', fgColor='E8EEF4')
    red = PatternFill('solid', fgColor='FDE2E1')
    green = PatternFill('solid', fgColor='E3F4E8')
    for row in rows:
        ws.append(['' if v is None else v for v in row])
        # 有“没完成”的一行标红，“完成”标绿，打开表格一眼能看出来
        mark = red if '没完成' in row else green if '完成' in row else None
        for cell in ws[ws.max_row]:
            cell.alignment = Alignment(wrap_text=True, vertical='top')
            if mark:
                cell.fill = mark
    for i, h in enumerate(headers, start=1):
        longest = max([len(str(h))] + [len(str(r[i - 1])) for r in rows if i - 1 < len(r) and r[i - 1] is not None] or [8])
        ws.column_dimensions[get_column_letter(i)].width = min(60, max(10, longest * 1.3 + 2))
    ws.freeze_panes = 'A2'
    wb.save(path)


# ---- 网页界面用：文件内容直接走 HTTP，不用弹系统对话框 ----
def read_table_bytes(name, data):
    import tempfile
    ext = os.path.splitext(name or '')[1].lower() or '.xlsx'
    fd, tmp = tempfile.mkstemp(suffix=ext)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        result = read_table(tmp)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    result['name'] = name
    return result


def _to_bytes(writer, *args):
    import io
    buf = io.BytesIO()
    writer(buf, *args)
    return buf.getvalue()


def template_bytes():
    return _to_bytes(write_template)


def results_bytes(headers, rows):
    return _to_bytes(write_results, headers, rows)
