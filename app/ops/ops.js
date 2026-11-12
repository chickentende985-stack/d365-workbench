/* D365 工作台：内置操作逻辑（不再依赖油猴脚本）。
 *
 * 这里的每一步都直接调用 D365 的接口，和你在网页上点按钮时网页自己调用的接口一模一样
 * （是照着 D365 表单脚本 ConsultationOrderForm.js、地图页 NavigationPreview/Navigation/AbnormalArrival1、
 * 附件页 Uploader.html、转移页 agentservicetransfer.html 抄过来的），只是不用打开页面、不用点按钮。
 *
 * 用法：工作台把这段代码放进后台的 D365 页面（同源，带你的登录状态），然后一步一步调用：
 *   window.__wbOps.step(kind, item, opts) → { item, logs, done, pause }
 * 每次只做“下一步”，做完返回；工作台把 item 存盘后再调下一步，所以中途关掉程序也能接着做。
 *
 * opts.dryRun = true 时是“演练”：只读数据、把要写的内容记到日志里，不改 D365 里的任何东西。
 */
(() => {
  'use strict';
  const VERSION = '1.1.0';
  const ORDER = 'mcs_consultationorder';
  const ORDERS = 'mcs_consultationorders';
  const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

  // 订单状态（ConsultationOrderForm.js 里的 CO_STATUS）
  const ST = {
    Created: 10, Dispatched: 20, Transferred: 21, Refused: 29, Accepted: 30, Paused: 35, Departed: 40,
    Arrived: 50, Suspend: 65, CompletionOnSite: 70, InApproval: 80, Rejected: 81, Completed: 90, Canceled: 100,
  };
  const STATUS_TEXT = {
    10: 'Created', 20: 'Dispatched', 21: 'Transferred', 29: 'Refused', 30: 'Accepted', 35: 'Paused', 40: 'Departed',
    50: 'Arrived', 65: 'Suspend', 70: 'Completion On Site', 80: 'In Approval', 81: 'Rejected', 90: 'Completed', 100: 'Canceled',
  };
  // 订单类型（CO_TYPES）
  const TYPE = { Shipment: 1, Arrival: 2, DeliveryOrder: 3, StartupOrder: 4, RustProof: 5 };
  // 预验收类型 mcs_preacceptancetypes：1 到港，2 代理商入库，3 出库（Shipment PDI）
  const PRE_SHIPMENT = 3;
  // 操作记录 mcs_service_applog 的操作代码：10 接单 20 出发 30 到达 40 现场完工 50 服务完工
  const LOG = { accept: 10, setOff: 20, arrive: 30, onSite: 40, complete: 50 };
  const TRAVEL_GROUND = 40;          // Ground Transportation
  const ARRIVAL_ABNORMAL = 30;       // 异常到达
  const REASON_WEAK_SIGNAL = 20;     // Cell phone signal is weak（和以前脚本选的“手机 GPS 信号不佳”一样）
  const TRAINING_NO = 0;

  // 附件类型代码和英文名（Uploader 按类型给文件起的默认名）
  const FILE = {
    nameplate: { type: '001', name: 'Nameplate number', label: '铭牌号' },
    far: { type: '002', name: 'Whole machine far shot', label: '整机远照' },
    hours: { type: '003', name: 'Working hours photo', label: '工时照' },
    other: { type: '011', name: 'Other photos', label: '其他照片' },
    ticket: { type: '118', name: 'Service Ticket', label: 'Service Ticket' },
  };
  const HANDOVER_PHOTOS = [FILE.nameplate, FILE.far, FILE.hours, FILE.other];

  // ---------- 小工具 ----------
  const guid = (v) => String(v || '').replace(/[{}]/g, '').toLowerCase();
  const esc = (v) => String(v).replace(/'/g, "''");
  const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const FMT = '@OData.Community.Display.V1.FormattedValue';
  const fmt = (rec, field) => (rec ? rec[`${field}${FMT}`] || '' : '');

  class Pause extends Error {}
  class Skip extends Error {}

  function d365Error(status, text) {
    try {
      const j = JSON.parse(text);
      return j?.error?.message || text;
    } catch {
      return text || `HTTP ${status}`;
    }
  }

  async function api(path, { method = 'GET', body, headers = {}, formatted = false } = {}) {
    const h = {
      Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', ...headers,
    };
    if (formatted) h.Prefer = 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"';
    if (body !== undefined) h['Content-Type'] = 'application/json; charset=utf-8';
    const res = await fetch(`/api/data/v9.2/${path}`, {
      method, headers: h, credentials: 'include', body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(d365Error(res.status, text).slice(0, 500));
    const entityId = (res.headers.get('OData-EntityId') || '').match(/\(([0-9a-f-]{36})\)/i)?.[1] || '';
    return { data: text ? JSON.parse(text) : {}, entityId: guid(entityId) };
  }

  // 自定义接口（Action）：返回 Result 里的 JSON（有的接口 Result 是字符串里包着 JSON）
  async function action(name, params) {
    const { data } = await api(name, { method: 'POST', body: params || {} });
    let result = data?.Result;
    if (typeof result === 'string') {
      try { result = JSON.parse(result); } catch { /* 就是普通文字 */ }
    }
    return { raw: data, result };
  }

  async function query(set, select, filter, extra = '') {
    const q = `${set}?$select=${select}${filter ? `&$filter=${encodeURIComponent(filter)}` : ''}${extra}`;
    return (await api(q, { formatted: true })).data.value || [];
  }

  async function readOrder(id, select) {
    return (await api(`${ORDERS}(${guid(id)})?$select=${select}`, { formatted: true })).data;
  }

  // ---------- 执行上下文：日志、演练 ----------
  function makeCtx(item, opts) {
    const logs = [];
    const dry = Boolean(opts?.dryRun);
    item.sim ||= {};
    const ctx = {
      dry,
      opts: opts || {},
      logs,
      log: (text) => logs.push(`${item.machineNo || item.orderNumberInput || ''}：${dry ? '［演练］' : ''}${text}`),
      // 所有写操作都走这里：演练时只记日志
      async write(desc, fn, simulate) {
        if (dry) {
          ctx.log(`（不执行）${desc}`);
          if (simulate) simulate();
          return null;
        }
        return fn();
      },
    };
    return ctx;
  }

  // 订单状态：演练时用模拟的状态（假装上一步已经做了）
  async function orderStatus(item, ctx) {
    if (ctx.dry && item.sim.status !== undefined) return item.sim.status;
    const o = await readOrder(item.orderId, 'mcs_status,mcs_name');
    item.orderNumber ||= o.mcs_name || '';
    return Number(o.mcs_status);
  }
  const setSim = (item, patch) => () => Object.assign(item.sim, patch);

  let me = null;
  async function currentUser() {
    if (me) return me;
    const { data } = await api('WhoAmI');
    const id = guid(data.UserId);
    const { data: u } = await api(`systemusers(${id})?$select=fullname,domainname`);
    me = { id, name: u.fullname || '', domain: String(u.domainname || '').split('@')[0] };
    return me;
  }

  async function patchOrder(item, ctx, payload, desc) {
    await ctx.write(`${desc}：PATCH ${JSON.stringify(payload)}`, () => api(`${ORDERS}(${guid(item.orderId)})`, {
      method: 'PATCH', headers: { 'If-Match': '*' }, body: payload,
    }), () => {
      // 演练：记下“假装写了”的字段，后面的检查当它已经有值
      item.sim.fields = { ...(item.sim.fields || {}), ...payload };
      if (payload.mcs_status !== undefined) item.sim.status = payload.mcs_status;
    });
  }

  // 和网页一样写一条操作记录（失败不影响主流程）
  async function appLog(item, ctx, operation) {
    try {
      const u = await currentUser();
      const rec = {
        mcs_userid: u.id, mcs_entityname: ORDER, mcs_entityid: guid(item.orderId), mcs_name: item.orderNumber || '',
        mcs_operation: operation, mcs_operationtime: stamp(), mcs_applogsourcesystem: 1,
      };
      if (ctx.dry) return;
      await api('mcs_service_applogs', { method: 'POST', body: rec, headers: { Prefer: 'return=minimal' } });
    } catch (e) {
      ctx.log(`操作记录没写上（不影响）：${e.message}`);
    }
  }

  // ---------- 设备、订单查询 ----------
  async function findEquipment(machineNo) {
    const rows = await query('mcs_equipments',
      'mcs_equipmentid,mcs_name,_mcs_personnel_30_value,mcs_accumulatedrunningtime,mcs_equipmentcontact1,mcs_equipmentcontacttel,_mcs_customer_value,_mcs_actualcustomer_value',
      `mcs_name eq '${esc(machineNo)}'`, '&$top=2');
    if (!rows.length) throw new Skip(`D365 里找不到设备 ${machineNo}`);
    if (rows.length > 1) throw new Skip(`D365 里有多台同名设备 ${machineNo}`);
    return rows[0];
  }

  async function ordersOfType(equipmentId, type) {
    return (await query(ORDERS, 'mcs_consultationorderid,mcs_name,mcs_status,statecode,createdon',
      `_mcs_equipment_value eq ${guid(equipmentId)} and mcs_ordertype eq ${type}`, '&$orderby=createdon desc&$top=50'))
      .filter((o) => Number(o.statecode) === 0 && Number(o.mcs_status) !== ST.Canceled);
  }

  // ---------- 附件 ----------
  async function listFiles(orderId) {
    const files = [];
    for (let page = 1; page <= 10; page += 1) {
      const { result } = await action('mcs_QueryUploadFile', {
        EntityID: `{${guid(orderId).toUpperCase()}}`, EntityName: ORDER, Page: page,
      });
      const rows = result?.Results || [];
      files.push(...rows);
      if (!rows.length || files.length >= Number(result?.TotalCount || 0)) break;
    }
    return files;
  }
  const fileType = (f) => String(f?.Type || '').padStart(3, '0');
  const isTicket = (f) => ['098', '118'].includes(fileType(f)) || /service\s*ticket|服务工单/i.test(String(f?.Name || ''));
  const extOf = (name, fallback) => (String(name || '').match(/\.([^.]+)$/)?.[1] || fallback).toLowerCase();

  async function download(url, what) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载${what}失败：HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob.size) throw new Error(`${what}是空文件`);
    return blob;
  }

  // 附件页上传照片前会加水印（登录名 + 时间）并压缩到 1024 像素、质量 0.7，这里照做
  async function watermarkAndCompress(blob, text) {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 1024 / bmp.width, 1024 / bmp.height);
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    g.drawImage(bmp, 0, 0, w, h);
    // 原水印：字号 100×比例、行距 500×比例、黑色、透明度 0.15、铺满整张图（比例按 4096 宽 / 3544 高算）
    const proportion = (bmp.width < bmp.height ? bmp.height / 3544 : bmp.width / 4096) * scale;
    const size = Math.max(10, 100 * proportion);
    const gap = Math.max(size * 2, 500 * proportion);
    g.globalAlpha = 0.15;
    g.fillStyle = '#000';
    g.font = `${size}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const tw = g.measureText(text).width + size * 2;
    for (let y = gap / 2; y < h + gap; y += gap) {
      for (let x = tw / 2; x < w + tw; x += tw) g.fillText(text, x, y);
    }
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('照片压缩失败'))), 'image/jpeg', 0.7));
  }

  async function putBlob(url, blob) {
    const chunk = 4 * 1024 * 1024;
    for (let start = 0; start < blob.size || start === 0; start += chunk) {
      const res = await fetch(url, {
        method: 'PUT', body: blob.slice(start, Math.min(start + chunk, blob.size)),
        headers: { 'Content-Type': 'application/octet-stream', 'x-ms-version': '2019-12-12', 'x-ms-date': new Date().toUTCString() },
      });
      if (!res.ok) throw new Error(`上传文件失败：HTTP ${res.status}`);
      if (blob.size === 0) break;
    }
  }

  // 和附件页一样：InitUploadFile 拿上传地址 → 上传 → CommitUploadFile → UpdateUploadFileType 按类型改名
  async function uploadFile(item, ctx, blob, spec, ext) {
    const fileName = `${spec.name}.${ext}`;
    if (ctx.dry) {
      ctx.log(`（不执行）上传 ${fileName}（${Math.round(blob.size / 1024)} KB，类型 ${spec.type}）`);
      (item.sim.files ||= []).push(spec.type);
      return;
    }
    let body = blob;
    if (/^(jpe?g|png|bmp|gif)$/i.test(ext)) {
      const u = await currentUser();
      body = await watermarkAndCompress(blob, `${u.domain} ${stamp()}`);
    }
    const entityId = guid(item.orderId);
    const { result: init } = await action('mcs_InitUploadFile', { EntityID: entityId, EntityName: ORDER, FileName: fileName, Type: spec.type });
    if (!init?.ID || !init?.FileUrl) throw new Error('InitUploadFile 没有返回上传地址');
    try {
      await putBlob(init.FileUrl, body);
      await action('mcs_CommitUploadFile', { ID: init.ID, EntityID: entityId, EntityName: ORDER });
    } catch (e) {
      try { await action('mcs_DeleteUploadFileTemp', { ID: init.ID, EntityID: entityId, EntityName: ORDER }); } catch { /* 清理失败不管 */ }
      throw e;
    }
    await action('mcs_UpdateUploadFileType', {
      IDs: JSON.stringify([init.ID]), EntityID: entityId, EntityName: ORDER, Type: spec.type, FileName: fileName,
    });
  }

  async function orderFileTypes(item, ctx) {
    const types = new Set((await listFiles(item.orderId)).map(fileType));
    for (const t of item.sim.files || []) types.add(t);
    return types;
  }

  // ---------- Service Ticket：和 Service Completion 标签里的预览一样生成 PDF ----------
  async function loadDocLibs() {
    for (const [name, ready] of [
      ['pizzip.js', () => window.PizZip], ['pizzip-utils.js', () => window.PizZipUtils],
      ['docxtemplater.js', () => window.docxtemplater], ['imagemodule.js', () => window.ImageModule],
    ]) {
      if (ready()) continue;
      const res = await fetch(`/WebResources/mcs_/CommonCore/Scripts/${name}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`加载 ${name} 失败：HTTP ${res.status}`);
      (0, eval)(await res.text()); // eslint-disable-line no-eval -- 和 D365 页面自己加载这些库一样
    }
  }

  async function renderDocx(orderId, actionName, withImages) {
    const { raw: tpl } = await action('ms_GenerateFileTemplateData', { EntityID: guid(orderId), EntityName: ORDER, ActionName: actionName });
    const file = tpl?.File ? JSON.parse(tpl.File) : null;
    if (!file?.Url) throw new Error('没有拿到 Service Ticket 模板');
    const values = JSON.parse(tpl.Data || '{}');
    if (withImages) {
      const mime = (n) => ({ jpg: 'image/jpg', jpeg: 'image/jpg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp' })[extOf(n, '')] || 'application/octet-stream';
      const images = values.ImageData ? (JSON.parse(values.ImageData).Results || []) : [];
      for (const img of images) {
        const blob = await (await fetch(img.ImageUrl)).blob();
        img.ImageBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
      const rows = [];
      for (let i = 0; i < images.length; i += 3) {
        const line = {};
        for (let j = 0; j < 3; j += 1) {
          const img = images[i + j];
          line[`imgName_${j}`] = img ? img.Name : '';
          line[`imgBase64_${j}`] = img ? String(img.ImageBase64).replace(/^data:.*?;base64,/, `data:${mime(img.Name)};base64,`) : '';
          line[`imgCreateTime_${j}`] = img ? new Date(Date.parse(`${img.CreateTime}Z`)).toLocaleString() : '';
        }
        rows.push(line);
      }
      values.ImageData = rows;
    }
    await loadDocLibs();
    const toBuffer = (url) => {
      const re = /^data:image\/(png|jpg|gif|bmp|svg|svg\+xml);base64,/;
      if (!re.test(url)) return false;
      const bin = atob(url.replace(re, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return bytes.buffer;
    };
    const templateRes = await fetch(new URL(file.Url, location.origin).href, { credentials: 'include' });
    if (!templateRes.ok) throw new Error(`下载 Service Ticket 模板失败：HTTP ${templateRes.status}`);
    const doc = new window.docxtemplater();
    doc.loadZip(new window.PizZip(await templateRes.arrayBuffer()));
    doc.linebreaks = true;
    doc.attachModule(new window.ImageModule({ getImage: (tag) => toBuffer(tag), getSize: () => [100, 100] }));
    doc.render(values);
    return doc.getZip().generate({
      type: 'blob', compression: 'DEFLATE',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  }

  // 只生成文件，不改订单
  async function generateTicketPdf(orderId) {
    const docx = await renderDocx(orderId, 'ConsultationOrderTemplate', true);
    const { result: temp } = await action('mcs_inittempfile', {});
    if (!temp?.Url) throw new Error('mcs_inittempfile 没有返回地址');
    await putBlob(temp.Url, docx);
    const { raw: conv } = await action('mcs_convertpdf', { FileName: temp.FileName, DisplayName: `${guid(orderId)}.docx` });
    const pdfUrl = String(conv?.Result || '').replace(/^"|"$/g, '');
    if (!pdfUrl) throw new Error('转换 PDF 没有返回地址');
    return download(pdfUrl, '生成的 Service Ticket');
  }

  // 现场完工时网页会顺带把服务完工预览（file01.docx）存一份，这里也照做；失败不影响
  async function uploadCompletionPreview(item, ctx) {
    if (ctx.dry) return;
    try {
      const blob = await renderDocx(item.orderId, 'ConsultationOrderTemplate', false);
      const { raw } = await action('mcs_InitEntityNamedFileUrl', { EntityName: ORDER, EntityID: guid(item.orderId), FileName: 'file01.docx' });
      const url = String(raw?.Result || '').replace(/^"|"$/g, '');
      if (url) await putBlob(url, blob);
    } catch (e) {
      ctx.log(`服务完工预览没存上（不影响）：${e.message}`);
    }
  }

  // ---------- 联系人：设备档案 → 同客户以前的订单 → 客户名下联系人 → 客户本身 ----------
  function looksLikePhone(value) {
    const text = String(value || '').trim();
    return /^[+\d\s()\-]+$/.test(text) && (text.match(/\d/g) || []).length >= 7;
  }

  async function findCustomerContact(order, equipment) {
    if (clean(equipment?.mcs_equipmentcontact1) && looksLikePhone(equipment?.mcs_equipmentcontacttel)) {
      return { name: clean(equipment.mcs_equipmentcontact1), phone: String(equipment.mcs_equipmentcontacttel).trim(), source: '设备档案' };
    }
    let accountId = guid(order._mcs_customer_value);
    let accountName = fmt(order, '_mcs_customer_value');
    if (!accountId && equipment) {
      accountId = guid(equipment._mcs_actualcustomer_value || equipment._mcs_customer_value);
      accountName = fmt(equipment, equipment._mcs_actualcustomer_value ? '_mcs_actualcustomer_value' : '_mcs_customer_value');
    }
    if (!accountId) return null;
    const past = await query(ORDERS, 'mcs_name,mcs_equipmentcontact1,mcs_equipmentcontacttel',
      `_mcs_customer_value eq ${accountId} and mcs_consultationorderid ne ${guid(order.mcs_consultationorderid)} and mcs_equipmentcontact1 ne null and mcs_equipmentcontacttel ne null`,
      '&$orderby=createdon desc&$top=10');
    const hit = past.find((x) => clean(x.mcs_equipmentcontact1) && looksLikePhone(x.mcs_equipmentcontacttel));
    if (hit) return { name: clean(hit.mcs_equipmentcontact1), phone: String(hit.mcs_equipmentcontacttel).trim(), source: `${accountName} 以前的订单 ${hit.mcs_name}` };
    const pick = (list, source) => {
      for (const c of list) {
        const phone = [c.mobilephone, c.telephone1, c.telephone2].find(looksLikePhone);
        if (clean(c.fullname) && phone) return { name: clean(c.fullname), phone: String(phone).trim(), source: `${source}：${clean(c.fullname)}` };
      }
      return null;
    };
    const contacts = await query('contacts', 'fullname,mobilephone,telephone1,telephone2', `_parentcustomerid_value eq ${accountId} and statecode eq 0`, '&$orderby=modifiedon desc&$top=20');
    const byParent = pick(contacts, `${accountName} 的联系人`);
    if (byParent) return byParent;
    const { data: account } = await api(`accounts(${accountId})?$select=name,mcs_legalperson,mcs_phone,telephone1,emailaddress1,websiteurl`);
    // 同一个客户在 D365 里常有两条（销售那边一条、服务这边一条），联系人挂在销售那条下面，你没有权限打开那条客户，
    // 但能看到联系人。所以再按客户的邮箱域名（sales@completemh.co.uk → completemh.co.uk）找同公司的联系人。
    const domain = companyDomain(account.emailaddress1) || companyDomain(account.websiteurl);
    if (domain) {
      const sameCompany = await query('contacts', 'fullname,mobilephone,telephone1,telephone2',
        `contains(emailaddress1,'@${esc(domain)}') and statecode eq 0`, '&$orderby=modifiedon desc&$top=20');
      const hitByDomain = pick(sameCompany, `同公司邮箱（@${domain}）的联系人`);
      if (hitByDomain) return hitByDomain;
    }
    const phone = [account.mcs_phone, account.telephone1].find(looksLikePhone);
    if (phone) return { name: clean(account.mcs_legalperson) || clean(account.name), phone: String(phone).trim(), source: `客户 ${clean(account.name)} 本身` };
    return null;
  }

  // 公司自己的域名（个人邮箱 gmail 之类不算，按它找会找到别的公司的人）
  const PUBLIC_MAIL = /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|aol|btinternet|bt|sky|virginmedia|talktalk|qq|163|126|sina|protonmail|gmx|mail)\./i;
  function companyDomain(text) {
    const m = String(text || '').trim().toLowerCase().match(/(?:@|^(?:https?:\/\/)?(?:www\.)?)([a-z0-9-]+(?:\.[a-z0-9-]+)+)/);
    const d = m ? m[1] : '';
    return d && !PUBLIC_MAIL.test(d) ? d : '';
  }

  // 交机单上空着的联系人 / 电话：去客户那里找到后填上
  async function fillContact(item, ctx, o, payload) {
    const targets = [['mcs_equipmentcontact1', 'name'], ['mcs_equipmentcontacttel', 'phone'], ['mcs_customercontact', 'name'], ['mcs_telephone', 'phone']]
      .filter(([f]) => !clean(o[f]));
    if (!targets.length) return;
    const eq = (await query('mcs_equipments', 'mcs_equipmentcontact1,mcs_equipmentcontacttel,_mcs_customer_value,_mcs_actualcustomer_value', `mcs_equipmentid eq ${item.equipmentId}`))[0];
    const found = await findCustomerContact(o, eq);
    if (found) {
      for (const [f, k] of targets) payload[f] = found[k];
      ctx.log(`从${found.source} 找到联系人 ${found.name} / ${found.phone}`);
    } else {
      ctx.log('客户那里没找到可用的联系人和电话');
    }
  }

  // ---------- 日期 ----------
  function handoverDateIso(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''));
    const now = new Date();
    const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9, 0, 0) : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);
    return d.toISOString();
  }
  function sameLocalDay(a, b) {
    if (!a) return false;
    const x = new Date(a);
    const y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  }
  // 比设备累计运行时间略大：一位小数 +0.1（和以前脚本一样）
  const hoursJustAbove = (h) => Number((Math.floor(h * 10 + 1e-6) / 10 + 0.1).toFixed(1));

  // =====================================================================
  // 交机（无照片）：照片、工时、Service Ticket 都从这台机的 PDI 里拿
  // =====================================================================
  const HANDOVER_FIELDS = [
    ['mcs_engineer', 'Engineer'], ['mcs_productgroupid', 'Product Group'], ['mcs_equipmentusagestatus', 'Equipment Usage Status'],
    ['mcs_equipmentstatus', 'Equipment Status'], ['mcs_model', 'Model'], ['mcs_customer', 'Customer'],
    ['mcs_personnel_30', 'Responsible Service Engineer'], ['mcs_country', 'Country/Region'],
    ['mcs_warrantypolicyvalues', 'Warranty Policy (Value)'], ['mcs_warrantypolicyunit', 'Warranty Policy (Unit)'],
    ['mcs_warrantypolicymonth', 'Warranty Policy (Month)'], ['mcs_equipmentcontact1', 'Equipment Contact'],
    ['mcs_equipmentcontacttel', 'Equipment Contact Phone'],
  ];
  const lookupField = (f) => ['mcs_engineer', 'mcs_productgroupid', 'mcs_customer', 'mcs_personnel_30', 'mcs_country', 'mcs_salesdealer'].includes(f);
  const selectName = (f) => (lookupField(f) ? `_${f}_value` : f);
  const has = (v) => v !== null && v !== undefined && String(v).trim() !== '';

  const handover = {
    // 1. 找设备、PDI、交机单（没有就新建）
    async resolve(item, ctx) {
      const eq = await findEquipment(item.machineNo);
      item.equipmentId = guid(eq.mcs_equipmentid);
      const pdis = await ordersOfType(item.equipmentId, TYPE.Arrival);
      if (!pdis.length) throw new Skip('没有 PDI 订单，不做交机');
      const handovers = await ordersOfType(item.equipmentId, TYPE.DeliveryOrder);
      const open = handovers.find((o) => ![ST.CompletionOnSite, ST.InApproval, ST.Completed].includes(Number(o.mcs_status)));
      if (handovers.length && !open) {
        throw new Skip(`交机单 ${handovers[0].mcs_name} 已是 ${fmt(handovers[0], 'mcs_status') || STATUS_TEXT[handovers[0].mcs_status]}`);
      }
      // 有 Service Ticket 的 PDI 优先；都没有就用已完成的 PDI 现场生成一份
      let ticketPdi = null;
      for (const pdi of pdis) {
        if ((await listFiles(pdi.mcs_consultationorderid)).some(isTicket)) { ticketPdi = pdi; break; }
      }
      item.generateTicket = !ticketPdi;
      ticketPdi ||= pdis.find((p) => Number(p.mcs_status) === ST.Completed) || pdis[0];
      item.pdiOrderId = guid(ticketPdi.mcs_consultationorderid);
      item.pdiOrderNumber = ticketPdi.mcs_name;
      if (open) {
        item.orderId = guid(open.mcs_consultationorderid);
        item.orderNumber = open.mcs_name;
        ctx.log(`用已有的交机单 ${open.mcs_name}（${fmt(open, 'mcs_status')}），PDI ${item.pdiOrderNumber}${item.generateTicket ? '（附件里没有 Service Ticket，到时从它生成）' : ''}`);
        return;
      }
      const body = {
        'mcs_equipment@odata.bind': `/mcs_equipments(${item.equipmentId})`,
        mcs_ordertype: TYPE.DeliveryOrder,
        mcs_handoverdate: handoverDateIso(ctx.opts.fields?.handoverDate),
      };
      if (ctx.dry) {
        ctx.log(`（不执行）新建交机单：${JSON.stringify(body)}`);
        item.orderId = ZERO_GUID;
        item.orderNumber = '（演练：新单）';
        item.sim.status = ST.Created;
        item.sim.newOrder = true;
        return;
      }
      const { entityId } = await api(ORDERS, { method: 'POST', body, headers: { Prefer: 'return=minimal' } });
      if (!entityId) throw new Error('交机单已创建，但没有返回订单 ID');
      item.orderId = entityId;
      item.orderNumber = (await readOrder(entityId, 'mcs_name')).mcs_name || '';
      ctx.log(`新建交机单 ${item.orderNumber}`);
    },

    // 2. 交机日期、联系人
    async prepare(item, ctx) {
      if (item.sim.newOrder) return ctx.log('（演练：新单，跳过读取字段）');
      const o = await readOrder(item.orderId, 'mcs_consultationorderid,mcs_handoverdate,_mcs_customer_value,mcs_equipmentcontact1,mcs_equipmentcontacttel,mcs_customercontact,mcs_telephone');
      const payload = {};
      const wanted = handoverDateIso(ctx.opts.fields?.handoverDate);
      if (!sameLocalDay(o.mcs_handoverdate, wanted)) payload.mcs_handoverdate = wanted;
      await fillContact(item, ctx, o, payload);
      if (Object.keys(payload).length) await patchOrder(item, ctx, payload, '写入交机日期 / 联系人');
    },

    // 3. 接单
    async accept(item, ctx) {
      const st = await orderStatus(item, ctx);
      if (![ST.Created, ST.Dispatched, ST.Transferred, ST.Refused].includes(st)) return;
      await ctx.write('接单（mcs_ConsultationOrderAcceptApi）', async () => {
        const { result } = await action('mcs_ConsultationOrderAcceptApi', { FormId: guid(item.orderId), DispatchRecordId: ZERO_GUID });
        if (result && result.Result === false) throw new Error(`接单失败：${result.Description || '未知原因'}`);
      }, setSim(item, { status: ST.Accepted }));
      await appLog(item, ctx, LOG.accept);
      const after = await orderStatus(item, ctx);
      if (after !== ST.Accepted) throw new Pause(`接单后状态是 ${STATUS_TEXT[after] || after}（可能需要先派单给你）。处理好后点“继续”`);
      ctx.log('已接单');
    },

    // 4. 出发：地图页一样写出行方式、预计到达时间；设备位置没有就用 PDI 时的位置
    async setOff(item, ctx) {
      const st = await orderStatus(item, ctx);
      if (![ST.Accepted, ST.Paused].includes(st)) return;
      const o = item.sim.newOrder ? {} : await readOrder(item.orderId, 'mcs_endlatitude,mcs_endlongitude,mcs_engineerdestination,mcs_equipmentlocation');
      const payload = { mcs_status: ST.Departed, mcs_travelmode: TRAVEL_GROUND, mcs_estimatedarrivaldate: new Date(Date.now() + 3600 * 1000).toUTCString() };
      if (!has(o.mcs_endlatitude) || !has(o.mcs_endlongitude)) {
        const pdi = await readOrder(item.pdiOrderId, 'mcs_latitude,mcs_longitude,mcs_endlatitude,mcs_endlongitude,mcs_equipmentlocation,mcs_engineerdestination');
        const lat = pdi.mcs_latitude ?? pdi.mcs_endlatitude;
        const lng = pdi.mcs_longitude ?? pdi.mcs_endlongitude;
        const addr = clean(pdi.mcs_equipmentlocation || pdi.mcs_engineerdestination);
        if (!has(lat) || !has(lng)) throw new Pause(`交机单没有设备位置，PDI ${item.pdiOrderNumber} 里也没有。请在交机单上点 Select Equipment Location 选好位置，然后点“继续”`);
        Object.assign(payload, { mcs_endlatitude: lat, mcs_endlongitude: lng, mcs_engineerdestination: addr, mcs_equipmentlocation: addr });
        ctx.log(`设备位置用 PDI ${item.pdiOrderNumber} 的位置：${addr || `${lat}, ${lng}`}`);
      }
      await patchOrder(item, ctx, payload, '出发（Ground Transportation）');
      await appLog(item, ctx, LOG.setOff);
      ctx.log('已出发');
    },

    // 5. 到达：和地图页“距离太远”时一样走异常到达，原因选“手机信号弱”
    async arrive(item, ctx) {
      const st = await orderStatus(item, ctx);
      if (st !== ST.Departed) return;
      if (!item.sim.newOrder) {
        const o = await readOrder(item.orderId, 'mcs_ispassed');
        if (o.mcs_ispassed !== true) await patchOrder(item, ctx, { mcs_ispassed: true }, 'Assessment Pass = Yes');
      }
      await patchOrder(item, ctx, {
        mcs_status: ST.Arrived, mcs_arrivaltype: ARRIVAL_ABNORMAL, mcs_normalarrived: false,
        mcs_reasonofabnormalarrival: REASON_WEAK_SIGNAL, mcs_servicemileage: 0,
      }, '到达（异常到达：手机信号弱）');
      await appLog(item, ctx, LOG.arrive);
      ctx.log('已到达');
    },

    // 6. 交机字段、工时
    async fields(item, ctx) {
      const st = await orderStatus(item, ctx);
      if (st !== ST.Arrived && st !== ST.Rejected) return;
      const o = item.sim.newOrder ? {} : await readOrder(item.orderId, 'mcs_ispassed,mcs_isneedonsitetrainingnew,mcs_existfault,mcs_acceptancepassed,mcs_systemrunningtime,mcs_handoverdate,_mcs_personnel_30_value,_mcs_engineer_value');
      const payload = {};
      if (o.mcs_ispassed !== true) payload.mcs_ispassed = true;
      if (o.mcs_isneedonsitetrainingnew !== TRAINING_NO) payload.mcs_isneedonsitetrainingnew = TRAINING_NO;
      if (o.mcs_existfault !== false) payload.mcs_existfault = false;
      if (o.mcs_acceptancepassed !== true) payload.mcs_acceptancepassed = true;
      // 工时：Excel 里写了就用写的，否则用 PDI 的；必须大于设备累计运行时间
      let hours = Number(item.workingHours);
      if (!(hours > 0)) {
        hours = Number((await readOrder(item.pdiOrderId, 'mcs_systemrunningtime')).mcs_systemrunningtime);
        if (!(hours > 0)) hours = 0.1;
        ctx.log(`工作小时取 PDI ${item.pdiOrderNumber} 的 ${hours}`);
      }
      const eq = (await query('mcs_equipments', 'mcs_accumulatedrunningtime,_mcs_personnel_30_value', `mcs_equipmentid eq ${item.equipmentId}`))[0] || {};
      const floor = Number(eq.mcs_accumulatedrunningtime);
      if (Number.isFinite(floor) && floor > 0 && hours <= floor) {
        const raised = hoursJustAbove(floor);
        ctx.log(`工时 ${hours} 不大于设备累计运行时间 ${floor}，改为 ${raised}`);
        hours = raised;
      }
      item.workingHours = String(hours);
      if (Number(o.mcs_systemrunningtime) !== hours) payload.mcs_systemrunningtime = hours;
      // 服务完工前网页会把空的“责任服务工程师”补上（设备上的，或者做单的工程师）
      if (!o._mcs_personnel_30_value) {
        const pid = eq._mcs_personnel_30_value || o._mcs_engineer_value;
        if (pid) payload['mcs_personnel_30@odata.bind'] = `/mcs_personnels(${guid(pid)})`;
      }
      if (Object.keys(payload).length) await patchOrder(item, ctx, payload, `写入 Assessment Pass、无需培训、无故障、Check Passed、工时 ${hours}`);
    },

    // 7. 照片：PDI 的铭牌、远照、工时照、其他照片（PDI 没有其他照片就从 PDI 别的图片里挑一张不重复的）
    async photos(item, ctx) {
      const st = await orderStatus(item, ctx);
      if (st !== ST.Arrived && st !== ST.Rejected) return;
      const have = item.sim.newOrder ? new Set(item.sim.files || []) : await orderFileTypes(item, ctx);
      const pdiFiles = await listFiles(item.pdiOrderId);
      const newest = (type) => pdiFiles.filter((f) => fileType(f) === type && f.FileUrl)
        .sort((a, b) => String(b.CreateTime || '').localeCompare(String(a.CreateTime || '')))[0] || null;
      for (const spec of HANDOVER_PHOTOS) {
        if (have.has(spec.type)) continue;
        let src = newest(spec.type);
        if (!src && spec.type === FILE.other.type) {
          src = pickOtherPhoto(item, pdiFiles, newest);
          // PDI 一共就三张照片（铭牌、远照、工时照）：只能把整机远照再用一次当“其他照片”
          if (!src && newest(FILE.far.type)) {
            src = newest(FILE.far.type);
            ctx.log(`PDI 里除了铭牌/远照/工时照没有别的照片，“其他照片”用整机远照再传一次`);
          } else if (src) {
            ctx.log(`PDI 里没有“其他照片”，选用 PDI 的 ${src.Name}（和铭牌/远照/工时照不重复）`);
          }
        }
        if (!src) throw new Error(`PDI ${item.pdiOrderNumber} 里没有“${spec.label}”照片，无法自动交机`);
        const blob = await download(src.FileUrl, `PDI 的“${spec.label}”`);
        ctx.log(`上传 ${spec.label}（来自 PDI 的 ${src.Name}）`);
        await uploadFile(item, ctx, blob, spec, extOf(src.Name, 'jpg'));
      }
    },

    // 8. Service Ticket：PDI 附件里有就下载，没有就从 PDI 的 Service Completion 生成
    async ticket(item, ctx) {
      const st = await orderStatus(item, ctx);
      if (st !== ST.Arrived && st !== ST.Rejected) return;
      const have = item.sim.newOrder ? new Set(item.sim.files || []) : await orderFileTypes(item, ctx);
      if (have.has(FILE.ticket.type)) return;
      let blob;
      let ext = 'pdf';
      const t = (await listFiles(item.pdiOrderId)).find(isTicket);
      if (t?.FileUrl) {
        ctx.log(`从 PDI ${item.pdiOrderNumber} 下载 Service Ticket`);
        blob = await download(t.FileUrl, 'PDI 的 Service Ticket');
        ext = extOf(t.Name, 'pdf');
      } else {
        ctx.log(`PDI ${item.pdiOrderNumber} 附件里没有 Service Ticket，从它的 Service Completion 生成一份`);
        blob = await generateTicketPdf(item.pdiOrderId);
      }
      await uploadFile(item, ctx, blob, FILE.ticket, ext);
      ctx.log('已上传 Service Ticket');
    },

    // 9. 现场完工：先按网页的规则检查必填项
    async onSite(item, ctx) {
      const st = await orderStatus(item, ctx);
      if (st !== ST.Arrived) return;
      if (!item.sim.newOrder) {
        // 之前因为缺联系人停下的单：继续时再去客户那里找一次
        const o = await readOrder(item.orderId, 'mcs_consultationorderid,_mcs_customer_value,mcs_equipmentcontact1,mcs_equipmentcontacttel,mcs_customercontact,mcs_telephone');
        const payload = {};
        await fillContact(item, ctx, o, payload);
        if (Object.keys(payload).length) await patchOrder(item, ctx, payload, '写入联系人');
        await checkHandoverReady(item, ctx);
      }
      const u = await currentUser();
      await appLog(item, ctx, LOG.onSite);
      await patchOrder(item, ctx, { mcs_status: ST.CompletionOnSite, 'mcs_systemuser@odata.bind': `/systemusers(${u.id})` }, '现场完工');
      await uploadCompletionPreview(item, ctx);
      ctx.log('已现场完工');
    },

    // 10. 提交审核
    async submit(item, ctx) {
      const st = await orderStatus(item, ctx);
      if (st === ST.InApproval || st === ST.Completed) return;
      if (st !== ST.CompletionOnSite && st !== ST.Rejected) throw new Error(`现在状态是 ${STATUS_TEXT[st] || st}，不能提交审核`);
      if (!item.sim.newOrder) await checkHandoverReady(item, ctx, true);
      await ctx.write('提交审核（mcs_ConsultationOrderSubmitApprovalApi）', async () => {
        const { result } = await action('mcs_ConsultationOrderSubmitApprovalApi', { FormId: guid(item.orderId) });
        if (result && result.Result === false) throw new Error(`提交审核失败：${result.Description || '未知原因'}`);
        if (result?.Description) ctx.log(`D365 回复：${result.Description}`);
      }, setSim(item, { status: ST.InApproval }));
      await appLog(item, ctx, LOG.complete);
      const after = await orderStatus(item, ctx);
      if (![ST.InApproval, ST.Completed].includes(after)) throw new Error(`提交后状态还是 ${STATUS_TEXT[after] || after}`);
      ctx.log(`已提交审核（${STATUS_TEXT[after]}）`);
    },
  };

  function pickOtherPhoto(item, files, newest) {
    const isImage = (f) => /\.(jpe?g|png)$/i.test(String(f.Name || '')) && f.FileUrl;
    if (item.otherPhotoSourceId) {
      const kept = files.find((f) => f.ID === item.otherPhotoSourceId && isImage(f));
      if (kept) return kept;
    }
    const used = new Set(['001', '002', '003'].map(newest).filter(Boolean).map((f) => f.ID));
    const pool = files.filter((f) => isImage(f) && !used.has(f.ID) && fileType(f) !== '118');
    const groups = [
      pool.filter((f) => ['001', '002', '003'].includes(fileType(f))),
      pool.filter((f) => !['001', '002', '003', '007', '008'].includes(fileType(f))),
      pool.filter((f) => ['007', '008'].includes(fileType(f))),
    ];
    const group = groups.find((g) => g.length);
    if (!group) return null;
    const chosen = group[Math.floor(Math.random() * group.length)];
    item.otherPhotoSourceId = chosen.ID;
    return chosen;
  }

  // 网页“服务完工 / 提交审核”前做的检查（setCompletionCheckData、checkCompletion、CheckCustomerType、
  // CheckRelationConsultationOrder、CheckBlockPhoto、CheckServiceOrder），有问题就停下说清楚缺什么
  async function checkHandoverReady(item, ctx, forSubmit = false) {
    const sel = [...HANDOVER_FIELDS.map(([f]) => selectName(f)), '_mcs_salesdealer_value', 'mcs_systemrunningtime', 'mcs_isblockmachine', '_mcs_serviceorder_value'].join(',');
    const o = await readOrder(item.orderId, sel);
    for (const [k, v] of Object.entries(item.sim.fields || {})) o[k.endsWith('@odata.bind') ? `_${k.split('@')[0]}_value` : k] = v;
    const missing = HANDOVER_FIELDS.filter(([f]) => !has(o[selectName(f)])).map(([, label]) => label);
    const problems = [];
    if (o._mcs_customer_value) {
      const { data: acc } = await api(`accounts(${guid(o._mcs_customer_value)})?$select=mcs_accountcategory`);
      if (acc.mcs_accountcategory === null || acc.mcs_accountcategory === undefined) problems.push('客户的 Customer Type 是空的');
      else if ([10, 30, 60, 90].includes(acc.mcs_accountcategory) && !o._mcs_salesdealer_value) missing.push('Sales Dealer');
    }
    if (!(Number(o.mcs_systemrunningtime) > 0)) missing.push('Current Operating Hours');
    if (missing.length) problems.push(`这些必填项是空的：${missing.join('、')}`);
    const unfinished = await query(ORDERS, 'mcs_name,mcs_ordertype',
      `_mcs_equipment_value eq ${item.equipmentId} and (mcs_ordertype eq ${TYPE.Arrival} or mcs_ordertype eq ${TYPE.RustProof}) and mcs_status lt ${ST.Completed}`, '&$top=1');
    if (unfinished.length) problems.push(`这台机的${unfinished[0].mcs_ordertype === TYPE.Arrival ? '到货预验收' : '防锈运转'}单 ${unfinished[0].mcs_name} 还没完成`);
    if (Number(o.mcs_isblockmachine) === 2) {
      const types = await orderFileTypes(item, ctx);
      if (!types.has('018')) problems.push('“是否锁机”是 是，需要上传锁机设置照片');
    }
    if (o._mcs_serviceorder_value) {
      const { data: so } = await api(`mcs_serviceorders(${guid(o._mcs_serviceorder_value)})?$select=mcs_orderstatus`);
      if (![110, 130, 15].includes(Number(so.mcs_orderstatus))) problems.push('关联的维修单还没完成');
    }
    if (forSubmit) {
      const types = await orderFileTypes(item, ctx);
      if (!types.has(FILE.ticket.type)) problems.push('还没有上传 Service Ticket');
    }
    if (problems.length) throw new Pause(`${problems.join('；')}。在交机单 ${item.orderNumber} 上补好后点“继续”`);
  }

  const HANDOVER_STEPS = [
    ['resolve', 'handover-preparing'], ['prepare', 'handover-preparing'], ['accept', 'accepting'], ['setOff', 'setting-off'],
    ['arrive', 'arriving'], ['fields', 'handover-fields'], ['photos', 'uploading'], ['ticket', 'ticket'],
    ['onSite', 'handover-completing'], ['submit', 'submitting'],
  ];

  // =====================================================================
  // Shipment PDI：按单号写 Description，再永久转派给某人
  // =====================================================================
  const shipment = {
    async resolve(item, ctx) {
      const no = clean(item.orderNumberInput);
      const rows = await query(ORDERS, 'mcs_consultationorderid,mcs_name,mcs_status,statecode,mcs_preacceptancetypes,_ownerid_value,_mcs_equipment_value',
        `mcs_name eq '${esc(no)}'`, '&$top=2');
      if (rows.length !== 1) throw new Skip(rows.length ? `单号 ${no} 匹配到多张订单` : `找不到单号 ${no}`);
      const o = rows[0];
      if (Number(o.statecode) !== 0 || Number(o.mcs_status) === ST.Canceled) throw new Skip(`订单 ${no} 已取消/停用`);
      if (Number(o.mcs_preacceptancetypes) !== PRE_SHIPMENT) {
        throw new Skip(`订单 ${no} 的预验收类型是“${fmt(o, 'mcs_preacceptancetypes') || '空'}”，不是 Shipment PDI`);
      }
      const u = await currentUser();
      if (o._ownerid_value && guid(o._ownerid_value) !== u.id) {
        throw new Skip(`订单 ${no} 负责人已是 ${fmt(o, '_ownerid_value') || '别人'}（${fmt(o, 'mcs_status')}），已转移过`);
      }
      item.orderId = guid(o.mcs_consultationorderid);
      item.orderNumber = o.mcs_name;
      item.machineNo = fmt(o, '_mcs_equipment_value') || item.machineNo || '';
    },
    async description(item, ctx) {
      const text = String(ctx.opts.fields?.shipDesc || '').trim();
      if (!text) return ctx.log('Description 没填，不修改');
      await patchOrder(item, ctx, { mcs_description: text }, '写入 Description');
    },
    async transfer(item, ctx) {
      const target = clean(ctx.opts.fields?.transferTarget);
      if (!target) throw new Error('没填“转移给”');
      // 和转移页一样先搜人：Service_GetAllEngineerListApi
      const { result } = await action('Service_GetAllEngineerListApi', {
        OrderId: `${guid(item.orderId)}-${ORDER}`, FilterName: target, FilterCountry: '',
      });
      if (result && result.IsSuccess === false) throw new Error(`搜索转移人员失败：${result.Message || ''}`);
      let people = result?.EngineerData || [];
      const exact = people.filter((p) => clean(p.name).toLowerCase() === target.toLowerCase());
      if (exact.length === 1) people = exact;
      if (people.length !== 1) {
        throw new Error(people.length
          ? `“${target}”匹配到 ${people.length} 人（${people.slice(0, 6).map((p) => clean(p.name)).join('、')}），请写能唯一匹配的姓名或工号`
          : `找不到转移人员“${target}”`);
      }
      item.transferResolved = clean(people[0].name);
      // 中断后再做时：负责人已经不是自己，说明上次已经转派成功，不再重复转派
      const u = await currentUser();
      const now = await readOrder(item.orderId, '_ownerid_value');
      if (now._ownerid_value && guid(now._ownerid_value) !== u.id) {
        return ctx.log(`负责人已是 ${fmt(now, '_ownerid_value')}，已经转派过`);
      }
      await ctx.write(`永久转派给 ${item.transferResolved}（Service_PermanenttransferApi）`, () => action('Service_PermanenttransferApi', {
        ServiceTransferParame: JSON.stringify({ personid: people[0].id, orderid: guid(item.orderId), entityNames: ORDER }),
      }));
      ctx.log(`已永久转派给 ${item.transferResolved}`);
    },
  };
  const SHIPMENT_STEPS = [['resolve', 'transferring'], ['description', 'transferring'], ['transfer', 'transfer-submitting']];

  const KINDS = {
    'handover-pdi': { steps: HANDOVER_STEPS, impl: handover },
    'shipment-transfer': { steps: SHIPMENT_STEPS, impl: shipment },
  };

  // 做下一步。item.step 记着做到第几步。
  async function step(kind, item, opts) {
    const def = KINDS[kind];
    if (!def) throw new Error(`没有这个功能：${kind}`);
    item = JSON.parse(JSON.stringify(item || {}));
    const ctx = makeCtx(item, opts);
    item.step = Number(item.step || 0);
    if (item.step >= def.steps.length) return { item, logs: ctx.logs, done: true };
    const [name, stage] = def.steps[item.step];
    item.stage = stage;
    try {
      await def.impl[name](item, ctx);
      item.step += 1;
      item.error = '';
      const done = item.step >= def.steps.length;
      if (done) item.stage = 'done';
      return { item, logs: ctx.logs, done };
    } catch (e) {
      if (e instanceof Skip) {
        item.stage = 'skipped';
        item.skipReason = e.message;
        ctx.log(`跳过：${e.message}`);
        return { item, logs: ctx.logs, done: true };
      }
      if (e instanceof Pause) {
        ctx.log(`暂停：${e.message}`);
        return { item, logs: ctx.logs, done: false, pause: e.message };
      }
      ctx.log(`出错：${e.message}`);
      return { item, logs: ctx.logs, done: false, error: e.message || String(e) };
    }
  }

  window.__wbOps = {
    version: VERSION, step, kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.steps.map(([n, s]) => ({ name: n, stage: s }))])),
    _internal: { listFiles, findEquipment, ordersOfType, generateTicketPdf, currentUser, action, api, watermarkAndCompress },
  };
})();
