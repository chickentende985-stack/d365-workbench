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
  const VERSION = '2.0.0';
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
  const PRE_ARRIVAL = 1;
  const PRE_DEALER = 2;
  const PRE_SHIPMENT = 3;
  // 审批状态 mcs_approvalstatus：40 Approved，70 Reopen Approved
  const APPROVED = [40, 70];
  const FINISHED_STATUS = [70, 80, 90]; // 现场完工 / 审核中 / 已完成
  // 操作记录 mcs_service_applog 的操作代码：10 接单 20 出发 30 到达 40 现场完工 50 服务完工
  const LOG = { accept: 10, setOff: 20, arrive: 30, onSite: 40, complete: 50 };
  const TRAVEL_GROUND = 40;          // Ground Transportation
  const ARRIVAL_ABNORMAL = 30;       // 异常到达
  const REASON_WEAK_SIGNAL = 20;     // Cell phone signal is weak（和以前脚本选的“手机 GPS 信号不佳”一样）
  const TRAINING_NO = 0;
  const USAGE_USABLE = 10;           // Equipment Usage Status = Usable

  // 附件类型代码和英文名（Uploader 按类型给文件起的默认名）
  const FILE = {
    nameplate: { type: '001', name: 'Nameplate number', label: '铭牌号' },
    far: { type: '002', name: 'Whole machine far shot', label: '整机远照' },
    hours: { type: '003', name: 'Working hours photo', label: '工时照' },
    other: { type: '011', name: 'Other photos', label: '其他照片' },
    ticket: { type: '118', name: 'Service Ticket', label: 'Service Ticket' },
  };
  const HANDOVER_PHOTOS = [FILE.nameplate, FILE.far, FILE.hours, FILE.other];
  const FILE_HOURS2 = { type: '003', name: 'Working hours photo 2', label: '第二张工时照' };

  // 照片文件夹里的 1～5 号照片 → 附件类型（和以前脚本的规则一样）：
  //   一般：1 铭牌、2 整机远照、3 工时照、4 其他照片；
  //   有 5 号时：PDI / 交机 4 号不用、5 号当其他照片；防锈 3、4 都是工时照（第二张叫 Working hours photo 2）、5 号当其他照片。
  function folderPhotoRules(kind, keys) {
    const five = keys.includes('5');
    if (kind === 'rust' && five) {
      return [['1', FILE.nameplate], ['2', FILE.far], ['3', FILE.hours], ['4', FILE_HOURS2], ['5', FILE.other]];
    }
    if (five) return [['1', FILE.nameplate], ['2', FILE.far], ['3', FILE.hours], ['5', FILE.other]];
    return [['1', FILE.nameplate], ['2', FILE.far], ['3', FILE.hours], ['4', FILE.other]];
  }

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
        if (!has(lat) || !has(lng)) {
          const loc = await fallbackLocation(item, ctx);
          if (!loc) throw new Pause(`交机单没有设备位置，PDI ${item.pdiOrderNumber} 里也没有。请在交机单上点 Select Equipment Location 选好位置（或在工作台“设置”里填默认设备位置），然后点“继续”`);
          Object.assign(payload, loc.payload);
          ctx.log(`设备位置用${loc.source}：${loc.text}`);
          await patchOrder(item, ctx, payload, '出发（Ground Transportation）');
          await appLog(item, ctx, LOG.setOff);
          return ctx.log('已出发');
        }
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
      const o = item.sim.newOrder ? {} : await readOrder(item.orderId, 'mcs_ispassed,mcs_isneedonsitetrainingnew,mcs_existfault,mcs_acceptancepassed,mcs_systemrunningtime,mcs_handoverdate,_mcs_personnel_30_value,_mcs_engineer_value,mcs_equipmentusagestatus');
      const payload = {};
      if (!has(o.mcs_equipmentusagestatus)) payload.mcs_equipmentusagestatus = USAGE_USABLE;
      if (o.mcs_ispassed !== true) payload.mcs_ispassed = true;
      if (o.mcs_isneedonsitetrainingnew !== TRAINING_NO) payload.mcs_isneedonsitetrainingnew = TRAINING_NO;
      if (o.mcs_existfault !== false) payload.mcs_existfault = false;
      if (o.mcs_acceptancepassed !== true) payload.mcs_acceptancepassed = true;
      // 工时：Excel 里写了就用写的，否则用 PDI 的；必须大于设备累计运行时间
      let hours = Number(item.workingHours);
      if (!(hours > 0) && item.folder && Number(item.folder.hours) >= 0 && item.folder.hours !== '') hours = Math.max(Number(item.folder.hours), 0.1);
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
      if (Object.keys(payload).length) await patchOrder(item, ctx, payload, `写入 Assessment Pass、无需培训、无故障、Check Passed、Usable、工时 ${hours}`);
    },

    // 7. 照片：PDI 的铭牌、远照、工时照、其他照片（PDI 没有其他照片就从 PDI 别的图片里挑一张不重复的）
    async photos(item, ctx) {
      const st = await orderStatus(item, ctx);
      if (st !== ST.Arrived && st !== ST.Rejected) return;
      if (item.folder) return uploadFolderPhotos(item, ctx, 'handover'); // 交机（用文件夹里的照片）
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
        const o = await readOrder(item.orderId, 'mcs_consultationorderid,_mcs_customer_value,mcs_equipmentcontact1,mcs_equipmentcontacttel,mcs_customercontact,mcs_telephone,mcs_equipmentusagestatus');
        const payload = {};
        await fillContact(item, ctx, o, payload);
        // 之前因为 Equipment Usage Status 空着停下的单：继续时补上 Usable
        if (!has(o.mcs_equipmentusagestatus)) payload.mcs_equipmentusagestatus = USAGE_USABLE;
        if (Object.keys(payload).length) await patchOrder(item, ctx, payload, '补填联系人 / Equipment Usage Status = Usable');
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

  // =====================================================================
  // 通用：接单、设备位置、出发、到达、照片、现场完工、提交审核
  // （PDI、经销商 PDI、防锈都用这些；交机还是用上面 handover 里的）
  // =====================================================================

  // 没有设备位置时：这台机别的订单里的位置 → 工作台“设置”里的默认设备位置
  async function fallbackLocation(item, ctx) {
    if (item.equipmentId) {
      const rows = await query(ORDERS, 'mcs_consultationorderid,mcs_name,mcs_endlatitude,mcs_endlongitude,mcs_engineerdestination,mcs_equipmentlocation',
        `_mcs_equipment_value eq ${item.equipmentId} and mcs_endlatitude ne null and mcs_endlongitude ne null`, '&$orderby=createdon desc&$top=5');
      const hit = rows.find((r) => r.mcs_consultationorderid !== item.orderId) || rows[0];
      if (hit) {
        const addr = clean(hit.mcs_engineerdestination || hit.mcs_equipmentlocation);
        return {
          source: `这台机的订单 ${hit.mcs_name} 里的位置`, text: addr || `${hit.mcs_endlatitude}, ${hit.mcs_endlongitude}`,
          payload: { mcs_endlatitude: hit.mcs_endlatitude, mcs_endlongitude: hit.mcs_endlongitude, mcs_engineerdestination: addr, mcs_equipmentlocation: addr },
        };
      }
    }
    const d = ctx.opts.settings?.defaultLocation || {};
    const lat = Number(d.lat);
    const lng = Number(d.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) {
      const addr = clean(d.address);
      return {
        source: '工作台设置里的默认设备位置', text: addr || `${lat}, ${lng}`,
        payload: { mcs_endlatitude: lat, mcs_endlongitude: lng, mcs_engineerdestination: addr, mcs_equipmentlocation: addr },
      };
    }
    return null;
  }

  // 我的人员记录（Personnel）：派单给自己时用
  let myPerson = null;
  async function myPersonnel() {
    if (myPerson) return myPerson;
    const u = await currentUser();
    const rows = await query('mcs_personnels', 'mcs_personnelid,mcs_name', `_mcs_systemuserid_value eq ${u.id} and statecode eq 0`, '&$top=2');
    if (!rows.length) throw new Error('找不到你的账号对应的人员（Personnel）');
    myPerson = { id: guid(rows[0].mcs_personnelid), name: clean(rows[0].mcs_name) };
    return myPerson;
  }

  // 派单（和网页上 Assign 按钮调的接口一样）
  async function assignOrder(personId, orderId) {
    const { result, raw } = await action('mcs_ConsultationOrderAssignApi', { PersonnelId: personId, Items: [guid(orderId)] });
    if (result && result.Result === false) throw new Error(`派单接口返回失败：${result.Description || raw?.Result}`);
    return result?.Description || '';
  }

  // 按姓名找已开通账号的人员（派单用，和以前脚本一样）
  async function findDispatchPerson(target) {
    const name = clean(target);
    if (!name) throw new Error('没填“转移给 / 派给”');
    const rows = await query('mcs_personnels', 'mcs_personnelid,mcs_name,_mcs_systemuserid_value,_mcs_dealerid_value',
      `contains(mcs_name,'${esc(name)}') and mcs_accountstatus eq 3 and _mcs_systemuserid_value ne null and statecode eq 0`, '&$top=10');
    let list = rows;
    const exact = rows.filter((r) => clean(r.mcs_name).toLowerCase() === name.toLowerCase());
    if (exact.length === 1) list = exact;
    if (list.length !== 1) {
      throw new Error(list.length
        ? `“${name}”匹配到 ${list.length} 位人员（${list.map((x) => clean(x.mcs_name)).join('、')}），请写能唯一匹配的姓名`
        : `找不到账号已开通的人员“${name}”，请检查拼写`);
    }
    return { id: guid(list[0].mcs_personnelid), name: clean(list[0].mcs_name), dealerId: guid(list[0]._mcs_dealerid_value) };
  }

  // 接单：Dispatched / Transferred / Refused 直接接；Created（还没派单）先派给自己再接
  async function acceptOrder(item, ctx) {
    let st = await orderStatus(item, ctx);
    if (st === ST.Created) {
      const me2 = await myPersonnel();
      await ctx.write(`派单给自己（${me2.name}）`, () => assignOrder(me2.id, item.orderId), setSim(item, { status: ST.Dispatched }));
      st = await orderStatus(item, ctx);
      if (st === ST.Created) throw new Pause(`订单 ${item.orderNumber} 还是 Created，派不到你名下。请先在网页上派单给你，再点“继续”`);
      ctx.log(`已派单给自己（${me2.name}）`);
    }
    if (![ST.Dispatched, ST.Transferred, ST.Refused].includes(st)) return;
    await ctx.write('接单（mcs_ConsultationOrderAcceptApi）', async () => {
      const { result } = await action('mcs_ConsultationOrderAcceptApi', { FormId: guid(item.orderId), DispatchRecordId: ZERO_GUID });
      if (result && result.Result === false) throw new Error(`接单失败：${result.Description || '未知原因'}`);
    }, setSim(item, { status: ST.Accepted }));
    await appLog(item, ctx, LOG.accept);
    const after = await orderStatus(item, ctx);
    if (after !== ST.Accepted) throw new Pause(`接单后状态是 ${STATUS_TEXT[after] || after}（可能要先派单给你）。处理好后点“继续”`);
    ctx.log('已接单');
  }

  async function setOffOrder(item, ctx) {
    const st = await orderStatus(item, ctx);
    if (![ST.Accepted, ST.Paused].includes(st)) return;
    const o = item.sim.newOrder ? {} : await readOrder(item.orderId, 'mcs_endlatitude,mcs_endlongitude');
    const payload = { mcs_status: ST.Departed, mcs_travelmode: TRAVEL_GROUND, mcs_estimatedarrivaldate: new Date(Date.now() + 3600 * 1000).toUTCString() };
    if (!has(o.mcs_endlatitude) || !has(o.mcs_endlongitude)) {
      const loc = await fallbackLocation(item, ctx);
      if (!loc) throw new Pause(`订单 ${item.orderNumber} 没有设备位置。请在订单上点 Select Equipment Location 选好位置（或在工作台“设置”里填默认设备位置），然后点“继续”`);
      Object.assign(payload, loc.payload);
      ctx.log(`设备位置用${loc.source}：${loc.text}`);
    }
    await patchOrder(item, ctx, payload, '出发（Ground Transportation）');
    await appLog(item, ctx, LOG.setOff);
    ctx.log('已出发');
  }

  async function arriveOrder(item, ctx) {
    const st = await orderStatus(item, ctx);
    if (st !== ST.Departed) return;
    await patchOrder(item, ctx, {
      mcs_status: ST.Arrived, mcs_arrivaltype: ARRIVAL_ABNORMAL, mcs_normalarrived: false,
      mcs_reasonofabnormalarrival: REASON_WEAK_SIGNAL, mcs_servicemileage: 0,
    }, '到达（异常到达：手机信号弱）');
    await appLog(item, ctx, LOG.arrive);
    ctx.log('已到达');
  }

  function b64ToBlob(b64, type) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type || 'application/octet-stream' });
  }

  // 照片文件夹里的照片：工作台在做这一步时把文件内容一起送进来（opts.photos）
  async function uploadFolderPhotos(item, ctx, kind) {
    const photos = ctx.opts.photos || {};
    const keys = Object.keys(item.folder?.files || {});
    const rules = folderPhotoRules(kind, keys);
    const missing = rules.filter(([k]) => !keys.includes(k)).map(([k]) => `${k}.jpg`);
    if (missing.length) throw new Error(`照片文件夹“${item.folder?.dir || item.machineNo}”里少了 ${missing.join('、')}`);
    const existing = item.sim.newOrder ? [] : (await listFiles(item.orderId)).map(fileType);
    const count = (t) => existing.filter((x) => x === t).length + (item.sim.files || []).filter((x) => x === t).length;
    item.uploaded ||= [];
    for (const [key, spec] of rules) {
      if (item.uploaded.includes(key)) continue;
      const need = rules.filter(([, sp]) => sp.type === spec.type).findIndex(([k]) => k === key) + 1; // 同类型第几张
      if (count(spec.type) >= need) {
        ctx.log(`${spec.label}（${key} 号）订单上已经有了，不重复上传`);
        item.uploaded.push(key);
        continue;
      }
      const p = photos[key];
      if (!p?.b64) throw new Error(`没有读到照片 ${key} 号（${item.folder?.files?.[key] || ''}）`);
      const ext = extOf(p.name, 'jpg');
      const blob = b64ToBlob(p.b64, ext === 'png' ? 'image/png' : 'image/jpeg');
      ctx.log(`上传 ${spec.label}（${p.name}）`);
      await uploadFile(item, ctx, blob, spec, ext);
      item.uploaded.push(key);
    }
  }

  // 订单上要写的字段（只改空的 / 不对的）：Usable、机型、吨位、Check Passed、工时，防锈再加设备位置 uk、保修 60 个月
  async function writeOrderFields(item, ctx, kind) {
    const st = await orderStatus(item, ctx);
    if (FINISHED_STATUS.includes(st) && st !== ST.CompletionOnSite) return;
    const sel = 'mcs_equipmentusagestatus,mcs_model,mcs_tonnage,mcs_acceptancepassed,mcs_systemrunningtime,mcs_equipmentlocation,mcs_warrantypolicymonth';
    const o = item.sim.newOrder ? {} : await readOrder(item.orderId, sel);
    const payload = {};
    const changes = [];
    const folder = item.folder || {};
    if (!has(o.mcs_equipmentusagestatus)) { payload.mcs_equipmentusagestatus = USAGE_USABLE; changes.push('Usable'); }
    if (!has(o.mcs_model)) {
      if (!folder.model) throw new Error(`Model 是空的，但照片文件夹名里没有机型（要按“机台号_机型_吨位_工作时间”命名）`);
      payload.mcs_model = folder.model; changes.push(`机型 ${folder.model}`);
    }
    if (!has(o.mcs_tonnage)) {
      const t = Number(String(folder.tonnage || '').replace(/[^\d.]/g, ''));
      if (!(t > 0)) throw new Error(`Tonnage 是空的，但照片文件夹名里没有吨位（要按“机台号_机型_吨位_工作时间”命名）`);
      payload.mcs_tonnage = Math.ceil(t); changes.push(`吨位 ${Math.ceil(t)}`);
    }
    if (o.mcs_acceptancepassed !== true) { payload.mcs_acceptancepassed = true; changes.push('Check Passed'); }
    if (kind === 'rust' || kind === 'pdi-dealer') {
      if (!has(o.mcs_equipmentlocation)) { payload.mcs_equipmentlocation = 'uk'; changes.push('Equipment Location = uk'); }
    }
    if (kind === 'rust' && !has(o.mcs_warrantypolicymonth)) { payload.mcs_warrantypolicymonth = 60; changes.push('保修 60 个月'); }
    // 工时：文件夹名里的（0 当 0.1）；必须大于设备累计运行时间
    const floor = await cumulativeHours(item);
    const cur = Number(o.mcs_systemrunningtime);
    if (!(cur > 0) || (floor !== null && !(cur > floor))) {
      let hours = Number(String(item.workingHours ?? folder.hours ?? '').replace(/[^\d.]/g, ''));
      if (!Number.isFinite(hours) || String(item.workingHours ?? folder.hours ?? '').trim() === '') {
        throw new Error(`Current Operating Hours 是空的，但照片文件夹名里没有工作时间（要按“机台号_机型_吨位_工作时间”命名）`);
      }
      if (!(hours > 0)) hours = 0.1;
      if (floor !== null && hours <= floor) {
        const raised = hoursJustAbove(floor);
        ctx.log(`工时 ${hours} 不大于设备累计运行时间 ${floor}，改为 ${raised}`);
        hours = raised;
      }
      payload.mcs_systemrunningtime = hours;
      changes.push(`工时 ${hours}`);
    }
    if (Object.keys(payload).length) await patchOrder(item, ctx, payload, `写入 ${changes.join('、')}`);
    else ctx.log('Usable、机型、吨位、Check Passed、工时都已经有了');
  }

  async function cumulativeHours(item) {
    if (!item.equipmentId) return null;
    const eq = (await query('mcs_equipments', 'mcs_accumulatedrunningtime', `mcs_equipmentid eq ${item.equipmentId}`))[0] || {};
    const v = Number(eq.mcs_accumulatedrunningtime);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  // 现场完工前网页要求的字段（setCompletionCheckData：到货预验收 / 防锈）
  const PDI_REQUIRED = [
    ['_mcs_engineer_value', 'Engineer'], ['_mcs_productgroupid_value', 'Product Group'],
    ['mcs_equipmentusagestatus', 'Equipment Usage Status'], ['mcs_equipmentstatus', 'Equipment Status'], ['mcs_model', 'Model'],
  ];
  async function checkPdiReady(item, ctx) {
    const o = await readOrder(item.orderId, `${PDI_REQUIRED.map(([f]) => f).join(',')},mcs_systemrunningtime`);
    for (const [k, v] of Object.entries(item.sim.fields || {})) o[k] = v;
    const missing = PDI_REQUIRED.filter(([f]) => !has(o[f])).map(([, l]) => l);
    if (!(Number(o.mcs_systemrunningtime) > 0)) missing.push('Current Operating Hours');
    if (missing.length) throw new Pause(`这些必填项是空的：${missing.join('、')}。在订单 ${item.orderNumber} 上补好后点“继续”`);
  }

  async function completeOnSiteOrder(item, ctx, check) {
    const st = await orderStatus(item, ctx);
    if (FINISHED_STATUS.includes(st) || st === ST.Rejected) return;
    const allowed = item.dealerMode || item.kind === 'rust' ? [ST.Accepted, ST.Arrived] : [ST.Arrived];
    if (!allowed.includes(st)) throw new Error(`现在状态是 ${STATUS_TEXT[st] || st}，还不能现场完工`);
    if (!item.sim.newOrder) await check(item, ctx);
    const u = await currentUser();
    await appLog(item, ctx, LOG.onSite);
    await patchOrder(item, ctx, { mcs_status: ST.CompletionOnSite, 'mcs_systemuser@odata.bind': `/systemusers(${u.id})` }, '现场完工');
    await uploadCompletionPreview(item, ctx);
    ctx.log('已现场完工');
  }

  // PDI 自己的 Service Ticket：和 Service Completion 标签里点“生成 PDF”一样，生成后上传到附件
  async function uploadOwnTicket(item, ctx) {
    const st = await orderStatus(item, ctx);
    if (st === ST.InApproval || st === ST.Completed) return;
    const have = item.sim.newOrder ? new Set(item.sim.files || []) : await orderFileTypes(item, ctx);
    if (have.has(FILE.ticket.type)) return ctx.log('Service Ticket 已经上传过了');
    if (ctx.dry) {
      ctx.log('（不执行）从这张单的 Service Completion 生成 Service Ticket PDF 并上传');
      (item.sim.files ||= []).push(FILE.ticket.type);
      return;
    }
    ctx.log('从 Service Completion 生成 Service Ticket PDF…');
    const docx = await renderDocx(item.orderId, 'ConsultationOrderTemplate', true);
    const { result: temp } = await action('mcs_inittempfile', {});
    if (!temp?.Url) throw new Error('mcs_inittempfile 没有返回地址');
    await putBlob(temp.Url, docx);
    // 网页生成 PDF 时会把文件路径记到订单的 mcs_pdfpath 上，这里也照做
    await api(`${ORDERS}(${guid(item.orderId)})`, { method: 'PATCH', headers: { 'If-Match': '*' }, body: { mcs_pdfpath: temp.FileName } }).catch(() => {});
    const { raw: conv } = await action('mcs_convertpdf', { FileName: temp.FileName, DisplayName: `${guid(item.orderId)}.docx` });
    const pdfUrl = String(conv?.Result || '').replace(/^"|"$/g, '');
    if (!pdfUrl) throw new Error('转换 PDF 没有返回地址');
    const blob = await download(pdfUrl, '生成的 Service Ticket');
    await uploadFile(item, ctx, blob, FILE.ticket, 'pdf');
    ctx.log('已上传 Service Ticket');
  }

  function parseCumulative(text) {
    const m = String(text || '').match(/Cumulative Running Time\s*[(（]\s*(\d+(?:\.\d+)?)\s*hours?\s*[)）]/i)
      || String(text || '').match(/累计运行时间\s*[(（]\s*(\d+(?:\.\d+)?)\s*小时?\s*[)）]/);
    return m ? Number(m[1]) : NaN;
  }

  // 提交审核：D365 说工时低于累计运行时间时，调高后再提交（最多两次）
  async function submitOrder(item, ctx) {
    const st = await orderStatus(item, ctx);
    if (st === ST.InApproval || st === ST.Completed) return ctx.log(`已经是 ${STATUS_TEXT[st]}`);
    if (st !== ST.CompletionOnSite && st !== ST.Rejected) throw new Error(`现在状态是 ${STATUS_TEXT[st] || st}，不能提交审核`);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await ctx.write('提交审核（mcs_ConsultationOrderSubmitApprovalApi）', async () => {
          const { result } = await action('mcs_ConsultationOrderSubmitApprovalApi', { FormId: guid(item.orderId) });
          if (result && result.Result === false) throw new Error(`提交审核失败：${result.Description || '未知原因'}`);
          if (result?.Description) ctx.log(`D365 回复：${result.Description}`);
        }, setSim(item, { status: ST.InApproval }));
        break;
      } catch (e) {
        const floor = parseCumulative(e.message);
        const empty = /Machine running hours|System mile \(KM\)|System volume/i.test(e.message);
        if (attempt >= 2 || (!Number.isFinite(floor) && !empty)) throw e;
        const cur = Number((await readOrder(item.orderId, 'mcs_systemrunningtime')).mcs_systemrunningtime);
        const hours = Number.isFinite(floor) ? hoursJustAbove(floor) : Math.max(cur || 0, 0.1);
        ctx.log(Number.isFinite(floor) ? `D365 要求工时大于累计运行时间 ${floor}，改为 ${hours} 后重新提交` : 'D365 说工时是空的，补写后重新提交');
        await patchOrder(item, ctx, { mcs_systemrunningtime: hours }, `工时 ${hours}`);
      }
    }
    await appLog(item, ctx, LOG.complete);
    const after = await orderStatus(item, ctx);
    if (![ST.InApproval, ST.Completed].includes(after)) throw new Error(`提交后状态还是 ${STATUS_TEXT[after] || after}`);
    ctx.log(`已提交审核（${STATUS_TEXT[after]}）`);
  }

  async function equipmentHasDealer(equipmentId) {
    const { data } = await api(`mcs_equipments(${guid(equipmentId)})?$select=_mcs_dealerid_value`, { formatted: true });
    return data._mcs_dealerid_value ? (fmt(data, '_mcs_dealerid_value') || '经销商') : '';
  }

  async function findOrders(equipmentId, type, extra = '') {
    return (await query(ORDERS, 'mcs_consultationorderid,mcs_name,mcs_status,statecode,createdon,mcs_approvalstatus,mcs_preacceptancetypes,_ownerid_value,_mcs_engineer_value,mcs_serviceordermode,_mcs_dealerid_value',
      `_mcs_equipment_value eq ${guid(equipmentId)} and mcs_ordertype eq ${type}${extra}`, '&$orderby=createdon desc&$top=50'))
      .filter((o) => Number(o.statecode) === 0 && Number(o.mcs_status) !== ST.Canceled);
  }

  async function createOrder(item, ctx, body, label) {
    if (ctx.dry) {
      ctx.log(`（不执行）新建${label}：${JSON.stringify(body)}`);
      item.orderId = ZERO_GUID;
      item.orderNumber = '（演练：新单）';
      item.sim.status = ST.Created;
      item.sim.newOrder = true;
      return;
    }
    const { entityId } = await api(ORDERS, { method: 'POST', body, headers: { Prefer: 'return=minimal' } });
    if (!entityId) throw new Error(`${label}已创建，但没有返回订单 ID`);
    item.orderId = entityId;
    item.orderNumber = (await readOrder(entityId, 'mcs_name')).mcs_name || '';
    ctx.log(`新建${label} ${item.orderNumber}`);
  }

  function useOrder(item, o) {
    item.orderId = guid(o.mcs_consultationorderid);
    item.orderNumber = o.mcs_name;
    item.dealerMode = Number(o.mcs_serviceordermode) === 20;
  }

  // =====================================================================
  // PDI（到港预验收）/ 经销商 PDI（代理商入库预验收）：用照片文件夹
  // =====================================================================
  function pdiKindOf(item) { return item.kind === 'pdi-dealer' ? 'pdi-dealer' : 'pdi'; }

  const pdi = {
    async resolve(item, ctx) {
      const dealerKind = pdiKindOf(item) === 'pdi-dealer';
      const label = dealerKind ? '经销商 PDI' : '到港 PDI';
      const eq = await findEquipment(item.machineNo);
      item.equipmentId = guid(eq.mcs_equipmentid);
      if (dealerKind && item.chain && !(await equipmentHasDealer(item.equipmentId))) throw new Skip('直销设备（没有经销商），不做经销商 PDI');
      const filter = dealerKind ? ` and mcs_preacceptancetypes eq ${PRE_DEALER}`
        : ` and (mcs_preacceptancetypes eq null or (mcs_preacceptancetypes ne ${PRE_DEALER} and mcs_preacceptancetypes ne ${PRE_SHIPMENT}))`;
      const orders = await findOrders(item.equipmentId, TYPE.Arrival, filter);
      const o = orders[0];
      if (o) {
        if (APPROVED.includes(Number(o.mcs_approvalstatus))) throw new Skip(`${label} ${o.mcs_name} Approval Status = Approved，已完成`);
        if ([ST.InApproval, ST.Completed].includes(Number(o.mcs_status)) || (item.chain && FINISHED_STATUS.includes(Number(o.mcs_status)))) {
          throw new Skip(`${label} ${o.mcs_name} 已是 ${fmt(o, 'mcs_status')}`);
        }
        useOrder(item, o);
        ctx.log(`用已有的${label} ${o.mcs_name}（${fmt(o, 'mcs_status')}）`);
      } else if (dealerKind && item.chain) {
        // 全流程里的经销商 PDI：没有就新建，并派给自己
        await createOrder(item, ctx, {
          'mcs_equipment@odata.bind': `/mcs_equipments(${item.equipmentId})`, mcs_ordertype: TYPE.Arrival, mcs_preacceptancetypes: PRE_DEALER,
        }, '经销商 PDI');
        item.dealerMode = true;
      } else {
        throw new Error(item.chain
          ? `找不到机号 ${item.machineNo} 的到港预验收订单。请先用“PDI转移”建单并转给这个账号，再继续`
          : `找不到机号 ${item.machineNo} 已有且没取消的${label}订单`);
      }
      if (!item.sim.newOrder) {
        const cur = await readOrder(item.orderId, 'mcs_serviceordermode');
        item.dealerMode = Number(cur.mcs_serviceordermode) === 20;
      }
    },
    accept: acceptOrder,
    // 经销商 PDI 没有出发 / 到达，接单后直接上传附件、现场完工
    async setOff(item, ctx) { if (!item.dealerMode) await setOffOrder(item, ctx); },
    async arrive(item, ctx) { if (!item.dealerMode) await arriveOrder(item, ctx); },
    async photos(item, ctx) {
      const st = await orderStatus(item, ctx);
      if (FINISHED_STATUS.includes(st) && st !== ST.CompletionOnSite) return;
      await uploadFolderPhotos(item, ctx, 'pdi');
    },
    async fields(item, ctx) { await writeOrderFields(item, ctx, pdiKindOf(item)); },
    async onSite(item, ctx) { await completeOnSiteOrder(item, ctx, checkPdiReady); },
    ticket: uploadOwnTicket,
    submit: submitOrder,
  };
  const PDI_STEPS = [
    ['resolve', 'created'], ['accept', 'accepting'], ['setOff', 'setting-off'], ['arrive', 'arriving'],
    ['photos', 'uploading'], ['fields', 'pdi-fields'], ['onSite', 'pdi-completing'], ['ticket', 'ticket'], ['submit', 'submitting'],
  ];

  // =====================================================================
  // 防锈运转：本月已做完的跳过，本月没做完的接着做，没有就新建
  // =====================================================================
  function monthStartIso() {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)).toISOString();
  }
  const rust = {
    async resolve(item, ctx) {
      const eq = await findEquipment(item.machineNo);
      item.equipmentId = guid(eq.mcs_equipmentid);
      const month = await findOrders(item.equipmentId, TYPE.RustProof, ` and createdon ge ${monthStartIso()}`);
      const finished = month.find((o) => FINISHED_STATUS.includes(Number(o.mcs_status)));
      if (finished) throw new Skip(`本月防锈订单 ${finished.mcs_name} 已是 ${fmt(finished, 'mcs_status')}`);
      const open = month[0];
      if (open) {
        useOrder(item, open);
        ctx.log(`本月已有防锈订单 ${open.mcs_name}（${fmt(open, 'mcs_status')}），接着做`);
        return;
      }
      try {
        await createOrder(item, ctx, { 'mcs_equipment@odata.bind': `/mcs_equipments(${item.equipmentId})`, mcs_ordertype: TYPE.RustProof }, '防锈订单');
      } catch (e) {
        // D365 不让新建（已有同类型订单）：按它说的单号找，没做完就接着做，做完了就跳过
        const no = String(e.message).match(/already has an order\s*\[([^\]]+)\]/i)?.[1] || String(e.message).match(/已有.*订单\s*[【[]([^】\]]+)[】\]]/)?.[1];
        if (!no) throw e;
        const rows = await query(ORDERS, 'mcs_consultationorderid,mcs_name,mcs_status,statecode,mcs_serviceordermode', `mcs_name eq '${esc(no)}'`, '&$top=1');
        const c = rows[0];
        if (c && Number(c.statecode) === 0 && ![...FINISHED_STATUS, ST.Canceled].includes(Number(c.mcs_status))) {
          useOrder(item, c);
          ctx.log(`D365 说已有防锈订单 ${no}（${fmt(c, 'mcs_status')}），接着做这张`);
          return;
        }
        throw new Skip(`已有同类型订单 ${no}，不重复创建`);
      }
      if (!item.sim.newOrder) item.dealerMode = Number((await readOrder(item.orderId, 'mcs_serviceordermode')).mcs_serviceordermode) === 20;
    },
    accept: acceptOrder,
    async photos(item, ctx) {
      const st = await orderStatus(item, ctx);
      if (FINISHED_STATUS.includes(st) && st !== ST.CompletionOnSite) return;
      await uploadFolderPhotos(item, ctx, 'rust');
    },
    async fields(item, ctx) { await writeOrderFields(item, ctx, 'rust'); },
    async onSite(item, ctx) { item.kind = 'rust'; await completeOnSiteOrder(item, ctx, checkPdiReady); },
    submit: submitOrder,
  };
  const RUST_STEPS = [
    ['resolve', 'created'], ['accept', 'accepting'], ['photos', 'uploading'], ['fields', 'rust-fields'],
    ['onSite', 'rust-completing'], ['submit', 'submitting'],
  ];

  // =====================================================================
  // PDI 创建 → 服务转移（永久转派）
  // =====================================================================
  async function permanentTransfer(item, ctx) {
    const target = clean(ctx.opts.fields?.transferTarget);
    if (!target) throw new Error('没填“转移给”');
    const u = await currentUser();
    if (!item.sim.newOrder) {
      const now = await readOrder(item.orderId, '_ownerid_value');
      if (now._ownerid_value && guid(now._ownerid_value) !== u.id) {
        return ctx.log(`负责人已是 ${fmt(now, '_ownerid_value')}，已经转派过`);
      }
    }
    if (item.sim.newOrder) return ctx.log(`（不执行）搜索“${target}”并永久转派`);
    const { result } = await action('Service_GetAllEngineerListApi', { OrderId: `${guid(item.orderId)}-${ORDER}`, FilterName: target, FilterCountry: '' });
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
    await ctx.write(`永久转派给 ${item.transferResolved}（Service_PermanenttransferApi）`, () => action('Service_PermanenttransferApi', {
      ServiceTransferParame: JSON.stringify({ personid: people[0].id, orderid: guid(item.orderId), entityNames: ORDER }),
    }));
    ctx.log(`已永久转派给 ${item.transferResolved}`);
  }

  const pdiTransfer = {
    async resolve(item, ctx) {
      const eq = await findEquipment(item.machineNo);
      item.equipmentId = guid(eq.mcs_equipmentid);
      const filter = ` and (mcs_preacceptancetypes eq null or (mcs_preacceptancetypes ne ${PRE_DEALER} and mcs_preacceptancetypes ne ${PRE_SHIPMENT}))`;
      const o = (await findOrders(item.equipmentId, TYPE.Arrival, filter))[0];
      const u = await currentUser();
      if (o) {
        if (o._ownerid_value && guid(o._ownerid_value) !== u.id) {
          throw new Skip(`已有到港 PDI ${o.mcs_name}，负责人已是 ${fmt(o, '_ownerid_value')}（${fmt(o, 'mcs_status')}），不用再转移`);
        }
        useOrder(item, o);
        ctx.log(`已有到港 PDI ${o.mcs_name}（${fmt(o, 'mcs_status')}），负责人还是自己，继续转移`);
        return;
      }
      try {
        await createOrder(item, ctx, {
          'mcs_equipment@odata.bind': `/mcs_equipments(${item.equipmentId})`, mcs_ordertype: TYPE.Arrival, mcs_preacceptancetypes: PRE_ARRIVAL,
        }, '到港 PDI');
      } catch (e) {
        if (/handed over|已交机|handover/i.test(e.message)) throw new Skip('设备已交机，D365 不允许创建到货预验收');
        throw e;
      }
    },
    transfer: permanentTransfer,
  };
  const PDI_TRANSFER_STEPS = [['resolve', 'created'], ['transfer', 'transfer-submitting']];

  // =====================================================================
  // 派单（Assign）：经销商 PDI 派单、防锈派单
  // =====================================================================
  async function assignTo(item, ctx) {
    const person = await findDispatchPerson(ctx.opts.fields?.transferTarget || ctx.opts.fields?.dispatchTarget);
    if (item.sim.newOrder) return ctx.log(`（不执行）派单（Assign）给 ${person.name}`);
    const o = await readOrder(item.orderId, 'mcs_name,mcs_status,_mcs_engineer_value,mcs_serviceordermode,_mcs_dealerid_value');
    if (guid(o._mcs_engineer_value) === person.id) return ctx.log(`工程师已经是 ${person.name}，不用再派`);
    if (Number(o.mcs_status) !== ST.Created) throw new Skip(`订单 ${o.mcs_name} 状态已是 ${fmt(o, 'mcs_status')}（工程师 ${fmt(o, '_mcs_engineer_value') || '空'}），不再派单`);
    const dealerId = guid(o._mcs_dealerid_value);
    if (person.dealerId && dealerId && person.dealerId !== dealerId) {
      throw new Error(`${person.name} 所属经销商和订单 ${o.mcs_name} 的经销商（${fmt(o, '_mcs_dealerid_value')}）不一致，系统不允许这样派单`);
    }
    await ctx.write(`派单（Assign）给 ${person.name}`, () => assignOrder(person.id, item.orderId));
    if (ctx.dry) return;
    let after = o;
    for (let i = 0; i < 10 && guid(after._mcs_engineer_value) !== person.id; i += 1) {
      await sleep(1500);
      after = await readOrder(item.orderId, 'mcs_status,_mcs_engineer_value');
    }
    if (guid(after._mcs_engineer_value) !== person.id && Number(after.mcs_status) === ST.Created) {
      throw new Error(`派单接口已调用，但订单工程师还是 ${fmt(after, '_mcs_engineer_value') || '空'}，请人工核对`);
    }
    ctx.log(`已派单给 ${person.name}（${fmt(after, 'mcs_status') || STATUS_TEXT[after.mcs_status]}）`);
  }

  const dealerPdiAssign = {
    async resolve(item, ctx) {
      const eq = await findEquipment(item.machineNo);
      item.equipmentId = guid(eq.mcs_equipmentid);
      const o = (await findOrders(item.equipmentId, TYPE.Arrival, ` and mcs_preacceptancetypes eq ${PRE_DEALER}`))[0];
      if (o) {
        useOrder(item, o);
        ctx.log(`已有经销商 PDI ${o.mcs_name}（${fmt(o, 'mcs_status')}）`);
        return;
      }
      await createOrder(item, ctx, {
        'mcs_equipment@odata.bind': `/mcs_equipments(${item.equipmentId})`, mcs_ordertype: TYPE.Arrival, mcs_preacceptancetypes: PRE_DEALER,
      }, '经销商 PDI');
    },
    assign: assignTo,
  };
  const rustDispatch = {
    async resolve(item, ctx) {
      const eq = await findEquipment(item.machineNo);
      item.equipmentId = guid(eq.mcs_equipmentid);
      const month = await findOrders(item.equipmentId, TYPE.RustProof, ` and createdon ge ${monthStartIso()}`);
      const finished = month.find((o) => FINISHED_STATUS.includes(Number(o.mcs_status)));
      if (finished) throw new Skip(`本月已做过防锈运转（${finished.mcs_name} ${fmt(finished, 'mcs_status')}）`);
      const created = month.find((o) => Number(o.mcs_status) === ST.Created);
      if (!created) {
        throw new Skip(month.length ? `本月防锈订单 ${month[0].mcs_name} 状态是 ${fmt(month[0], 'mcs_status')}，不是 Created` : '本月没有已创建的防锈订单');
      }
      useOrder(item, created);
      ctx.log(`找到 Created 状态的防锈订单 ${created.mcs_name}`);
    },
    assign: assignTo,
  };
  const ASSIGN_STEPS = [['resolve', 'dispatch-checking'], ['assign', 'dispatch-submitting']];

  // =====================================================================
  // 设备变更：新建（或接着用没提交的）设备变更单 → 写字段 → 提交审批
  // 新建时 D365 会自动把设备现在的资料带进来（Create 插件），所以先只建单、再写要改的字段。
  // =====================================================================
  const EC_SET = 'mcs_equipmentchangerequests';
  const EC_TYPES = { 10: 'Host', 20: 'Second-hand Machine', 30: 'Sample Machine', 40: 'Legal Machine', 50: 'Trial Machine', 60: 'Spare Machine', 70: 'Rental Machine', 80: 'Trial Machine' };
  const EC_SELECT = 'mcs_name,mcs_changestatus,mcs_source,_mcs_servicedealerid_value,_mcs_dealerid_value,_mcs_personnel_30_value,_mcs_servicemanagerid_value,mcs_currentworkingtime,cr0c0_changeremark,mcs_equipmentusagestatus,mcs_equipmentaddress,mcs_modelmachinetype,mcs_equipmenttype,mcs_warrantypolicyvalue,mcs_warrantypolicymonth';
  const containsEveryWord = (field, text) => `(${String(text || '').split(/\s+/).filter(Boolean).map((w) => `contains(${field},'${esc(w)}')`).join(' and ')})`;
  const normText = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();

  async function resolveDealer(value) {
    const name = clean(value);
    const e = esc(name);
    const rows = await query('mcs_agents', 'mcs_agentid,mcs_name,mcs_code',
      `statecode eq 0 and _mcs_parentdealerid_value eq null and mcs_dealertype eq 20 and (mcs_code eq '${e}' or mcs_dealercode eq '${e}' or ${containsEveryWord('mcs_name', name)})`, '&$top=20');
    let list = rows;
    const exact = rows.filter((r) => normText(r.mcs_name) === normText(name) || normText(r.mcs_code) === normText(name));
    if (exact.length === 1) list = exact;
    if (list.length !== 1) throw new Error(list.length ? `Dealer“${name}”匹配到 ${list.length} 个：${list.slice(0, 6).map((r) => clean(r.mcs_name)).join('；')}` : `找不到 Dealer“${name}”`);
    return { id: guid(list[0].mcs_agentid), name: clean(list[0].mcs_name) };
  }
  async function resolvePerson(value, label) {
    const name = clean(value);
    if (!name) throw new Error(`没填 ${label}（可以在工作台“设置”里填默认值）`);
    const rows = await query('mcs_personnels', 'mcs_personnelid,mcs_name,mcs_code',
      `statecode eq 0 and (${containsEveryWord('mcs_name', name)} or mcs_code eq '${esc(name)}')`, '&$top=20');
    let list = rows;
    const exact = rows.filter((r) => normText(r.mcs_name) === normText(name) || normText(r.mcs_code) === normText(name));
    if (exact.length === 1) list = exact;
    if (list.length !== 1) throw new Error(list.length ? `${label}“${name}”匹配到 ${list.length} 人：${list.slice(0, 6).map((r) => `${clean(r.mcs_name)}（${r.mcs_code || '无工号'}）`).join('；')}` : `找不到 ${label}“${name}”`);
    return { id: guid(list[0].mcs_personnelid), name: clean(list[0].mcs_name) };
  }

  // Excel 这一行的设置 + 工作台“设置”里的默认值
  async function ecSettings(item, ctx) {
    if (item.ec) return item.ec;
    const f = ctx.opts.fields || {};
    const d = ctx.opts.settings?.ecDefaults || {};
    const pick = (k, dk) => (f[k] !== undefined && f[k] !== null && String(f[k]).trim() !== '' ? f[k] : d[dk || k]);
    const intOr = (v, label, min, max) => {
      const t = String(v ?? '').trim();
      if (!t) return null;
      const n = Number(t);
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} 要填 ${min}～${max} 的整数（现在是“${t}”）`);
      return n;
    };
    const dealerText = clean(f.ecDealer);
    const mainText = clean(f.ecDealerMain);
    const s = {
      dealer: dealerText ? await resolveDealer(dealerText) : null,
      mainDealer: mainText ? await resolveDealer(mainText) : (dealerText ? await resolveDealer(dealerText) : null),
      engineer: await resolvePerson(pick('ecEngineer'), 'Responsible Service Engineer'),
      manager: await resolvePerson(pick('ecManager'), 'Service Manager'),
      hours: Number(pick('ecHours') ?? 1),
      remark: clean(pick('ecRemark')),
      usage: clean(d.ecUsage || 'Usable'), address: clean(d.ecAddress || 'uk'), model: clean(d.ecModel || 'sy'),
      type: f.ecType ? Number(f.ecType) : null,
      warrantyValue: intOr(f.ecWarrantyValue, 'Warranty Policy Value', 0, 2147483647),
      warrantyMonth: intOr(f.ecWarrantyMonth, 'Warranty Policy Month', 1, 60),
    };
    if (!Number.isFinite(s.hours) || s.hours < 0) throw new Error('Current working time 要填数字');
    if (!s.remark) throw new Error('没填 Change Remarks（可以在工作台“设置”里填默认值）');
    if (!s.dealer && !s.mainDealer && !s.type && s.warrantyValue === null && s.warrantyMonth === null) {
      throw new Error('Dealer、Service Dealer、Equipment Type、质保都没填，没有要变更的内容');
    }
    item.ec = s;
    return s;
  }

  const equipmentChange = {
    async resolve(item, ctx) {
      const s = await ecSettings(item, ctx);
      const rows = await query('mcs_equipments', 'mcs_equipmentid,mcs_name,_mcs_servicedealerid_value,_mcs_dealerid_value,mcs_equipmenttype,mcs_warrantypolicyvalue,mcs_warrantypolicymonth',
        `mcs_name eq '${esc(item.machineNo)}'`, '&$top=2');
      if (rows.length !== 1) throw new Skip(rows.length ? `D365 里有多台同名设备 ${item.machineNo}` : `D365 里找不到设备 ${item.machineNo}`);
      const eq = rows[0];
      item.equipmentId = guid(eq.mcs_equipmentid);
      const ok = (!s.dealer || guid(eq._mcs_servicedealerid_value) === s.dealer.id)
        && (!s.mainDealer || guid(eq._mcs_dealerid_value) === s.mainDealer.id)
        && (!s.type || Number(eq.mcs_equipmenttype) === s.type)
        && (s.warrantyValue === null || Number(eq.mcs_warrantypolicyvalue) === s.warrantyValue)
        && (s.warrantyMonth === null || Number(eq.mcs_warrantypolicymonth) === s.warrantyMonth);
      if (ok) throw new Skip('设备上已经是要改成的值了，不需要变更');
      const reqs = await query(EC_SET, 'mcs_equipmentchangerequestid,mcs_name,mcs_changestatus,createdon',
        `_mcs_equipment_value eq ${item.equipmentId} and statecode eq 0`, '&$orderby=createdon desc&$top=50');
      const pending = reqs.find((r) => Number(r.mcs_changestatus) === 20);
      if (pending) throw new Skip(`已有审批中的设备变更单 ${pending.mcs_name}`);
      const draft = reqs.find((r) => [10, 40].includes(Number(r.mcs_changestatus)));
      if (draft) {
        item.ecId = guid(draft.mcs_equipmentchangerequestid);
        item.orderNumber = draft.mcs_name;
        ctx.log(`找到没提交的设备变更单 ${draft.mcs_name}，接着用`);
        return;
      }
      const body = { 'mcs_equipment@odata.bind': `/mcs_equipments(${item.equipmentId})` };
      if (ctx.dry) {
        ctx.log(`（不执行）新建设备变更单：${JSON.stringify(body)}`);
        item.ecId = ZERO_GUID;
        item.orderNumber = '（演练：新单）';
        item.sim.newOrder = true;
        return;
      }
      const { entityId } = await api(EC_SET, { method: 'POST', body, headers: { Prefer: 'return=minimal' } });
      if (!entityId) throw new Error('设备变更单已创建，但没有返回 ID');
      item.ecId = entityId;
      await sleep(2000); // 等 D365 把设备资料带进来
      item.orderNumber = (await api(`${EC_SET}(${entityId})?$select=mcs_name`)).data.mcs_name || '';
      ctx.log(`新建设备变更单 ${item.orderNumber}`);
    },
    async fill(item, ctx) {
      const s = await ecSettings(item, ctx);
      const r = item.sim.newOrder ? {} : (await api(`${EC_SET}(${item.ecId})?$select=${EC_SELECT}`, { formatted: true })).data;
      if (!item.sim.newOrder && ![10, 40].includes(Number(r.mcs_changestatus))) return ctx.log(`设备变更单已是 ${fmt(r, 'mcs_changestatus')}`);
      const payload = {};
      const ch = [];
      const hours = Number.isFinite(Number(item.workingHours)) && String(item.workingHours ?? '').trim() !== '' ? Number(item.workingHours) : s.hours;
      const bind = (field, nav, set, ref, label) => {
        if (ref && guid(r[`_${field}_value`]) !== ref.id) { payload[`${nav}@odata.bind`] = `/${set}(${ref.id})`; ch.push(`${label} = ${ref.name}`); }
      };
      bind('mcs_servicedealerid', 'mcs_servicedealerid', 'mcs_agents', s.dealer, 'Service Dealer');
      bind('mcs_dealerid', 'mcs_dealerid', 'mcs_agents', s.mainDealer, 'Dealer');
      bind('mcs_personnel_30', 'mcs_personnel_30', 'mcs_personnels', s.engineer, 'Responsible Service Engineer');
      bind('mcs_servicemanagerid', 'mcs_servicemanagerid', 'mcs_personnels', s.manager, 'Service Manager');
      if (Number(r.mcs_currentworkingtime) !== hours) { payload.mcs_currentworkingtime = hours; ch.push(`Current working time = ${hours}`); }
      if (clean(r.cr0c0_changeremark) !== s.remark) { payload.cr0c0_changeremark = s.remark; ch.push(`Change Remarks = ${s.remark}`); }
      if (!has(r.mcs_equipmentusagestatus) && /usable|可用/i.test(s.usage)) { payload.mcs_equipmentusagestatus = USAGE_USABLE; ch.push('Equipment Usage Status = Usable'); }
      if (!has(r.mcs_equipmentaddress) && s.address) { payload.mcs_equipmentaddress = s.address; ch.push(`Equipment Address = ${s.address}`); }
      if (!has(r.mcs_modelmachinetype) && s.model) { payload.mcs_modelmachinetype = s.model; ch.push(`Model (Machine Type) = ${s.model}`); }
      if (s.type && Number(r.mcs_equipmenttype) !== s.type) { payload.mcs_equipmenttype = s.type; ch.push(`Equipment Type = ${EC_TYPES[s.type]}`); }
      if (s.warrantyValue !== null && Number(r.mcs_warrantypolicyvalue) !== s.warrantyValue) { payload.mcs_warrantypolicyvalue = s.warrantyValue; ch.push(`Warranty Policy Value = ${s.warrantyValue}`); }
      if (s.warrantyMonth !== null && Number(r.mcs_warrantypolicymonth) !== s.warrantyMonth) { payload.mcs_warrantypolicymonth = s.warrantyMonth; ch.push(`Warranty Policy Month = ${s.warrantyMonth}`); }
      if (!Object.keys(payload).length) return ctx.log('字段已经是要改成的值');
      await ctx.write(`写入 ${ch.join('；')}`, () => api(`${EC_SET}(${item.ecId})`, { method: 'PATCH', headers: { 'If-Match': '*' }, body: payload }));
      if (ctx.dry) return;
      // 写完核对一遍（有的字段 D365 可能不让改）
      const saved = (await api(`${EC_SET}(${item.ecId})?$select=${EC_SELECT}`, { formatted: true })).data;
      const bad = [];
      if (s.dealer && guid(saved._mcs_servicedealerid_value) !== s.dealer.id) bad.push(`Service Dealer 是“${fmt(saved, '_mcs_servicedealerid_value') || '空'}”`);
      if (s.mainDealer && guid(saved._mcs_dealerid_value) !== s.mainDealer.id) bad.push(`Dealer 是“${fmt(saved, '_mcs_dealerid_value') || '空'}”`);
      if (s.type && Number(saved.mcs_equipmenttype) !== s.type) bad.push(`Equipment Type 是“${fmt(saved, 'mcs_equipmenttype') || '空'}”`);
      if (s.warrantyValue !== null && Number(saved.mcs_warrantypolicyvalue) !== s.warrantyValue) bad.push(`Warranty Policy Value 是 ${saved.mcs_warrantypolicyvalue ?? '空'}`);
      if (s.warrantyMonth !== null && Number(saved.mcs_warrantypolicymonth) !== s.warrantyMonth) bad.push(`Warranty Policy Month 是 ${saved.mcs_warrantypolicymonth ?? '空'}`);
      if (bad.length) throw new Error(`写入后 ${bad.join('、')}，和要改的不一样，请到设备变更单 ${item.orderNumber} 上检查`);
      ctx.log(`已写入 ${ch.join('；')}`);
    },
    // 提交审批：网页上就是先检查必填项，再把 Change Status 改成 20（来源是“内销转海外”时直接 30 审批通过）
    async submit(item, ctx) {
      if (item.sim.newOrder) return ctx.log('（不执行）提交审批（Change Status → Submitted）');
      const r = (await api(`${EC_SET}(${item.ecId})?$select=mcs_changestatus,mcs_source,_mcs_productgroupid_value,_mcs_buid_value,mcs_manufacturingdate,mcs_modelmachinetype,mcs_warrantystatus,_mcs_countryid_value,_mcs_personnel_30_value,mcs_equipmentusagestatus,mcs_status`, { formatted: true })).data;
      if (![10, 40].includes(Number(r.mcs_changestatus))) return ctx.log(`设备变更单已是 ${fmt(r, 'mcs_changestatus')}，不重复提交`);
      const req = [['_mcs_productgroupid_value', 'Product Group'], ['_mcs_buid_value', 'BU'], ['mcs_manufacturingdate', 'Manufacturing Date'],
        ['mcs_modelmachinetype', 'Model (Machine Type)'], ['mcs_warrantystatus', 'Warranty Status'], ['_mcs_countryid_value', 'Country'],
        ['_mcs_personnel_30_value', 'Responsible Service Engineer'], ['mcs_equipmentusagestatus', 'Equipment Usage Status'], ['mcs_status', 'Status']];
      const missing = req.filter(([fld]) => !has(r[fld])).map(([, l]) => l);
      if (missing.length) throw new Pause(`设备变更单 ${item.orderNumber} 这些必填项是空的：${missing.join('、')}。补好后点“继续”`);
      const target = Number(r.mcs_source) === 20 ? 30 : 20;
      await ctx.write(`提交审批（Change Status → ${target === 30 ? 'Approved' : 'Submitted'}）`,
        () => api(`${EC_SET}(${item.ecId})`, { method: 'PATCH', headers: { 'If-Match': '*' }, body: { mcs_changestatus: target } }));
      if (ctx.dry) return;
      const after = (await api(`${EC_SET}(${item.ecId})?$select=mcs_changestatus`, { formatted: true })).data;
      if ([10, 40].includes(Number(after.mcs_changestatus))) throw new Error('提交后状态没有变，请到设备变更单上检查');
      ctx.log(`设备变更单 ${item.orderNumber} 已提交（${fmt(after, 'mcs_changestatus')}）`);
    },
  };
  const EC_STEPS = [['resolve', 'ec-creating'], ['fill', 'ec-filling'], ['submit', 'ec-submitting']];

  const KINDS = {
    'handover-pdi': { steps: HANDOVER_STEPS, impl: handover },
    handover: { steps: HANDOVER_STEPS, impl: handover }, // 交机（照片用文件夹里的）
    'shipment-transfer': { steps: SHIPMENT_STEPS, impl: shipment },
    pdi: { steps: PDI_STEPS, impl: pdi },
    'pdi-dealer': { steps: PDI_STEPS, impl: pdi },
    rust: { steps: RUST_STEPS, impl: rust },
    'pdi-transfer': { steps: PDI_TRANSFER_STEPS, impl: pdiTransfer },
    'dealer-pdi-assign': { steps: ASSIGN_STEPS, impl: dealerPdiAssign },
    'rust-dispatch': { steps: ASSIGN_STEPS, impl: rustDispatch },
    'equipment-change': { steps: EC_STEPS, impl: equipmentChange },
  };

  // 做下一步。item.step 记着做到第几步。
  // 全流程（到港 PDI → 防锈 → 经销商 PDI）：工作台把每台机拆成三项，每项自己带 item.kind
  async function step(kind, item, opts) {
    item = JSON.parse(JSON.stringify(item || {}));
    const k = item.kind || kind;
    const def = KINDS[k];
    if (!def) throw new Error(`没有这个功能：${k}`);
    item.kind = k;
    const ctx = makeCtx(item, opts);
    item.step = Number(item.step || 0);
    const nextName = () => (item.step < def.steps.length ? def.steps[item.step][0] : '');
    if (item.step >= def.steps.length) return { item, logs: ctx.logs, done: true };
    const [name, stage] = def.steps[item.step];
    item.stage = stage;
    try {
      await def.impl[name](item, ctx);
      item.step += 1;
      item.error = '';
      const done = item.step >= def.steps.length;
      if (done) item.stage = 'done';
      item.next = nextName();
      return { item, logs: ctx.logs, done };
    } catch (e) {
      if (e instanceof Skip) {
        item.stage = 'skipped';
        item.skipReason = e.message;
        ctx.log(`跳过：${e.message}`);
        return { item, logs: ctx.logs, done: true };
      }
      item.next = name;
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
    _internal: { listFiles, findEquipment, ordersOfType, generateTicketPdf, currentUser, action, api, watermarkAndCompress, folderPhotoRules },
  };
})();
