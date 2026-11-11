// D365 工作台：数据和检查逻辑（不碰界面，方便单独测试）。
// transport(path, method, body, headers) -> { status, body }，由工作台程序在 D365 窗口里代发请求。
/* exported createLogic */
function createLogic(transport) {
  'use strict';

  const FMT = '@OData.Community.Display.V1.FormattedValue';
  const ANNOTATE = { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' };
  const esc = (s) => String(s ?? '').replace(/'/g, "''");
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const guid = (s) => String(s || '').replace(/[{}]/g, '').toLowerCase();
  const fmt = (row, key) => row?.[`${key}${FMT}`] ?? row?.[key] ?? '';
  // 名字按词搜：D365 里的名字可能有两个连续空格，整句 contains 会搜不到
  const containsEveryWord = (field, text) => `(${String(text || '').split(/\s+/).filter(Boolean)
    .map((w) => `contains(${field},'${esc(w)}')`).join(' and ')})`;

  async function request(path, { method = 'GET', body = null, headers = {} } = {}) {
    const res = await transport(path, method, body == null ? null : JSON.stringify(body), headers);
    if (res.status < 200 || res.status >= 300) {
      let message = res.body;
      try { message = JSON.parse(res.body).error.message; } catch { /* 原样 */ }
      throw new Error(`D365 ${res.status}：${String(message).slice(0, 300)}`);
    }
    return res.body ? JSON.parse(res.body) : null;
  }
  const get = (path, annotate = true) => request(path, { headers: annotate ? ANNOTATE : {} });

  // ---------- 机器查询 ----------
  const EQUIPMENT_FIELDS = [
    'mcs_equipmentid', 'mcs_name', 'mcs_productmodel', 'mcs_modelmachinetype', 'mcs_equipmenttonnage', 'mcs_status',
    'mcs_equipmenttype', 'mcs_currentworkingtime', 'mcs_handoverdate', 'mcs_warrantystatus', 'mcs_mainunitwarrantyenddate',
    'mcs_warrantypolicymonth', 'mcs_warrantypolicyvalue', 'mcs_equipmentaddress', 'mcs_equipmentcontact1', 'mcs_equipmentcontacttel',
    '_mcs_dealerid_value', '_mcs_servicedealerid_value', '_mcs_customer_value', '_mcs_actualcustomer_value',
  ];

  async function findEquipment(serial) {
    const s = String(serial || '').trim();
    if (!s) throw new Error('请输入机号');
    const data = await get(`mcs_equipments?$select=${EQUIPMENT_FIELDS.join(',')}&$filter=${encodeURIComponent(`mcs_name eq '${esc(s)}'`)}&$top=2`);
    return data.value || [];
  }

  async function searchEquipment(text) {
    const s = String(text || '').trim();
    const data = await get(`mcs_equipments?$select=mcs_name,mcs_productmodel&$filter=${encodeURIComponent(`contains(mcs_name,'${esc(s)}')`)}&$top=10`);
    return data.value || [];
  }

  const ORDER_FIELDS = [
    'mcs_consultationorderid', 'mcs_name', 'mcs_ordertype', 'mcs_preacceptancetypes', 'mcs_status', 'statecode',
    '_ownerid_value', '_mcs_engineer_value', 'createdon', 'mcs_handoverdate', 'mcs_systemrunningtime',
  ];

  async function listOrderFiles(orderId) {
    const files = [];
    for (let page = 1; page <= 5; page += 1) {
      const data = await request('mcs_QueryUploadFile', {
        method: 'POST',
        body: { EntityID: `{${guid(orderId).toUpperCase()}}`, EntityName: 'mcs_consultationorder', Page: page },
      });
      const result = JSON.parse(data?.Result || '{}');
      const rows = result.Results || [];
      files.push(...rows);
      if (!rows.length || files.length >= Number(result.TotalCount || 0)) break;
    }
    return files;
  }

  const FILE_TYPES = [['001', '铭牌'], ['002', '远照'], ['003', '工时照'], ['011', '其他'], ['118', 'Service Ticket']];
  // Service Ticket 只有 PDI(2) 和交机(3) 要；防锈(5) 不看
  function fileSummary(files, typeValue) {
    const types = new Set(files.map((f) => {
      const t = String(f.Type || '').padStart(3, '0');
      return t === '098' ? '118' : t;
    }));
    return FILE_TYPES.filter(([code]) => code !== '118' || typeValue !== 5).map(([code, label]) => ({ code, label, ok: types.has(code) }));
  }

  async function machineReport(serial) {
    const found = await findEquipment(serial);
    if (!found.length) {
      const similar = await searchEquipment(serial).catch(() => []);
      return { found: false, similar: similar.map((x) => x.mcs_name) };
    }
    const eq = found[0];
    const id = guid(eq.mcs_equipmentid);
    const [orders, ecs] = await Promise.all([
      get(`mcs_consultationorders?$select=${ORDER_FIELDS.join(',')}&$filter=${encodeURIComponent(`_mcs_equipment_value eq ${id}`)}&$orderby=createdon desc&$top=50`),
      get(`mcs_equipmentchangerequests?$select=mcs_equipmentchangerequestid,mcs_name,mcs_changestatus,createdon,_ownerid_value,cr0c0_changeremark&$filter=${encodeURIComponent(`_mcs_equipment_value eq ${id}`)}&$orderby=createdon desc&$top=20`)
        .catch(() => ({ value: [] })),
    ]);
    const orderRows = (orders.value || []).map((o) => ({
      id: guid(o.mcs_consultationorderid),
      name: o.mcs_name,
      type: fmt(o, 'mcs_ordertype'),
      typeValue: o.mcs_ordertype,
      preType: o.mcs_preacceptancetypes ? fmt(o, 'mcs_preacceptancetypes') : '',
      status: fmt(o, 'mcs_status'),
      active: o.statecode === 0,
      owner: fmt(o, '_ownerid_value'),
      engineer: fmt(o, '_mcs_engineer_value'),
      created: String(o.createdon || '').slice(0, 10),
      files: null,
    }));
    // PDI(2) / 交机(3) / 防锈(5)：看照片和 Service Ticket 齐不齐（只看最近 6 张，避免太慢）
    const toCheck = orderRows.filter((o) => [2, 3, 5].includes(o.typeValue) && o.active).slice(0, 6);
    await Promise.all(toCheck.map(async (o) => {
      try { o.files = fileSummary(await listOrderFiles(o.id), o.typeValue); } catch { o.files = null; }
    }));
    return {
      found: true,
      duplicates: found.length,
      equipment: {
        id,
        serial: eq.mcs_name,
        model: eq.mcs_productmodel || eq.mcs_modelmachinetype || '',
        tonnage: eq.mcs_equipmenttonnage ?? '',
        status: fmt(eq, 'mcs_status'),
        type: fmt(eq, 'mcs_equipmenttype'),
        hours: eq.mcs_currentworkingtime ?? '',
        handoverDate: String(eq.mcs_handoverdate || '').slice(0, 10),
        warrantyStatus: fmt(eq, 'mcs_warrantystatus'),
        warrantyEnd: String(eq.mcs_mainunitwarrantyenddate || '').slice(0, 10),
        warrantyMonth: eq.mcs_warrantypolicymonth ?? '',
        warrantyValue: eq.mcs_warrantypolicyvalue ?? '',
        address: eq.mcs_equipmentaddress || '',
        contact: [eq.mcs_equipmentcontact1, eq.mcs_equipmentcontacttel].filter(Boolean).join(' / '),
        dealer: fmt(eq, '_mcs_dealerid_value'),
        serviceDealer: fmt(eq, '_mcs_servicedealerid_value'),
        customer: fmt(eq, '_mcs_customer_value'),
        actualCustomer: fmt(eq, '_mcs_actualcustomer_value'),
        directSale: !eq._mcs_dealerid_value,
      },
      orders: orderRows,
      changes: (ecs.value || []).map((c) => ({
        id: guid(c.mcs_equipmentchangerequestid),
        name: c.mcs_name,
        status: fmt(c, 'mcs_changestatus'),
        created: String(c.createdon || '').slice(0, 10),
        owner: fmt(c, '_ownerid_value'),
        remark: c.cr0c0_changeremark || '',
      })),
    };
  }

  // ---------- 名称解析（和执行引擎同样的规则） ----------
  const cache = new Map();
  const cached = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; }));
    return cache.get(key);
  };

  function resolveDealer(value) {
    const name = String(value || '').trim();
    return cached(`dealer:${norm(name)}`, async () => {
      const filter = `statecode eq 0 and _mcs_parentdealerid_value eq null and mcs_dealertype eq 20 and (mcs_code eq '${esc(name)}' or mcs_dealercode eq '${esc(name)}' or ${containsEveryWord('mcs_name', name)})`;
      const data = await get(`mcs_agents?$select=mcs_agentid,mcs_name,mcs_code,mcs_dealercode&$filter=${encodeURIComponent(filter)}&$top=20`, false);
      let rows = data.value || [];
      const byCode = rows.filter((r) => [r.mcs_code, r.mcs_dealercode].some((c) => norm(c) === norm(name)));
      const exact = rows.filter((r) => norm(r.mcs_name) === norm(name));
      if (byCode.length === 1) rows = byCode;
      else if (exact.length) rows = exact;
      if (rows.length !== 1) {
        throw new Error(rows.length
          ? `“${name}”匹配到 ${rows.length} 个经销商：${rows.slice(0, 5).map((r) => `${r.mcs_name}（${r.mcs_code}）`).join('；')}，请填代码`
          : `找不到经销商“${name}”`);
      }
      return { id: guid(rows[0].mcs_agentid), name: rows[0].mcs_name.replace(/\s+/g, ' ').trim(), code: rows[0].mcs_code };
    });
  }

  function resolvePersonnel(value) {
    const name = String(value || '').trim();
    return cached(`person:${norm(name)}`, async () => {
      const filter = `statecode eq 0 and (${containsEveryWord('mcs_name', name)} or mcs_code eq '${esc(name)}')`;
      const data = await get(`mcs_personnels?$select=mcs_personnelid,mcs_name,mcs_code&$filter=${encodeURIComponent(filter)}&$top=20`, false);
      let rows = data.value || [];
      const exact = rows.filter((r) => norm(r.mcs_name) === norm(name) || norm(r.mcs_code) === norm(name));
      if (exact.length === 1) rows = exact;
      if (rows.length !== 1) {
        throw new Error(rows.length
          ? `“${name}”匹配到 ${rows.length} 人：${rows.slice(0, 5).map((r) => String(r.mcs_name).trim()).join('；')}，请写完整姓名或工号`
          : `找不到人员“${name}”`);
      }
      return { id: guid(rows[0].mcs_personnelid), name: String(rows[0].mcs_name).replace(/\s+/g, ' ').trim() };
    });
  }

  function equipmentBrief(serial) {
    return cached(`eq:${norm(serial)}`, async () => {
      const rows = await findEquipment(serial);
      if (!rows.length) return null;
      const eq = rows[0];
      return {
        id: guid(eq.mcs_equipmentid), serial: eq.mcs_name, model: eq.mcs_productmodel || eq.mcs_modelmachinetype || '',
        dealer: fmt(eq, '_mcs_dealerid_value'), directSale: !eq._mcs_dealerid_value, status: fmt(eq, 'mcs_status'),
        duplicates: rows.length,
      };
    });
  }

  function hasPdi(equipmentId) {
    return cached(`pdi:${equipmentId}`, async () => {
      const filter = `_mcs_equipment_value eq ${equipmentId} and mcs_ordertype eq 2 and statecode eq 0`;
      const data = await get(`mcs_consultationorders?$select=mcs_name&$filter=${encodeURIComponent(filter)}&$top=1`, false);
      return (data.value || []).length > 0;
    });
  }

  function findOrderByNumber(no) {
    return cached(`order:${norm(no)}`, async () => {
      const data = await get(`mcs_consultationorders?$select=mcs_name,mcs_preacceptancetypes,mcs_status,statecode,_ownerid_value,_mcs_equipment_value&$filter=${encodeURIComponent(`mcs_name eq '${esc(no)}'`)}&$top=2`);
      const rows = data.value || [];
      if (rows.length !== 1) return { count: rows.length };
      const o = rows[0];
      return {
        count: 1, preType: o.mcs_preacceptancetypes, preTypeText: fmt(o, 'mcs_preacceptancetypes'), status: fmt(o, 'mcs_status'),
        active: o.statecode === 0, ownerId: guid(o._ownerid_value), owner: fmt(o, '_ownerid_value'), equipment: fmt(o, '_mcs_equipment_value'),
      };
    });
  }

  // ---------- Excel 行 → 统一的字段 ----------
  function mapHeaders(headers, columns) {
    const map = {};
    const unknown = [];
    headers.forEach((h, i) => {
      const key = norm(h).replace(/[：:*]/g, '').trim();
      if (!key) return;
      const col = columns.find((c) => norm(c.header) === key || c.aliases.some((a) => norm(a) === key));
      if (col && map[col.key] === undefined) map[col.key] = i;
      else if (!col) unknown.push(h);
    });
    return { map, unknown };
  }

  function rowsToRecords(table, columns) {
    const { map, unknown } = mapHeaders(table.headers, columns);
    const records = table.rows.map((row, idx) => {
      const rec = { rowNo: idx + 2 };
      for (const c of columns) rec[c.key] = map[c.key] === undefined ? '' : String(row[map[c.key]] ?? '').trim();
      return rec;
    });
    return { records, unknown, missingColumns: ['machine', 'func'].filter((k) => map[k] === undefined) };
  }

  // 日期：Excel 的日期格子已转成 YYYY-MM-DD；手打的也认 DD/MM/YYYY（英国写法）、YYYY/MM/DD
  function parseDate(text) {
    const s = String(text || '').trim();
    if (!s) return { value: '' };
    let y; let m; let d;
    let r = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
    if (r) [, y, m, d] = r;
    else if ((r = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) [, d, m, y] = r;
    else return { error: `日期“${s}”看不懂，请写成 2026-11-10` };
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    if (date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d)) return { error: `日期“${s}”不存在` };
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (date > today) return { error: `交机日期 ${s} 在今天之后` };
    const pad = (n) => String(n).padStart(2, '0');
    return { value: `${y}-${pad(m)}-${pad(d)}` };
  }

  const EQUIPMENT_TYPE_CODES = {
    host: 10, 'second-hand machine': 20, 'sample machine': 30, 'legal machine': 40, 'trial machine': 50,
    'spare machine': 60, 'rental machine': 70, 主机: 10, 二手机: 20, 样机: 30,
  };

  // 检查一行。返回 { level: ok|warn|error, messages: [], info: '' }
  async function checkRecord(rec, funcs, ctx) {
    const errors = [];
    const warns = [];
    let info = '';
    const fdef = funcs.find((f) => norm(f.name) === norm(rec.func).replace(/\s+/g, '') || norm(f.name) === norm(rec.func) || f.func === rec.func);
    rec.funcKey = fdef?.func || '';
    rec.funcName = fdef?.name || rec.func;
    rec.needsFolder = !!fdef?.needsFolder;
    if (!rec.func) errors.push('没填“要做的事”');
    else if (!fdef) errors.push(`不认识“${rec.func}”，请从下拉里选`);

    const isShip = rec.funcKey === 'transfer|pdi-shipment';
    const isEc = rec.funcKey === 'equipment-change|pdi';
    const isHandoverPdi = rec.funcKey === 'full|handover-pdi';
    const isTransfer = rec.funcKey.startsWith('transfer|');

    // 机号
    let eq = null;
    if (!rec.machine && !isShip) errors.push('没填机号');
    if (rec.machine) {
      try {
        eq = await equipmentBrief(rec.machine);
        if (!eq) errors.push(`D365 里找不到机号 ${rec.machine}`);
        else {
          info = [eq.model, eq.directSale ? '直销' : `经销商 ${eq.dealer}`, eq.status].filter(Boolean).join('｜');
          if (eq.duplicates > 1) warns.push('这个机号在 D365 里有多条设备记录');
        }
      } catch (e) { errors.push(`查机号出错：${e.message}`); }
    }
    const dupKey = `${rec.funcKey}|${norm(rec.machine || rec.orderNo)}`;
    if (ctx.seen.has(dupKey)) warns.push(`和第 ${ctx.seen.get(dupKey)} 行重复`);
    else ctx.seen.set(dupKey, rec.rowNo);

    // 工时
    if (rec.hours) {
      const n = Number(rec.hours);
      if (!Number.isFinite(n) || n < 0) errors.push(`工时“${rec.hours}”不是数字`);
      else rec.hours = String(n);
    }

    // 各功能自己的要求
    if (isHandoverPdi) {
      const d = parseDate(rec.handoverDate);
      if (d.error) errors.push(d.error); else rec.handoverDate = d.value;
      if (eq && !eq.directSale) warns.push('这是经销商设备，交机一般由经销商做');
      if (eq) {
        try { if (!(await hasPdi(eq.id))) errors.push('这台机没有 PDI 单，没法从 PDI 拿照片和 Service Ticket'); } catch { /* 不影响 */ }
      }
    } else if (rec.handoverDate) warns.push('“交机日期”只在交机无照片里用，这行会忽略');

    if (isTransfer && !rec.transferTo) errors.push('没填“转移给”');

    if (isShip) {
      if (!rec.orderNo) errors.push('没填单号');
      else {
        try {
          const o = await findOrderByNumber(rec.orderNo);
          if (o.count !== 1) errors.push(o.count ? `单号 ${rec.orderNo} 匹配到多张订单` : `找不到单号 ${rec.orderNo}`);
          else {
            if (!o.active) errors.push(`订单 ${rec.orderNo} 已取消/停用`);
            if (o.preType !== 3) errors.push(`订单 ${rec.orderNo} 不是 Shipment PDI（是“${o.preTypeText || '空'}”）`);
            if (ctx.userId && o.ownerId && o.ownerId !== ctx.userId) warns.push(`负责人已是 ${o.owner}，执行时会跳过（已转移过）`);
            info = info || [o.equipment, o.status].filter(Boolean).join('｜');
          }
        } catch (e) { errors.push(`查单号出错：${e.message}`); }
      }
    }

    if (isEc) {
      const changes = [];
      for (const [key, label] of [['dealerMain', 'Dealer'], ['dealer', 'Service Dealer']]) {
        if (!rec[key]) continue;
        try {
          const d = await resolveDealer(rec[key]);
          rec[`${key}Resolved`] = d.name;
          changes.push(`${label}→${d.name}`);
        } catch (e) { errors.push(`${label}：${e.message}`); }
      }
      for (const [key, label] of [['engineer', '负责工程师'], ['manager', '服务经理']]) {
        if (!rec[key]) continue;
        try { await resolvePersonnel(rec[key]); } catch (e) { errors.push(`${label}：${e.message}`); }
      }
      if (rec.equipmentType) {
        const code = EQUIPMENT_TYPE_CODES[norm(rec.equipmentType)];
        if (!code) errors.push(`Equipment Type“${rec.equipmentType}”不认识`);
        else { rec.equipmentTypeCode = String(code); changes.push(`类型→${rec.equipmentType}`); }
      }
      if (rec.warrantyValue) {
        const n = Number(rec.warrantyValue);
        if (!Number.isInteger(n) || n < 0) errors.push(`质保数值“${rec.warrantyValue}”要是整数`); else changes.push(`质保数值→${n}`);
      }
      if (rec.warrantyMonth) {
        const n = Number(rec.warrantyMonth);
        if (!Number.isInteger(n) || n < 1 || n > 60) errors.push(`质保月数“${rec.warrantyMonth}”要是 1～60 的整数`); else changes.push(`质保月数→${n}`);
      }
      if (!changes.length && !errors.length) errors.push('设备变更没有要改的内容（Dealer、Service Dealer、Equipment Type、质保至少填一个）');
      if (changes.length) info = [info, changes.join('，')].filter(Boolean).join('｜');
    } else if (rec.dealer || rec.dealerMain || rec.equipmentType || rec.warrantyMonth || rec.warrantyValue) {
      warns.push('Dealer/类型/质保只在设备变更里用，这行会忽略');
    }

    if (rec.needsFolder && !errors.length) warns.push('要照片文件夹：开始前在 D365 窗口里选照片总文件夹');
    const level = errors.length ? 'error' : (warns.length ? 'warn' : 'ok');
    return { level, messages: [...errors, ...warns], info };
  }

  async function checkAll(records, funcs, { userId = '', onProgress } = {}) {
    const ctx = { seen: new Map(), userId: guid(userId) };
    const results = [];
    // 一行一行查（有缓存）；并发 4 行，避免一次打太多请求
    let next = 0;
    let done = 0;
    async function worker() {
      while (next < records.length) {
        const i = next;
        next += 1;
        try {
          results[i] = await checkRecord(records[i], funcs, ctx);
        } catch (e) {
          results[i] = { level: 'error', messages: [`检查出错：${e.message}`], info: '' };
        }
        done += 1;
        onProgress?.(done, records.length);
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    return results;
  }

  // ---------- 合成执行任务（同一功能、同一组设置的行合成一批） ----------
  function buildJobs(records, results) {
    const jobs = new Map();
    const line = (r) => (r.hours ? `${r.machine} ${r.hours}` : r.machine);
    records.forEach((r, i) => {
      if (results[i]?.level === 'error' || !r.funcKey) return;
      let key;
      let make;
      if (r.funcKey === 'full|handover-pdi') {
        key = `${r.funcKey}|${r.handoverDate}`;
        make = () => ({
          func: r.funcKey, build: 'paste', title: `交机无照片${r.handoverDate ? `（交机日期 ${r.handoverDate}）` : '（交机日期=当天）'}`,
          fields: { handoverDate: r.handoverDate || '' }, lines: [],
        });
      } else if (r.funcKey === 'equipment-change|pdi') {
        const s = [r.dealerMain, r.dealer, r.engineer, r.manager, r.remark, r.equipmentTypeCode, r.warrantyValue, r.warrantyMonth];
        key = `${r.funcKey}|${JSON.stringify(s)}`;
        make = () => {
          // “不填不改”的项要明确清空；“不填用默认”的项（工程师、经理、备注）不送，保留面板里的默认值
          const fields = {
            ecDealerMain: r.dealerMain || '', ecDealer: r.dealer || '', ecType: r.equipmentTypeCode || '',
            ecWarrantyValue: r.warrantyValue || '', ecWarrantyMonth: r.warrantyMonth || '',
          };
          if (r.engineer) fields.ecEngineer = r.engineer;
          if (r.manager) fields.ecManager = r.manager;
          if (r.remark) fields.ecRemark = r.remark;
          const parts = [r.dealerMainResolved && `Dealer ${r.dealerMainResolved}`, r.dealerResolved && `Service Dealer ${r.dealerResolved}`,
            r.equipmentType && r.equipmentType, r.warrantyMonth && `质保 ${r.warrantyMonth} 月`].filter(Boolean);
          return { func: r.funcKey, title: `设备变更：${parts.join('，') || '按面板设置'}`, fields, lines: [] };
        };
      } else if (r.funcKey === 'transfer|pdi-shipment') {
        key = `${r.funcKey}|${r.transferTo}|${r.description}`;
        make = () => ({
          func: r.funcKey, build: 'ship', title: `Shipment 转移给 ${r.transferTo}`,
          fields: { transferTarget: r.transferTo, shipDesc: r.description || '' }, lines: [],
        });
      } else {
        key = `${r.funcKey}|${r.transferTo}`;
        make = () => ({
          func: r.funcKey, title: `${r.funcName}${r.transferTo ? `（转给 ${r.transferTo}）` : ''}`, needsFolder: true,
          fields: r.transferTo ? { transferTarget: r.transferTo } : {}, lines: [],
        });
      }
      if (!jobs.has(key)) jobs.set(key, make());
      const job = jobs.get(key);
      job.lines.push(r.funcKey === 'transfer|pdi-shipment' ? r.orderNo : line(r));
      (job.rows = job.rows || []).push(r.rowNo);
    });
    return [...jobs.values()].map((job) => {
      const text = job.lines.join('\n');
      if (job.func === 'full|handover-pdi') job.fields.pasteMachines = text;
      if (job.func === 'equipment-change|pdi') job.fields.ecMachines = text;
      if (job.func === 'transfer|pdi-shipment') job.fields.shipOrders = text;
      return job;
    });
  }

  return {
    request, get, machineReport, searchEquipment, rowsToRecords, parseDate, checkRecord, checkAll, buildJobs,
    resolveDealer, resolvePersonnel, _cache: cache,
  };
}
