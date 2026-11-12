// ==UserScript==
// @name         D365 PDI/防锈批量建单与附件上传
// @namespace    local.sany.d365.batch
// @version      0.10.4
// @description  按机号打开已有 PDI/防锈订单，自动上传附件、现场完工并提交审核；服务转移模式可创建 PDI；防锈派单模式可把卡在 Created 的防锈单派给指定人员；交机模式可新建或继续完成交机单；设备变更模式可粘贴机号批量新建并提交设备变更单。
// @author       Local
// @updateURL    https://gist.githubusercontent.com/chickentende985-stack/34a655254f34696ae299d67386621d95/raw/d365-pdi-rust-batch.user.js
// @downloadURL  https://gist.githubusercontent.com/chickentende985-stack/34a655254f34696ae299d67386621d95/raw/d365-pdi-rust-batch.user.js
// @match        https://*.dynamics.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  // D365 订单页包含多个动态 iframe。脚本只允许在顶层页面运行一次，
  // 否则每个 iframe 都会创建面板、监听器和恢复循环，导致页面卡死。
  if (window.top !== window.self) return;

  const APP_ID = 'd365-pdi-rust-batch';
  // 面板显示的版本号：优先读取脚本管理器提供的 GM_info，取不到时使用此常量。
  // 升级 @version 时同步修改此常量，publish.sh 会检查两者一致。
  const SCRIPT_VERSION_FALLBACK = '0.10.4';
  const SCRIPT_VERSION = (() => {
    try {
      return typeof GM_info !== 'undefined' && GM_info?.script?.version
        ? String(GM_info.script.version)
        : SCRIPT_VERSION_FALLBACK;
    } catch {
      return SCRIPT_VERSION_FALLBACK;
    }
  })();
  const UPDATE_URL_FALLBACK = 'https://gist.githubusercontent.com/chickentende985-stack/34a655254f34696ae299d67386621d95/raw/d365-pdi-rust-batch.user.js';
  const UPDATE_URL = (() => {
    try {
      return (typeof GM_info !== 'undefined' && (GM_info?.script?.updateURL || GM_info?.script?.downloadURL))
        || UPDATE_URL_FALLBACK;
    } catch {
      return UPDATE_URL_FALLBACK;
    }
  })();
  const UPDATE_CHECK_KEY = `d365-pdi-rust-batch:last-update-check:v1`;
  const STATE_KEY = `${APP_ID}:state:v1`;
  const PANEL_POSITION_KEY = `${APP_ID}:panel-position:v1`;
  const FIELD_MAP_KEY = `${APP_ID}:order-fields:v1`;
  const CURRENT_APP_KEY = `${APP_ID}:current-app-id`;
  const DB_NAME = `${APP_ID}:handles`;
  // 记住最近一次选择的文件夹，换功能（服务转移→PDI→防锈）时不用重新选择。
  const LAST_FOLDER_KEY = `${APP_ID}:last-folder:v1`;
  function loadLastFolder() {
    try { return JSON.parse(localStorage.getItem(LAST_FOLDER_KEY) || 'null'); } catch { return null; }
  }
  function saveLastFolder(handleKey, name) {
    try { localStorage.setItem(LAST_FOLDER_KEY, JSON.stringify({ handleKey, name })); } catch { /* 忽略 */ }
  }
  // 直接选了单台机号文件夹时 dirName 记为 '.'，表示照片就在所选文件夹里。
  const SINGLE_DIR = '.';
  function itemDir(root, item) {
    return item.dirName === SINGLE_DIR ? root : root.getDirectoryHandle(item.dirName || item.machineNo);
  }
  const ORDER_ENTITY = 'mcs_consultationorder';
  const EQUIPMENT_ENTITY = 'mcs_equipment';
  // 备用应用编号（地址栏没有 appid、也没记住时才用）：SANY 的 Dynamics 365 After-Sales Service。
  // 以前写的 56ae5a6d… 在这个 D365 里不存在，打开订单会报“Record Is Unavailable / App Module is invalid”。
  const APP_ID_VALUE = '686a745d-1b06-ef11-9f8b-6045bd8c985b';
  const FORM_ID = '4f3260a5-1006-4d93-8d2b-d79dbcb8ee0b';
  const PAGE_STALL_MS = 60 * 1000;

  const RUN_MODE = {
    FULL: 'full',
    TRANSFER: 'transfer',
    RUST_DISPATCH: 'rust-dispatch',
    EQUIPMENT_CHANGE: 'equipment-change',
  };

  // 防锈派单：订单停在 Created 且当前账号看不到接受/出发/到达等按键时，
  // 调用与系统 Assign 按钮相同的接口派给指定人员。
  const ASSIGN_API = 'mcs_ConsultationOrderAssignApi';
  const ORDER_STATUS_CREATED = 10;
  const SERVICE_MODE_DEALER = 20;
  const DISPATCH_PROGRESS_LABELS = [
    '接受', 'Accept',
    'Navigation Set Off', '出发', 'Set Off', 'Depart',
    'Navigation Arrived', '到达', 'Arrived', 'Arrive',
    '现场完工', 'Completion On Site',
    '提交审核', 'Submit for Approval',
  ];

  const TYPE_CONFIG = {
    pdi: {
      label: 'PDI（到货预验收）',
      orderTypeLabel: '到货预验收',
      viewId: '9b8c42de-d734-ee11-bdf4-000d3aa06208',
      needsPreInspectionType: true,
    },
    rust: {
      label: '防锈运转',
      orderTypeLabel: '防锈运转',
      viewId: 'a64c7333-ae35-ee11-bdf4-000d3a08d952',
      needsPreInspectionType: false,
    },
    equipmentChange: {
      label: '设备变更',
      orderTypeLabel: '',
      viewId: null,
      needsPreInspectionType: false,
    },
    handover: {
      label: '交机',
      orderTypeLabel: '交机单',
      viewId: null,
      needsPreInspectionType: false,
      formId: '69100c1a-9bbf-f011-bbd3-002248599c07',
    },
  };

  const FILE_RULES = [
    { name: '1.jpg', aliases: ['1.jpg', '1.jpeg', '1.png'], typeCode: 1, typeLabels: ['铭牌号', 'Nameplate number'] },
    { name: '2.jpg', aliases: ['2.jpg', '2.jpeg', '2.png'], typeCode: 2, typeLabels: ['整机远照', 'Whole machine far shot'] },
    { name: '3.jpg', aliases: ['3.jpg', '3.jpeg', '3.png'], typeCode: 3, typeLabels: ['工时小时照', 'Working hours photo'] },
    { name: '4.jpg', aliases: ['4.jpg', '4.jpeg', '4.png'], typeCode: 11, typeLabels: ['其他照片', 'Other photos'] },
  ];

  // 防锈运转新规则：文件夹里有 5 号照片时按 5 张处理——
  // 1 铭牌、2 整机远照、3 和 4 都是工时照（第二张改名 Working hours photo 2，避免和第一张同名混淆）、5 其他照片。
  // 只有 1～4 号时仍按原来的 4 张规则（4 号为其他照片）。
  const RUST_FIVE_PHOTO_RULES = [
    FILE_RULES[0],
    FILE_RULES[1],
    FILE_RULES[2],
    { name: '4.jpg', aliases: ['4.jpg', '4.jpeg', '4.png'], typeCode: 3, typeLabels: ['工时小时照', 'Working hours photo'], fileLabel: 'Working hours photo 2' },
    { name: '5.jpg', aliases: ['5.jpg', '5.jpeg', '5.png'], typeCode: 11, typeLabels: ['其他照片', 'Other photos'] },
  ];
  // 扫描文件夹时 1～5 号照片都要认出来（用来判断是 4 张还是 5 张）。
  const ALL_PHOTO_NAMES = [...FILE_RULES, RUST_FIVE_PHOTO_RULES[4]];

  const SERVICE_TICKET_RULE = {
    name: 'service-ticket.pdf',
    aliases: [],
    typeCode: 98,
    typeLabels: ['服务工单', 'Service Ticket'],
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalizeGuid = (value) => String(value || '').replace(/[{}]/g, '').toLowerCase();
  const escapeODataString = (value) => String(value).replace(/'/g, "''");

  function compareVersions(a, b) {
    const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
    const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff) return diff > 0 ? 1 : -1;
    }
    return 0;
  }

  // 读取 Gist 上最新脚本的 @version。加时间戳绕过 CDN 缓存；用 XHR 避免被改写过的 fetch。
  function fetchLatestVersion() {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const sep = UPDATE_URL.includes('?') ? '&' : '?';
      xhr.open('GET', `${UPDATE_URL}${sep}t=${Date.now()}`, true);
      xhr.timeout = 20000;
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(`更新服务器返回 ${xhr.status}`));
        const version = (xhr.responseText.match(/^\s*\/\/\s*@version\s+(\S+)/m) || [])[1];
        return version ? resolve(version) : reject(new Error('没有在最新脚本中找到版本号'));
      };
      xhr.onerror = () => reject(new Error('无法连接更新服务器'));
      xhr.ontimeout = () => reject(new Error('连接更新服务器超时'));
      xhr.send();
    });
  }

  function nowText() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  function isTestEnvironment() {
    return /(^|[-.])uat([-.]|$)/i.test(location.hostname)
      || /sandbox/i.test(document.body?.innerText || '');
  }

  function getState() {
    try {
      return JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
    } catch {
      return null;
    }
  }

  // 用户点击“暂停”后置为 true：waitFor 每轮都会检查并立即中止当前步骤；
  // 正在执行的流程手里的 run 对象仍是 running，saveState 不会再把状态写回 running。
  let pauseRequested = false;

  class RunPausedError extends Error {
    constructor() {
      super('用户已暂停');
      this.name = 'RunPausedError';
    }
  }

  function throwIfPaused() {
    if (pauseRequested) throw new RunPausedError();
  }

  function saveState(state) {
    if (pauseRequested && state.status === 'running') state.status = 'paused';
    state.updatedAt = new Date().toISOString();
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    return state;
  }

  function clearState() {
    localStorage.removeItem(STATE_KEY);
  }

  // 地址栏里还没有 appid 时（比如刚打开 main.aspx），问 D365 当前是哪个应用，记下来
  function rememberAppIdFromXrm(tries = 15) {
    try {
      const props = window.Xrm?.Utility?.getGlobalContext?.()?.getCurrentAppProperties?.();
      if (props && typeof props.then === 'function') {
        props.then((p) => {
          const id = normalizeGuid(p?.appId);
          if (/^[0-9a-f-]{36}$/.test(id)) localStorage.setItem(CURRENT_APP_KEY, id);
        }).catch(() => {});
        return;
      }
    } catch { /* Xrm 还没准备好 */ }
    if (tries > 0) setTimeout(() => rememberAppIdFromXrm(tries - 1), 2000);
  }

  function rememberCurrentAppId() {
    if (/\/error\/errorhandler\.aspx/i.test(location.pathname)) return;
    const value = normalizeGuid(new URLSearchParams(location.search).get('appid'));
    if (!/^[0-9a-f-]{36}$/.test(value)) rememberAppIdFromXrm();
    if (/^[0-9a-f-]{36}$/.test(value)) localStorage.setItem(CURRENT_APP_KEY, value);
  }

  function currentAppId() {
    const fromUrl = normalizeGuid(new URLSearchParams(location.search).get('appid'));
    if (!/\/error\/errorhandler\.aspx/i.test(location.pathname)
      && /^[0-9a-f-]{36}$/.test(fromUrl)) return fromUrl;
    return normalizeGuid(localStorage.getItem(CURRENT_APP_KEY)) || APP_ID_VALUE;
  }

  function discardReusableOrdersForForceNew(run) {
    if (!run?.forceCreateNew || !isTransferMode(run)) return false;
    let changed = false;
    for (const item of run.items || []) {
      if (!item.existing || item.stage === 'done' || item.reusedAfterCreateConflict) continue;
      item.orderId = null;
      item.existing = false;
      item.stage = item.missing?.length ? 'invalid' : 'pending';
      item.uploaded = [];
      item.error = '';
      changed = true;
    }
    return changed;
  }

  function isTransferMode(run) {
    return run?.runMode === RUN_MODE.TRANSFER;
  }

  function isRustDispatchMode(run) {
    return run?.runMode === RUN_MODE.RUST_DISPATCH;
  }

  function isTransferItem(run, item) {
    return isTransferMode(run) && !item?.resumeAsPdiWorkflow;
  }

  function photoRulesForRun(run, item = null) {
    if (isTransferItem(run, item) || isRustDispatchMode(run) || isEquipmentChangeMode(run)) return [];
    // 防锈：文件夹里有 5 号照片就按 5 张规则；PDI、交机以及只有 4 张的防锈仍上传 1～4 号四张照片。
    if (run?.orderKind === 'rust' && (item?.files || []).includes('5.jpg')) return RUST_FIVE_PHOTO_RULES;
    // 5 张照片的文件夹用在 PDI/交机时：4 号是第二张工时照，“其他照片”改用 5 号。
    if (!run?.handoverFromPdi && (item?.files || []).includes('5.jpg')) {
      return [FILE_RULES[0], FILE_RULES[1], FILE_RULES[2], { ...RUST_FIVE_PHOTO_RULES[4] }];
    }
    return FILE_RULES;
  }

  // 文件夹名中的工作时间按小时填写，允许“120”“120h”“120.5H”等写法。
  // D365 把 0 当成“没填”（提交时报 Machine running hours… cannot be empty），所以 0 一律按 0.1 填：
  // 填进去后如果系统里记录的累计工时更高，D365 会提示那个数值，脚本再在它基础上 +0.1 重填。
  const MIN_OPERATING_HOURS = 0.1;
  function workingHoursValue(item) {
    const match = String(item?.workingHours || '').replace(/,/g, '.').match(/^\d+(?:\.\d+)?/);
    if (!match) return NaN;
    const value = Number(match[0]);
    return value > 0 ? value : MIN_OPERATING_HOURS;
  }

  // PDI 与防锈都需要把文件夹名中的机型、吨位写入 General 表单，
  // 并把工作时间写入 On-Site Processing 的 Current Operating Hours。
  function folderInfoMissing(run, item) {
    if (isTransferItem(run, item) || isRustDispatchMode(run) || !['pdi', 'rust', 'handover'].includes(run?.orderKind)) return [];
    if (run.orderKind === 'handover') {
      return Number.isFinite(workingHoursValue(item)) ? [] : ['文件夹名中的工作时间'];
    }
    const missing = item?.equipmentModel && item?.tonnage ? [] : ['文件夹名中的机型/吨位'];
    if (!Number.isFinite(workingHoursValue(item))) missing.push('文件夹名中的工作时间');
    return missing;
  }

  function reconcileItemValidation(run) {
    for (const item of run?.items || []) {
      if (item.orderId || !['pending', 'invalid'].includes(item.stage)) continue;
      item.missing = isTransferItem(run, item) || isRustDispatchMode(run) || isEquipmentChangeMode(run)
        || run.handoverFromPdi
        ? []
        : [
          ...photoRulesForRun(run, item)
            .filter((rule) => !(item.files || []).includes(rule.name))
            .map((rule) => rule.aliases.join('/')),
          ...folderInfoMissing(run, item),
        ];
      item.stage = item.missing.length ? 'invalid' : 'pending';
    }
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('handles');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function storeHandle(key, handle) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(handle, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async function loadHandle(key) {
    const db = await openDb();
    const result = await new Promise((resolve, reject) => {
      const request = db.transaction('handles').objectStore('handles').get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return result;
  }

  function clientUrl() {
    try {
      return window.Xrm?.Utility?.getGlobalContext?.().getClientUrl() || location.origin;
    } catch {
      return location.origin;
    }
  }

  async function api(path, options = {}) {
    const method = options.method || 'GET';
    const url = `${clientUrl()}/api/data/v9.2/${path}`;
    const headers = {
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      ...(options.body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      ...(options.headers || {}),
    };

    // D365 或页面中的其他扩展有时会包装 window.fetch，并在部分元数据
    // 请求上返回 undefined。XMLHttpRequest 使用同一登录会话，兼容性更稳定。
    const result = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.withCredentials = true;
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      xhr.onload = () => resolve({
        status: xhr.status,
        body: xhr.responseText || '',
        getHeader: (name) => xhr.getResponseHeader(name),
      });
      xhr.onerror = () => reject(new Error(`D365 网络请求失败：${method} ${path}`));
      xhr.ontimeout = () => reject(new Error(`D365 网络请求超时：${method} ${path}`));
      xhr.timeout = 60000;
      xhr.send(options.body || null);
    });

    if (result.status < 200 || result.status >= 300) {
      throw new Error(`D365 API ${result.status} [${method} ${path}]: ${result.body.slice(0, 600)}`);
    }
    const response = {
      status: result.status,
      headers: { get: result.getHeader },
    };
    if (result.status === 204 || !result.body.trim()) return { response, data: null };
    try {
      return { response, data: JSON.parse(result.body) };
    } catch {
      throw new Error(`D365 返回了非 JSON 数据 [${method} ${path}]: ${result.body.slice(0, 300)}`);
    }
  }

  function d365ErrorMessage(error) {
    const raw = String(error?.message || error || '');
    const jsonStart = raw.indexOf('{');
    if (jsonStart >= 0) {
      try {
        const payload = JSON.parse(raw.slice(jsonStart));
        return String(payload?.error?.message || raw);
      } catch { /* 回退到原始错误文字 */ }
    }
    return raw;
  }

  function isHandedOverPdiCreateError(error) {
    const message = d365ErrorMessage(error);
    return /已交机.*不能创建到货预验收/i.test(message)
      || /(?:already|has been).*handed over.*cannot.*(?:arrival|PDI|pre.?inspection)/i.test(message);
  }

  // 经销商 PDI：订单类型同样是“到货预验收”，只是预验收类型选“代理商入库预验收”。
  // 面板上用单独的选项 pdi-dealer，运行时仍按 orderKind = 'pdi' 走完全相同的流程。
  const DEALER_PDI_PRE_TYPE = '代理商入库预验收';
  // Shipment PDI：预验收类型“出库预验收”（英文 Shipment PDI），和到港 PDI 一样是直销模式，用服务转移。
  const SHIPMENT_PDI_PRE_TYPE = '出库预验收';
  // 面板上的“订单类型”值 → 任务里的 orderKind 和附加标记。
  // pdi-dealer：经销商 PDI；handover-pdi：交机但不用文件夹照片，照片和工时从这台机的 PDI 里拿。
  function uiKindToRun(value) {
    if (value === 'chain') return { orderKind: 'pdi', pdiDealer: false, pdiShipment: false, handoverFromPdi: false, chainMode: true };
    if (value === 'pdi-dealer') return { orderKind: 'pdi', pdiDealer: true, pdiShipment: false, handoverFromPdi: false, chainMode: false };
    if (value === 'pdi-shipment') return { orderKind: 'pdi', pdiDealer: false, pdiShipment: true, handoverFromPdi: false, chainMode: false };
    if (value === 'handover-pdi') return { orderKind: 'handover', pdiDealer: false, pdiShipment: false, handoverFromPdi: true, chainMode: false };
    return { orderKind: value, pdiDealer: false, pdiShipment: false, handoverFromPdi: false, chainMode: false };
  }
  function runUiKind(run) {
    if (run?.chainMode) return 'chain';
    if (run?.orderKind === 'pdi' && run?.pdiDealer) return 'pdi-dealer';
    if (run?.orderKind === 'pdi' && run?.pdiShipment) return 'pdi-shipment';
    if (run?.orderKind === 'handover' && run?.handoverFromPdi) return 'handover-pdi';
    return run?.orderKind || 'pdi';
  }
  const isPdiUiKind = (value) => value === 'pdi' || value === 'pdi-dealer' || value === 'pdi-shipment';
  // 新建 PDI 时写入的预验收类型。
  const runPreType = (run, fallback) => (run?.pdiDealer ? DEALER_PDI_PRE_TYPE : run?.pdiShipment ? SHIPMENT_PDI_PRE_TYPE : fallback);
  function kindLabel(run) {
    if (run?.chainMode) return '全流程（到港 PDI → 防锈 → 经销商 PDI）';
    if (run?.orderKind === 'pdi' && run?.pdiDealer) return '经销商 PDI（代理商入库预验收）';
    if (run?.orderKind === 'pdi' && run?.pdiShipment) return 'Shipment PDI（出库预验收）';
    if (run?.orderKind === 'handover' && run?.handoverFromPdi) return '交机（无照片，从 PDI 拿资料）';
    return TYPE_CONFIG[run?.orderKind]?.label || '';
  }

  // ===== 交机（无照片）：照片和工时从这台机的 PDI 里拿 =====
  // PDI 附件的类型代码：001 铭牌号、002 整机远照、003 工时照、011 其他照片（与 FILE_RULES 的 typeCode 对应）。
  const pdiFileCache = new Map();
  async function pdiPhotoFile(item, rule) {
    if (!item.pdiOrderId) throw new Error('还没有找到这台机的 PDI 订单');
    let files = pdiFileCache.get(item.pdiOrderId);
    if (!files) {
      files = await listOrderFiles(item.pdiOrderId);
      pdiFileCache.set(item.pdiOrderId, files);
    }
    const typeOf = (file) => String(file.Type || '').padStart(3, '0');
    const newestOf = (code) => files
      .filter((file) => typeOf(file) === code && file.FileUrl)
      .sort((a, b) => String(b.CreateTime || '').localeCompare(String(a.CreateTime || '')))[0] || null;
    const code = String(rule.typeCode).padStart(3, '0');
    let source = newestOf(code);
    if (!source && code === '011') source = pickOtherPhotoFallback(item, files, typeOf, newestOf);
    if (!source) {
      throw new Error(`PDI 订单 ${item.pdiOrderNumber || item.pdiOrderId} 里没有“${rule.typeLabels[0]}”照片，无法自动交机`);
    }
    const response = await fetch(source.FileUrl);
    if (!response.ok) {
      pdiFileCache.delete(item.pdiOrderId); // 下载链接可能过期，下次重新查询
      throw new Error(`下载 PDI 的“${rule.typeLabels[0]}”照片失败：HTTP ${response.status}`);
    }
    const blob = await response.blob();
    if (!blob.size) throw new Error(`PDI 的“${rule.typeLabels[0]}”照片是空文件`);
    const ext = (String(source.Name || '').match(/\.([^.]+)$/)?.[1] || 'jpg').toLowerCase();
    const type = blob.type && blob.type !== 'application/octet-stream'
      ? blob.type
      : ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' })[ext] || 'image/jpeg';
    // 文件名用 1/2/3/4 编号，和文件夹照片一样，上传后再改成英文类型名。
    return new File([blob], `${rule.name.replace(/\.[^.]+$/, '')}.${ext}`, { type });
  }

  // 面板日志的全局入口（面板创建后赋值），给不方便传 panel 的底层函数写日志用。
  let panelLog = null;

  // PDI 里没有“其他照片”（011）时：从 PDI 的其他图片里随机挑一张，且不能和已用作
  // 铭牌（001）、远照（002）、工时照（003）的那几张重复。优先挑多出来的整机/铭牌/工时照，
  // 其次其他类型的图片，再次才是出发/到达里程照（007/008）；Service Ticket（118）不用。
  // 选中的照片记在任务里，暂停后继续也用同一张。
  function pickOtherPhotoFallback(item, files, typeOf, newestOf) {
    const isImage = (file) => /\.(jpe?g|png)$/i.test(String(file.Name || '')) && file.FileUrl;
    if (item.otherPhotoSourceId) {
      const kept = files.find((file) => file.ID === item.otherPhotoSourceId && isImage(file));
      if (kept) return kept;
    }
    const used = new Set(['001', '002', '003'].map(newestOf).filter(Boolean).map((file) => file.ID));
    const pool = files.filter((file) => isImage(file) && !used.has(file.ID) && typeOf(file) !== '118');
    const groups = [
      pool.filter((file) => ['001', '002', '003'].includes(typeOf(file))),
      pool.filter((file) => !['001', '002', '003', '007', '008'].includes(typeOf(file))),
      pool.filter((file) => ['007', '008'].includes(typeOf(file))),
    ];
    const group = groups.find((list) => list.length);
    if (!group) return null;
    const chosen = group[Math.floor(Math.random() * group.length)];
    item.otherPhotoSourceId = chosen.ID;
    item.otherPhotoSourceName = chosen.Name;
    return chosen;
  }

  // 工作小时：粘贴时机号后写了就用写的，否则读 PDI 的 Current Operating Hours（mcs_systemrunningtime）。
  async function ensureHandoverHoursFromPdi(run, item, panel) {
    if (!run.handoverFromPdi || Number.isFinite(workingHoursValue(item))) return;
    if (!item.pdiOrderId) throw new Error('还没有找到这台机的 PDI 订单，无法读取工作小时');
    const { data } = await api(`mcs_consultationorders(${normalizeGuid(item.pdiOrderId)})?$select=mcs_systemrunningtime`);
    const hours = Number(data?.mcs_systemrunningtime);
    if (!(hours > 0)) {
      // PDI 里没写或是 0：先填 0.1，提交时系统若提示累计工时，脚本会在提示值基础上 +0.1 重填。
      item.workingHours = String(MIN_OPERATING_HOURS);
      saveState(run);
      panel?.log(`${item.machineNo}：PDI ${item.pdiOrderNumber || ''} 的工时为空或 0，先填 ${MIN_OPERATING_HOURS}，系统提示累计工时后自动 +0.1`);
      return;
    }
    item.workingHours = String(hours);
    saveState(run);
    panel?.log(`${item.machineNo}：工作小时取 PDI ${item.pdiOrderNumber || ''} 的 ${hours} 小时`);
  }
  // 经销商 PDI 查已有订单时只认“代理商入库预验收”类型，避免误用这台机的到港 PDI。
  function pdiTypeFilter(run, model) {
    if (run?.orderKind !== 'pdi' || !model.preTypeField) return '';
    const value = metadata.optionValue(model.preTypeField, DEALER_PDI_PRE_TYPE);
    const field = model.preTypeField.LogicalName;
    if (run?.pdiDealer) return ` and ${field} eq ${value}`;
    const shipment = metadata.optionValue(model.preTypeField, SHIPMENT_PDI_PRE_TYPE);
    if (run?.pdiShipment) return ` and ${field} eq ${shipment}`;
    // 全流程里的到港 PDI 这一步：不能误用这台机的经销商 PDI。
    if (run?.chainMode) return ` and (${field} ne ${value} or ${field} eq null)`;
    // 服务转移建到港 PDI：不能误用这台机的经销商 PDI 或 Shipment PDI。
    if (isTransferMode(run)) return ` and ((${field} ne ${value} and ${field} ne ${shipment}) or ${field} eq null)`;
    return '';
  }

  // ===== 全流程：到港 PDI → 防锈 → 经销商 PDI（经销商设备才做）=====
  // 每台机展开成按顺序执行的几步，每一步就是一个普通任务项，处理到它时把任务的订单类型切成这一步的类型，
  // 后面复用原来 PDI / 防锈 / 经销商 PDI 的全部逻辑。照片四步共用同一个机号文件夹。
  const CHAIN_STEPS = [
    { kind: 'pdi', label: '到港 PDI' },
    { kind: 'rust', label: '防锈' },
    { kind: 'pdi-dealer', label: '经销商 PDI' },
  ];
  function expandChainItems(rows) {
    return rows.flatMap((row) => CHAIN_STEPS.map((step, index) => ({
      ...JSON.parse(JSON.stringify(row)),
      chainKind: step.kind,
      chainLabel: step.label,
      chainIndex: index,
    })));
  }
  function applyChainStep(run, item) {
    if (!run.chainMode || !item.chainKind) return false;
    const kind = uiKindToRun(item.chainKind);
    if (run.orderKind === kind.orderKind && Boolean(run.pdiDealer) === kind.pdiDealer) return false;
    run.orderKind = kind.orderKind;
    run.pdiDealer = kind.pdiDealer;
    run.pdiShipment = false;
    run.handoverFromPdi = false;
    return true;
  }

  // 经销商设备：设备上挂了经销商（Dealer）。直销设备没有，就不做经销商 PDI。
  async function equipmentDealer(equipmentId) {
    const { data } = await api(
      `mcs_equipments(${normalizeGuid(equipmentId)})?$select=_mcs_dealerid_value,mcs_status`,
      { headers: { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' } },
    );
    return data._mcs_dealerid_value ? (formattedValue(data, '_mcs_dealerid_value') || '经销商') : '';
  }

  // 经销商 PDI 是 Dealer 模式订单，当前账号要被派单（Assign）后才有接受等按键：派给当前账号自己。
  async function assignDealerPdiToSelf(orderId, panel, machineNo) {
    const order = await readDispatchOrder(orderId);
    const me = await currentUserId();
    const { data } = await api(
      `mcs_personnels?$select=mcs_personnelid,mcs_name&$filter=${encodeURIComponent(`_mcs_systemuserid_value eq ${me} and statecode eq 0`)}&$top=2`,
    );
    const person = data.value?.[0];
    if (!person) throw new Error('找不到当前账号对应的人员（Personnel），无法给经销商 PDI 派单');
    const personId = normalizeGuid(person.mcs_personnelid);
    if (normalizeGuid(order._mcs_engineer_value) === personId) return;
    if (Number(order.mcs_status) !== ORDER_STATUS_CREATED) return; // 已被接受/处理中，交给后面的流程判断
    panel?.log(`${machineNo}：经销商 PDI ${order.mcs_name} 派单给当前账号（${String(person.mcs_name || '').trim()}）…`);
    try {
      await callAssignApi(personId, orderId);
    } catch (error) {
      throw new Error(`经销商 PDI ${order.mcs_name} 不能派给当前账号（${error.message}）。请在你自己的账号用“转移/派单 → 经销商 PDI 创建 → Assign 派单”派给这个账号，再点“重新授权并继续”`);
    }
  }

  function isDuplicatePreArrivalPdiCreateError(error) {
    const message = d365ErrorMessage(error);
    return /has created pre-arrival acceptance order.*cannot create again/i.test(message)
      || /已创建.*到货预验收.*不能再次创建|已有.*到货预验收.*不能重复创建/i.test(message);
  }

  function isDuplicateRustOrderCreateError(error) {
    const message = d365ErrorMessage(error);
    return /equipment\s*\[[^\]]+\]\s*already has an order\s*\[[^\]]+\]\s*of this type and cannot be created again/i.test(message)
      || /设备.*已有.*同类型.*订单.*不能.*再次创建/i.test(message);
  }

  function conflictingOrderNumber(error) {
    const message = d365ErrorMessage(error);
    return message.match(/already has an order\s*\[([^\]]+)\]/i)?.[1]
      || message.match(/已有.*订单\s*[【\[]([^】\]]+)[】\]]/i)?.[1]
      || '';
  }

  function localizedLabel(item) {
    return item?.DisplayName?.LocalizedLabels?.find((x) => x.LanguageCode === 2052)?.Label
      || item?.DisplayName?.UserLocalizedLabel?.Label
      || item?.DisplayName?.LocalizedLabels?.[0]?.Label
      || '';
  }

  function optionLabel(option) {
    return option?.Label?.LocalizedLabels?.find((x) => x.LanguageCode === 2052)?.Label
      || option?.Label?.UserLocalizedLabel?.Label
      || option?.Label?.LocalizedLabels?.[0]?.Label
      || '';
  }

  function displayLabels(item) {
    return [...new Set([
      item?.DisplayName?.UserLocalizedLabel?.Label,
      ...(item?.DisplayName?.LocalizedLabels || []).map((x) => x.Label),
    ].filter(Boolean))];
  }

  function optionLabels(option) {
    return [...new Set([
      option?.Label?.UserLocalizedLabel?.Label,
      ...(option?.Label?.LocalizedLabels || []).map((x) => x.Label),
    ].filter(Boolean))];
  }

  function labelsMatch(actualLabels, wantedLabels) {
    const actual = actualLabels.map((x) => x.trim().toLocaleLowerCase());
    const wanted = wantedLabels.map((x) => x.trim().toLocaleLowerCase());
    return wanted.some((target) => actual.some((label) => label === target || label.includes(target)));
  }

  function labelsEqual(actualLabels, wantedLabels) {
    const actual = actualLabels.map((x) => x.trim().toLocaleLowerCase());
    const wanted = wantedLabels.map((x) => x.trim().toLocaleLowerCase());
    return wanted.some((target) => actual.includes(target));
  }

  class MetadataResolver {
    constructor() {
      this.cache = new Map();
    }

    async entity(logicalName) {
      const key = `entity:${logicalName}`;
      if (!this.cache.has(key)) {
        const { data } = await api(
          `EntityDefinitions(LogicalName='${logicalName}')?$select=LogicalName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute`,
        );
        this.cache.set(key, data);
      }
      return this.cache.get(key);
    }

    async attributes(logicalName) {
      const key = `attributes:${logicalName}`;
      if (!this.cache.has(key)) {
        const { data } = await api(
          `EntityDefinitions(LogicalName='${logicalName}')/Attributes?$select=LogicalName,AttributeType,DisplayName,IsValidForCreate,IsValidForUpdate,AttributeOf`,
        );
        this.cache.set(key, data.value || []);
      }
      return this.cache.get(key);
    }

    async attributeByLabel(logicalName, labels, required = true, allowedTypes = null) {
      const wanted = Array.isArray(labels) ? labels : [labels];
      let attrs = await this.attributes(logicalName);
      if (allowedTypes?.length) attrs = attrs.filter((x) => allowedTypes.includes(x.AttributeType));
      const attr = attrs.find((x) => labelsEqual(displayLabels(x), wanted))
        || attrs.find((x) => labelsMatch(displayLabels(x), wanted));
      if (!attr && required) throw new Error(`未能从 D365 元数据识别字段：${wanted.join('/')}`);
      return attr || null;
    }

    async picklists(logicalName) {
      const key = `picklists:${logicalName}`;
      if (!this.cache.has(key)) {
        const { data } = await api(
          `EntityDefinitions(LogicalName='${logicalName}')/Attributes/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName,DisplayName&$expand=OptionSet($select=Options)`,
        );
        this.cache.set(key, data.value || []);
      }
      return this.cache.get(key);
    }

    async picklistByLabel(logicalName, labels, required = true) {
      const wanted = Array.isArray(labels) ? labels : [labels];
      const fields = await this.picklists(logicalName);
      const field = fields.find((x) => labelsEqual(displayLabels(x), wanted))
        || fields.find((x) => labelsMatch(displayLabels(x), wanted));
      if (!field && required) throw new Error(`未能识别选项字段：${wanted.join('/')}`);
      return field || null;
    }

    optionValue(field, label) {
      const options = field?.OptionSet?.Options || [];
      const option = options.find((x) => labelsEqual(optionLabels(x), [label]))
        || options.find((x) => labelsMatch(optionLabels(x), [label]));
      if (!option) throw new Error(`字段“${localizedLabel(field)}”没有选项“${label}”`);
      return option.Value;
    }
  }

  const metadata = new MetadataResolver();

  async function resolveModel(config) {
    const [orderEntity, equipmentEntity] = await Promise.all([
      metadata.entity(ORDER_ENTITY),
      metadata.entity(EQUIPMENT_ENTITY),
    ]);
    const [equipmentLookup, orderTypeField] = await Promise.all([
      metadata.attributeByLabel(
        ORDER_ENTITY,
        ['设备', '机号', 'Equipment', 'Machine No.'],
        true,
        ['Lookup'],
      ),
      metadata.picklistByLabel(ORDER_ENTITY, ['订单类型', 'Order Type']),
    ]);
    const preTypeField = config.needsPreInspectionType
      ? await metadata.picklistByLabel(ORDER_ENTITY, ['预验收类型', 'PDI Type', 'Pre-Inspection Type', 'Pre-inspection Type'])
      : null;
    const orderStatusField = await metadata.picklistByLabel(
      ORDER_ENTITY,
      ['工单状态', 'Order Status', 'Work Order Status'],
      false,
    );
    if (equipmentLookup.AttributeType !== 'Lookup') {
      throw new Error(`设备字段解析异常：${equipmentLookup.LogicalName} 不是 Lookup`);
    }
    return {
      orderEntity,
      equipmentEntity,
      equipmentLookup,
      orderTypeField,
      preTypeField,
      orderStatusField,
    };
  }

  async function findEquipment(machineNo, model) {
    const field = model.equipmentEntity.PrimaryNameAttribute;
    const select = `${model.equipmentEntity.PrimaryIdAttribute},${field}`;
    const filter = `${field} eq '${escapeODataString(machineNo)}'`;
    const { data } = await api(`${model.equipmentEntity.EntitySetName}?$select=${select}&$filter=${encodeURIComponent(filter)}&$top=2`);
    if (!data.value?.length) throw new Error(`D365 中未找到设备：${machineNo}`);
    if (data.value.length > 1) throw new Error(`D365 中存在多个同名设备：${machineNo}`);
    return normalizeGuid(data.value[0][model.equipmentEntity.PrimaryIdAttribute]);
  }

  function cancelledOptionValues(field) {
    if (!field) return new Set();
    return new Set((field.OptionSet?.Options || [])
      .filter((option) => optionLabels(option).some((label) => /取消|cancel/i.test(label)))
      .map((option) => Number(option.Value)));
  }

  function recordIsCancelled(record, model) {
    const formattedSuffix = '@OData.Community.Display.V1.FormattedValue';
    const standardText = record[`statuscode${formattedSuffix}`] || '';
    if (/取消|cancel/i.test(standardText)) return true;
    if (!model.orderStatusField) return false;
    const fieldName = model.orderStatusField.LogicalName;
    const formatted = record[`${fieldName}${formattedSuffix}`] || '';
    return /取消|cancel/i.test(formatted)
      || cancelledOptionValues(model.orderStatusField).has(Number(record[fieldName]));
  }

  function currentMonthUtcRange() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  function orderStatusTexts(record, model) {
    const formattedSuffix = '@OData.Community.Display.V1.FormattedValue';
    const values = [record[`statuscode${formattedSuffix}`]];
    if (model.orderStatusField) {
      values.push(record[`${model.orderStatusField.LogicalName}${formattedSuffix}`]);
    }
    return values.map((value) => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  }

  // 本月防锈订单处于“现场完工(服务完工)”“提交审核(In Approval)”或“已完成”才算本月已做，可以跳过；
  // 其他状态（Created/Dispatched/Accepted/Departed/Arrived/Rejected…）都要进入订单继续完成。
  const RUST_SKIP_STATUS_PATTERN = /^(Completion On Site|CompletionOnSite|现场完工|服务完工|In Approval|审批中|审核中|提交审核|Completed|已完成)$/i;
  const RUST_SKIP_STATUS_VALUES = new Set([70, 80, 90]);

  function rustSkipStatus(record, model) {
    const text = orderStatusTexts(record, model).find((status) => RUST_SKIP_STATUS_PATTERN.test(status));
    if (text) return text;
    const field = model.orderStatusField?.LogicalName;
    if (field === 'mcs_status' && RUST_SKIP_STATUS_VALUES.has(Number(record[field]))) {
      return orderStatusTexts(record, model).slice(-1)[0] || String(record[field]);
    }
    return '';
  }

  function isRustMonthFinished(record, model) {
    return Boolean(rustSkipStatus(record, model));
  }

  async function findCurrentMonthFinishedRustOrder(equipmentId, orderTypeValue, model) {
    const primaryId = model.orderEntity.PrimaryIdAttribute;
    const lookupValue = `_${model.equipmentLookup.LogicalName}_value`;
    const range = currentMonthUtcRange();
    const filter = `${lookupValue} eq ${equipmentId} and ${model.orderTypeField.LogicalName} eq ${orderTypeValue} and createdon ge ${range.start} and createdon lt ${range.end}`;
    const selectFields = [primaryId, 'statuscode', 'createdon'];
    if (model.orderStatusField) selectFields.push(model.orderStatusField.LogicalName);
    const { data } = await api(
      `${model.orderEntity.EntitySetName}?$select=${selectFields.join(',')}&$filter=${encodeURIComponent(filter)}&$orderby=createdon desc&$top=50`,
      { headers: { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' } },
    );
    return data.value?.find((record) => isRustMonthFinished(record, model)) || null;
  }

  // 本月未取消、仍在进行中（不属于可跳过状态）的最新防锈订单。
  async function findCurrentMonthOpenRustOrder(equipmentId, orderTypeValue, model) {
    const primaryId = model.orderEntity.PrimaryIdAttribute;
    const lookupValue = `_${model.equipmentLookup.LogicalName}_value`;
    const range = currentMonthUtcRange();
    const filter = `${lookupValue} eq ${equipmentId} and ${model.orderTypeField.LogicalName} eq ${orderTypeValue} and statecode eq 0 and createdon ge ${range.start} and createdon lt ${range.end}`;
    const selectFields = [primaryId, model.orderEntity.PrimaryNameAttribute, 'statuscode', 'createdon'];
    if (model.orderStatusField) selectFields.push(model.orderStatusField.LogicalName);
    const { data } = await api(
      `${model.orderEntity.EntitySetName}?$select=${selectFields.join(',')}&$filter=${encodeURIComponent(filter)}&$orderby=createdon desc&$top=50`,
      { headers: { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' } },
    );
    return data.value?.find((record) => !recordIsCancelled(record, model) && !isRustMonthFinished(record, model)) || null;
  }

  async function findOrderByNumber(orderNumber, model) {
    if (!orderNumber) return null;
    const selectFields = [model.orderEntity.PrimaryIdAttribute, model.orderEntity.PrimaryNameAttribute, 'statuscode', 'statecode'];
    if (model.orderStatusField) selectFields.push(model.orderStatusField.LogicalName);
    const filter = `${model.orderEntity.PrimaryNameAttribute} eq '${escapeODataString(orderNumber)}'`;
    const { data } = await api(
      `${model.orderEntity.EntitySetName}?$select=${selectFields.join(',')}&$filter=${encodeURIComponent(filter)}&$top=2`,
      { headers: { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' } },
    );
    return data.value?.length === 1 ? data.value[0] : null;
  }

  async function findExistingOrder(equipmentId, orderTypeValue, model, extraFilter = '') {
    const primaryId = model.orderEntity.PrimaryIdAttribute;
    const lookupValue = `_${model.equipmentLookup.LogicalName}_value`;
    const filter = `${lookupValue} eq ${equipmentId} and ${model.orderTypeField.LogicalName} eq ${orderTypeValue} and statecode eq 0${extraFilter}`;
    const selectFields = [primaryId, 'statuscode'];
    if (model.orderStatusField) selectFields.push(model.orderStatusField.LogicalName);
    const { data } = await api(
      `${model.orderEntity.EntitySetName}?$select=${selectFields.join(',')}&$filter=${encodeURIComponent(filter)}&$orderby=createdon desc&$top=20`,
      { headers: { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' } },
    );
    return data.value?.find((record) => !recordIsCancelled(record, model)) || null;
  }

  async function findLatestNonCancelledOrder(equipmentId, orderTypeValue, model, extraFilter = '') {
    const primaryId = model.orderEntity.PrimaryIdAttribute;
    const lookupValue = `_${model.equipmentLookup.LogicalName}_value`;
    const filter = `${lookupValue} eq ${equipmentId} and ${model.orderTypeField.LogicalName} eq ${orderTypeValue}${extraFilter}`;
    const selectFields = [primaryId, 'statuscode'];
    if (model.orderStatusField) selectFields.push(model.orderStatusField.LogicalName);
    const { data } = await api(
      `${model.orderEntity.EntitySetName}?$select=${selectFields.join(',')}&$filter=${encodeURIComponent(filter)}&$orderby=createdon desc&$top=50`,
      { headers: { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' } },
    );
    return data.value?.find((record) => !recordIsCancelled(record, model)) || null;
  }

  async function existingOrderIsCancelled(orderId, model) {
    const selectFields = ['statuscode'];
    if (model.orderStatusField) selectFields.push(model.orderStatusField.LogicalName);
    const { data } = await api(
      `${model.orderEntity.EntitySetName}(${normalizeGuid(orderId)})?$select=${selectFields.join(',')}`,
      { headers: { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' } },
    );
    return recordIsCancelled(data, model);
  }

  // Shipment PDI 按单号服务转移：单号是别人建好的订单，按单号找到订单，先写 Description，再走原来的服务转移。
  async function resolveOrderByNumber(item, run, model) {
    const primaryId = model.orderEntity.PrimaryIdAttribute;
    const preField = model.preTypeField?.LogicalName;
    const select = [primaryId, model.orderEntity.PrimaryNameAttribute, 'statuscode', 'statecode', '_ownerid_value', `_${model.equipmentLookup.LogicalName}_value`];
    if (model.orderStatusField) select.push(model.orderStatusField.LogicalName);
    if (preField) select.push(preField);
    const filter = `${model.orderEntity.PrimaryNameAttribute} eq '${escapeODataString(item.orderNumberInput)}'`;
    const { data } = await api(
      `${model.orderEntity.EntitySetName}?$select=${select.join(',')}&$filter=${encodeURIComponent(filter)}&$top=2`,
      { headers: { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' } },
    );
    const order = data.value?.length === 1 ? data.value[0] : null;
    if (!order) return { skipReason: data.value?.length ? `单号 ${item.orderNumberInput} 匹配到多张订单` : `找不到单号 ${item.orderNumberInput}` };
    if (Number(order.statecode) !== 0 || recordIsCancelled(order, model)) {
      return { skipReason: `订单 ${item.orderNumberInput} 已取消/停用` };
    }
    if (preField && order[preField] !== metadata.optionValue(model.preTypeField, SHIPMENT_PDI_PRE_TYPE)) {
      return { skipReason: `订单 ${item.orderNumberInput} 的预验收类型是“${formattedValue(order, preField) || '空'}”，不是 Shipment PDI` };
    }
    // 负责人已不是自己：说明已经服务转移过了，不再写 Description，直接跳过。
    if (order._ownerid_value && normalizeGuid(order._ownerid_value) !== await currentUserId()) {
      return { skipReason: `订单 ${item.orderNumberInput} 负责人已是 ${formattedValue(order, '_ownerid_value') || '别人'}（状态 ${orderStatusTexts(order, model).slice(-1)[0] || '未知'}），已转移过` };
    }
    item.equipmentName = formattedValue(order, `_${model.equipmentLookup.LogicalName}_value`) || '';
    const orderId = normalizeGuid(order[primaryId]);
    const text = String(run.shipmentDescription || '').trim();
    if (text && !item.descriptionWritten) {
      try {
        await api(`${model.orderEntity.EntitySetName}(${orderId})`, {
          method: 'PATCH',
          headers: { 'If-Match': '*' },
          body: JSON.stringify({ mcs_description: text }),
        });
      } catch (error) {
        throw new Error(`订单 ${item.orderNumberInput} 写入 Description 失败：${error.message}`);
      }
      item.descriptionWritten = true;
    }
    return {
      orderId,
      existing: true,
      orderNumber: order[model.orderEntity.PrimaryNameAttribute] || item.orderNumberInput,
      matchedStatus: orderStatusTexts(order, model).slice(-1)[0] || '',
    };
  }

  async function resolveOrderForItem(item, run, model) {
    if (run.orderKind === 'handover') return resolveHandoverOrder(item, model);
    if (item.orderNumberInput) return resolveOrderByNumber(item, run, model);
    const config = TYPE_CONFIG[run.orderKind];
    const equipmentId = await findEquipment(item.machineNo, model);
    const orderTypeValue = metadata.optionValue(model.orderTypeField, config.orderTypeLabel);
    if (run.orderKind === 'rust' && !isTransferMode(run)) {
      const finishedThisMonth = await findCurrentMonthFinishedRustOrder(
        equipmentId,
        orderTypeValue,
        model,
      );
      if (finishedThisMonth) {
        return {
          skipCurrentMonth: true,
          orderId: normalizeGuid(finishedThisMonth[model.orderEntity.PrimaryIdAttribute]),
          matchedStatus: rustSkipStatus(finishedThisMonth, model),
        };
      }
      // 本月已有但还没做完的防锈订单：打开它继续完成，不再新建。
      const openThisMonth = await findCurrentMonthOpenRustOrder(equipmentId, orderTypeValue, model);
      if (openThisMonth) {
        return {
          orderId: normalizeGuid(openThisMonth[model.orderEntity.PrimaryIdAttribute]),
          existing: true,
          orderNumber: openThisMonth[model.orderEntity.PrimaryNameAttribute] || '',
          matchedStatus: orderStatusTexts(openThisMonth, model).slice(-1)[0] || '',
        };
      }
    }

    if (run.chainMode && run.orderKind === 'pdi' && run.pdiDealer) {
      const dealer = await equipmentDealer(equipmentId);
      if (!dealer) return { skipReason: '直销设备（没有经销商），不做经销商 PDI' };
    }
    const typeFilter = pdiTypeFilter(run, model);
    const existing = run.orderKind === 'rust'
      ? null
      : await findExistingOrder(equipmentId, orderTypeValue, model, typeFilter);
    // 全流程里已经现场完工/提交审核/已完成的单直接跳过。
    if (run.chainMode && existing && isRustMonthFinished(existing, model)) {
      return { skipReason: `${run.pdiDealer ? '经销商 PDI' : '到港 PDI'} 已是 ${rustSkipStatus(existing, model) || '现场完工/提交审核/已完成'}` };
    }
    if (run.chainMode && run.pdiDealer && existing) {
      await assignDealerPdiToSelf(existing[model.orderEntity.PrimaryIdAttribute], null, item.machineNo);
    }
    if (existing && (!isTransferMode(run) || !run.forceCreateNew)) {
      return {
        orderId: normalizeGuid(existing[model.orderEntity.PrimaryIdAttribute]),
        existing: true,
      };
    }
    if (!isTransferMode(run) && run.orderKind !== 'rust' && !(run.chainMode && run.pdiDealer)) {
      throw new Error(run.chainMode
        ? `未找到机号“${item.machineNo}”的到港预验收订单。请先在你的账号用“转移/派单 → PDI 创建 → 服务转移”建单并转给这个账号，再继续`
        : `未找到机号“${item.machineNo}”对应的已有且未取消的${kindLabel(run) || config.label}订单`);
    }

    const payload = {
      [`${model.equipmentLookup.LogicalName}@odata.bind`]: `/${model.equipmentEntity.EntitySetName}(${equipmentId})`,
      [model.orderTypeField.LogicalName]: orderTypeValue,
    };
    if (config.needsPreInspectionType) {
      payload[model.preTypeField.LogicalName] = metadata.optionValue(
        model.preTypeField,
        runPreType(run, run.preInspectionType),
      );
    }

    let response;
    try {
      ({ response } = await api(model.orderEntity.EntitySetName, {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(payload),
      }));
    } catch (error) {
      if (run.orderKind === 'rust' && isDuplicateRustOrderCreateError(error)) {
        // D365 不让新建时，按提示的订单号找到那张单：没做完就打开继续完成，做完了才跳过。
        const conflictNo = conflictingOrderNumber(error);
        const conflict = await findOrderByNumber(conflictNo, model).catch(() => null);
        if (conflict && Number(conflict.statecode) === 0
          && !recordIsCancelled(conflict, model) && !isRustMonthFinished(conflict, model)) {
          return {
            orderId: normalizeGuid(conflict[model.orderEntity.PrimaryIdAttribute]),
            existing: true,
            orderNumber: conflictNo,
            matchedStatus: orderStatusTexts(conflict, model).slice(-1)[0] || '',
          };
        }
        const duplicate = conflict || await findLatestNonCancelledOrder(
          equipmentId,
          orderTypeValue,
          model,
        ).catch(() => null);
        return {
          skipDuplicateRust: true,
          orderId: duplicate
            ? normalizeGuid(duplicate[model.orderEntity.PrimaryIdAttribute])
            : null,
          conflictingOrderNumber: conflictingOrderNumber(error),
          conflictMessage: d365ErrorMessage(error),
        };
      }
      if (run.orderKind !== 'pdi' || !isDuplicatePreArrivalPdiCreateError(error)) throw error;
      const duplicate = existing
        || await findLatestNonCancelledOrder(equipmentId, orderTypeValue, model, typeFilter);
      if (!duplicate) {
        if (typeFilter && run.chainMode) {
          throw new Error(`D365 现在不允许新建经销商 PDI（可能要等到港 PDI 审批通过/完成后才能建）。等到港 PDI 通过后点“重新授权并继续”即可接着做。D365 原话：${d365ErrorMessage(error)}`);
        }
        if (typeFilter) {
          throw new Error(`D365 不允许再建 PDI：这台机已有其他预验收类型的到货预验收订单，没有可用的${kindLabel(run)}订单。D365 原话：${d365ErrorMessage(error)}`);
        }
        throw new Error(`D365 提示该设备已有到货预验收订单，但脚本未查询到可打开的未取消订单：${d365ErrorMessage(error)}`);
      }
      return {
        orderId: normalizeGuid(duplicate[model.orderEntity.PrimaryIdAttribute]),
        existing: true,
        reusedAfterCreateConflict: true,
        openAsPdiWorkflow: true,
      };
    }
    const entityIdHeader = response.headers.get('OData-EntityId') || '';
    const match = entityIdHeader.match(/\(([0-9a-f-]{36})\)/i);
    if (!match) throw new Error('订单已创建，但响应中没有返回订单 ID');
    if (run.chainMode && run.pdiDealer) await assignDealerPdiToSelf(match[1], null, item.machineNo);
    return { orderId: normalizeGuid(match[1]), existing: false };
  }

  // ===== 防锈派单 =====

  async function findDispatchPersonnel(target) {
    const name = String(target || '').trim();
    if (!name) throw new Error('未填写“派给”');
    const filter = `contains(mcs_name,'${escapeODataString(name)}') and mcs_accountstatus eq 3 and _mcs_systemuserid_value ne null and statecode eq 0`;
    const { data } = await api(
      `mcs_personnels?$select=mcs_personnelid,mcs_name,_mcs_systemuserid_value,_mcs_dealerid_value&$filter=${encodeURIComponent(filter)}&$top=10`,
    );
    const rows = data.value || [];
    if (rows.length !== 1) {
      throw new Error(rows.length
        ? `“${name}”匹配到 ${rows.length} 位人员（${rows.map((x) => String(x.mcs_name || '').trim()).join('、')}），请输入能唯一匹配的姓名`
        : `未找到账号已开通的人员“${name}”，请检查拼写`);
    }
    const row = rows[0];
    return {
      id: normalizeGuid(row.mcs_personnelid),
      name: String(row.mcs_name || '').replace(/\s+/g, ' ').trim(),
      systemUserId: normalizeGuid(row._mcs_systemuserid_value),
      dealerId: normalizeGuid(row._mcs_dealerid_value),
    };
  }

  const DISPATCH_ORDER_SELECT = 'mcs_name,mcs_status,statuscode,createdon,_mcs_engineer_value,mcs_serviceordermode,_mcs_dealerid_value';

  async function readDispatchOrder(orderId) {
    const { data } = await api(
      `mcs_consultationorders(${normalizeGuid(orderId)})?$select=${DISPATCH_ORDER_SELECT}`,
      { headers: { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' } },
    );
    return data;
  }

  async function findCurrentMonthRustOrders(equipmentId, orderTypeValue, model) {
    const lookupValue = `_${model.equipmentLookup.LogicalName}_value`;
    const range = currentMonthUtcRange();
    const filter = `${lookupValue} eq ${equipmentId} and ${model.orderTypeField.LogicalName} eq ${orderTypeValue} and statecode eq 0 and createdon ge ${range.start} and createdon lt ${range.end}`;
    const { data } = await api(
      `mcs_consultationorders?$select=mcs_consultationorderid,${DISPATCH_ORDER_SELECT}&$filter=${encodeURIComponent(filter)}&$orderby=createdon desc&$top=50`,
      { headers: { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' } },
    );
    return (data.value || []).filter((record) => !recordIsCancelled(record, model));
  }

  function formattedValue(record, field) {
    return record?.[`${field}@OData.Community.Display.V1.FormattedValue`] ?? record?.[field] ?? '';
  }

  // 前置条件 1：本月已有 In Approval / Completed 防锈单则跳过。
  // 前置条件 2：本月必须已有状态为 Created 的防锈单（本模式不新建订单）。
  async function resolveRustDispatchOrder(item, model) {
    const equipmentId = await findEquipment(item.machineNo, model);
    const orderTypeValue = metadata.optionValue(model.orderTypeField, TYPE_CONFIG.rust.orderTypeLabel);
    const finished = await findCurrentMonthFinishedRustOrder(equipmentId, orderTypeValue, model);
    if (finished) {
      const status = rustSkipStatus(finished, model) || '现场完工/In Approval/Completed';
      return { skipReason: `本月已做过防锈运转（${status}）` };
    }
    const orders = await findCurrentMonthRustOrders(equipmentId, orderTypeValue, model);
    const created = orders.find((record) => Number(record.mcs_status) === ORDER_STATUS_CREATED);
    if (!created) {
      return {
        skipReason: orders.length
          ? `本月防锈订单 ${orders[0].mcs_name} 状态为 ${formattedValue(orders[0], 'mcs_status')}，不是 Created`
          : '本月没有已创建的防锈订单',
      };
    }
    return { orderId: normalizeGuid(created.mcs_consultationorderid), order: created };
  }

  async function callAssignApi(personnelId, orderId) {
    const { data } = await api(ASSIGN_API, {
      method: 'POST',
      body: JSON.stringify({ PersonnelId: personnelId, Items: [normalizeGuid(orderId)] }),
    });
    let result = null;
    try {
      result = typeof data?.Result === 'string' ? JSON.parse(data.Result) : data?.Result;
    } catch { /* 返回值不是 JSON 时按原文处理 */ }
    if (result && result.Result === false) {
      throw new Error(`派单接口返回失败：${result.Description || data.Result}`);
    }
    return result?.Description || '';
  }

  // 经销商 PDI 是 Dealer 模式订单，页面上没有“服务转移”。创建后改用 Assign（派单）派给“转移给”填写的人。
  // 返回后本单已处理完（done 或 skipped），currentIndex 已前移。
  async function assignDealerPdi(run, item, panel) {
    let person = run.dealerAssignee;
    if (!person?.id) {
      person = await findDispatchPersonnel(run.transferTarget);
      run.dealerAssignee = person;
      saveState(run);
    }
    const close = (stage, message, reason = '') => {
      item.stage = stage;
      item.error = '';
      if (reason) {
        item.skipReason = reason;
        item.skippedAt = new Date().toISOString();
      }
      delete item.pdiPhase;
      run.currentIndex += 1;
      saveState(run);
      panel.log(`${item.machineNo}：${message}`);
      panel.refresh();
    };
    let order = await readDispatchOrder(item.orderId);
    item.orderNumber ||= order.mcs_name;
    const engineerOf = (record) => normalizeGuid(record._mcs_engineer_value);
    const engineerName = (record) => formattedValue(record, '_mcs_engineer_value') || '空';

    // 派单提交前已存盘；页面刷新或中断后只核对结果，不会再次提交。
    if (item.stage === 'dealer-assign-submitting') {
      if (engineerOf(order) === person.id) {
        close('done', `经销商 PDI ${item.orderNumber} 已派单给 ${person.name}（状态 ${formattedValue(order, 'mcs_status')}）`);
        return;
      }
      throw new Error(`上次派单提交后未能确认结果（订单 ${item.orderNumber} 工程师为 ${engineerName(order)}）；为避免重复派单，请人工核对后再“跳过当前单”或清除任务`);
    }
    if (engineerOf(order) === person.id) {
      close('done', `经销商 PDI ${item.orderNumber} 的工程师已经是 ${person.name}，不用再派`);
      return;
    }
    if (Number(order.mcs_status) !== ORDER_STATUS_CREATED) {
      const reason = `经销商 PDI ${item.orderNumber} 状态已是 ${formattedValue(order, 'mcs_status')}（工程师 ${engineerName(order)}），不再派单`;
      close('skipped', `${reason}，跳过`, reason);
      return;
    }
    const dealerId = normalizeGuid(order._mcs_dealerid_value);
    if (person.dealerId && dealerId && person.dealerId !== dealerId) {
      throw new Error(`${person.name} 所属经销商与订单 ${item.orderNumber} 的经销商（${formattedValue(order, '_mcs_dealerid_value')}）不一致，系统不允许这样派单`);
    }

    item.stage = 'dealer-assign-submitting';
    saveState(run);
    panel.refresh();
    panel.log(`${item.machineNo}：经销商 PDI 没有服务转移，改为派单（Assign）给 ${person.name}…`);
    const description = await callAssignApi(person.id, item.orderId);
    for (let i = 0; i < 10 && engineerOf(order) !== person.id; i++) {
      await sleep(1500);
      order = await readDispatchOrder(item.orderId);
    }
    if (engineerOf(order) !== person.id) {
      throw new Error(`派单接口已调用${description ? `（${description}）` : ''}，但订单 ${item.orderNumber} 工程师仍是 ${engineerName(order)}，请人工核对`);
    }
    close('done', `经销商 PDI ${item.orderNumber} 已派单给 ${person.name}（状态 ${formattedValue(order, 'mcs_status')}）`);
  }

  async function dispatchOrderCommandState() {
    return waitForCommandBarSettled(() => {
      if (!currentRecordContextReady()) return false;
      const progress = findTopLevelAction(DISPATCH_PROGRESS_LABELS);
      if (progress) return { hasProgress: true, label: elementText(progress) };
      return findTopLevelAction(['刷新', 'Refresh', '保存', 'Save'])
        ? { hasProgress: false }
        : false;
    }, '等待订单页面及功能键完全加载超过60秒');
  }

  function skipDispatchItem(run, item, panel, reason) {
    item.stage = 'skipped';
    item.error = '';
    item.skipReason = reason;
    item.skippedAt = new Date().toISOString();
    run.currentIndex += 1;
    saveState(run);
    panel.log(`${item.machineNo}：${reason}，跳过`);
    panel.refresh();
  }

  // 返回 'navigated' 表示已跳转页面（刷新后会自动继续），其余情况本单已处理完。
  async function processRustDispatchItem(run, item, panel) {
    const person = run.dispatchPersonnel;
    if (!person?.id) throw new Error('派单对象未确认，请清除任务后重新开始');

    // 派单提交前已存盘。若提交后页面刷新或中断，只核对结果，绝不自动再次提交。
    if (item.stage === 'dispatch-submitting') {
      const order = await readDispatchOrder(item.orderId);
      if (Number(order.mcs_status) === ORDER_STATUS_CREATED) {
        throw new Error('上次派单提交后的结果未能确认，订单仍为 Created；为避免重复派单，请人工核对后再“跳过当前单”或清除任务');
      }
      item.stage = 'done';
      item.error = '';
      run.currentIndex += 1;
      saveState(run);
      panel.log(`${item.machineNo}：已确认派单生效（当前状态 ${formattedValue(order, 'mcs_status')}）`);
      panel.refresh();
      return 'done';
    }

    if (!item.orderId) {
      panel.log(`${item.machineNo}：检查本月防锈运转记录和已创建订单…`);
      const model = await resolveModel(TYPE_CONFIG.rust);
      const result = await resolveRustDispatchOrder(item, model);
      if (result.skipReason) {
        skipDispatchItem(run, item, panel, result.skipReason);
        return 'skipped';
      }
      item.orderId = result.orderId;
      item.orderNo = result.order.mcs_name;
      item.stage = 'dispatch-checking';
      saveState(run);
      panel.log(`${item.machineNo}：找到 Created 状态的防锈订单 ${item.orderNo}`);
    }

    // 每次都重新读取订单，防止中途已被别人派过。
    const order = await readDispatchOrder(item.orderId);
    item.orderNo ||= order.mcs_name;
    if (Number(order.mcs_status) !== ORDER_STATUS_CREATED) {
      skipDispatchItem(run, item, panel, `订单 ${item.orderNo} 状态已是 ${formattedValue(order, 'mcs_status')}，不需要派单`);
      return 'skipped';
    }
    const engineerId = normalizeGuid(order._mcs_engineer_value);
    if (engineerId && engineerId === person.id) {
      skipDispatchItem(run, item, panel, `订单 ${item.orderNo} 的工程师已经是 ${person.name}`);
      return 'skipped';
    }
    const dealerId = normalizeGuid(order._mcs_dealerid_value);
    if (Number(order.mcs_serviceordermode) === SERVICE_MODE_DEALER && dealerId
      && person.dealerId && person.dealerId !== dealerId) {
      throw new Error(`${person.name} 所属经销商与订单 ${item.orderNo} 的经销商不一致，系统不允许这样派单`);
    }

    // 前置条件 3：打开订单页面，确认当前账号看不到接受/出发/到达等按键才派单。
    const currentId = normalizeGuid(new URLSearchParams(location.search).get('id'));
    if (currentId !== normalizeGuid(item.orderId)) {
      item.stage = 'dispatch-checking';
      saveState(run);
      location.href = recordUrl(item.orderId);
      return 'navigated';
    }
    panel.log(`${item.machineNo}：等待订单 ${item.orderNo} 的功能键加载，检查是否有可操作按键…`);
    const commandState = await dispatchOrderCommandState();
    if (commandState.hasProgress) {
      skipDispatchItem(run, item, panel, `订单 ${item.orderNo} 有可操作按键“${commandState.label}”，不需要派单`);
      return 'skipped';
    }

    item.stage = 'dispatch-submitting';
    item.error = '';
    saveState(run);
    panel.refresh();
    panel.log(`${item.machineNo}：订单 ${item.orderNo} 无可操作按键，派给 ${person.name}…`);
    let description = '';
    try {
      description = await callAssignApi(person.id, item.orderId);
    } catch (error) {
      // 服务器明确返回错误时派单肯定没有生效，可以修正后重试；
      // 网络中断或超时则保留 dispatch-submitting，下次只核对结果、不重复提交。
      if (/^(D365 API \d+|派单接口返回失败)/.test(String(error?.message || ''))) {
        item.stage = 'failed';
        saveState(run);
        if (/^D365 API 40[13]/.test(error.message)) {
          throw new Error(`当前账号没有派单权限，请换用有 Assign 按键的账号运行（${d365ErrorMessage(error).slice(0, 200)}）`);
        }
      }
      throw error;
    }

    const after = await readDispatchOrder(item.orderId);
    item.stage = 'done';
    item.error = '';
    item.dispatchedTo = person.name;
    run.currentIndex += 1;
    saveState(run);
    panel.log(`${item.machineNo}：订单 ${item.orderNo} 已派给 ${person.name}，当前状态 ${formattedValue(after, 'mcs_status')}${description ? `（${description}）` : ''}`);
    panel.refresh();
    return 'done';
  }

  // ===== 设备变更 =====
  // 粘贴机号 → 逐台新建（或继续未提交的）设备变更单 → 填 Service Dealer 等字段 → 提交审批。
  const EC_ENTITY = 'mcs_equipmentchangerequest';
  const EC_SET = 'mcs_equipmentchangerequests';
  const EC_STATUS_NEW = 10;
  const EC_STATUS_SUBMITTED = 20;
  const EC_CONFIG_KEY = `${APP_ID}:equipment-change-config:v1`;
  const EC_FIELDS = ['ecDealer', 'ecDealerMain', 'ecEngineer', 'ecManager', 'ecHours', 'ecRemark', 'ecUsage', 'ecAddress', 'ecModel', 'ecType', 'ecWarrantyValue', 'ecWarrantyMonth'];
  const EC_DEFAULTS = {
    ecDealer: 'C&O TRACTORS LTD', ecDealerMain: '', ecEngineer: '', ecManager: '', ecHours: '1', ecRemark: '',
    ecUsage: 'Usable', ecAddress: 'uk', ecModel: 'sy', ecType: '', ecWarrantyValue: '', ecWarrantyMonth: '',
  };
  // Equipment Type 选项（D365 里的值 → 名称）。系统里有两个都叫 Trial Machine，所以按数值选，不按名字。
  const EC_EQUIPMENT_TYPES = [
    [10, 'Host'], [20, 'Second-hand Machine'], [30, 'Sample Machine'], [40, 'Legal Machine'],
    [50, 'Trial Machine'], [60, 'Spare Machine'], [70, 'Rental Machine'], [80, 'Trial Machine'],
  ];
  function ecTypeLabel(value) {
    const row = EC_EQUIPMENT_TYPES.find(([v]) => v === Number(value));
    return row ? row[1] : '';
  }
  const FORMATTED_PREFER = 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"';

  function isEquipmentChangeMode(run) {
    return run?.runMode === RUN_MODE.EQUIPMENT_CHANGE;
  }

  function loadEcConfig() {
    try {
      return { ...EC_DEFAULTS, ...(JSON.parse(localStorage.getItem(EC_CONFIG_KEY) || '{}') || {}) };
    } catch {
      return { ...EC_DEFAULTS };
    }
  }

  function saveEcConfig(config) {
    try { localStorage.setItem(EC_CONFIG_KEY, JSON.stringify(config)); } catch { /* 忽略 */ }
  }

  const normText = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  // 按词搜索名称：D365 里的名字可能有两个连续空格（网页上看起来只有一个），整句 contains 会搜不到，
  // 所以拆成每个词都要包含，再用 normText（把多个空格当一个）精确比较。
  const containsEveryWord = (field, text) => {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    return `(${words.map((word) => `contains(${field},'${escapeODataString(word)}')`).join(' and ')})`;
  };

  // 每行一个机号；机号后面可以跟工时（空格、逗号或 Tab 分隔），例如“SYK11005PT5C01885 12”。
  function parseMachineLines(text) {
    const seen = new Set();
    const items = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const parts = raw.trim().split(/[\s,，;；]+/).filter(Boolean);
      const machineNo = parts[0];
      if (!machineNo || seen.has(machineNo.toUpperCase())) continue;
      seen.add(machineNo.toUpperCase());
      const hours = parts.slice(1)
        .map((part) => Number(String(part).replace(/h$/i, '')))
        .find((value) => Number.isFinite(value));
      items.push({
        machineNo,
        dirName: machineNo,
        ecHours: Number.isFinite(hours) ? hours : null,
        files: [],
        missing: [],
        stage: 'pending',
        uploaded: [],
        error: '',
      });
    }
    return items;
  }

  async function resolveEcDealer(value) {
    const name = String(value || '').trim();
    if (!name) throw new Error('未填写 Service Dealer');
    const esc = escapeODataString(name);
    // 与表单上 Service Dealer 下拉（Dealer List 视图）一致：有效、没有上级经销商、类型为 Agent Network Information。
    const filter = `statecode eq 0 and _mcs_parentdealerid_value eq null and mcs_dealertype eq 20 and (mcs_code eq '${esc}' or mcs_dealercode eq '${esc}' or ${containsEveryWord('mcs_name', name)})`;
    const { data } = await api(`mcs_agents?$select=mcs_agentid,mcs_name,mcs_code,mcs_dealercode&$filter=${encodeURIComponent(filter)}&$top=20`);
    let rows = data.value || [];
    const byCode = rows.filter((row) => [row.mcs_code, row.mcs_dealercode].some((code) => normText(code) === normText(name)));
    const exact = rows.filter((row) => normText(row.mcs_name) === normText(name));
    if (byCode.length === 1) rows = byCode;
    else if (exact.length) rows = exact;
    if (rows.length !== 1) {
      throw new Error(rows.length
        ? `Service Dealer“${name}”匹配到 ${rows.length} 个：${rows.map((row) => `${row.mcs_name}（代码 ${row.mcs_code}）`).join('；')}，请改填代码`
        : `找不到 Service Dealer“${name}”`);
    }
    return { id: normalizeGuid(rows[0].mcs_agentid), name: rows[0].mcs_name, entityType: 'mcs_agent' };
  }

  async function resolveEcPersonnel(value, label) {
    const name = String(value || '').trim();
    if (!name) throw new Error(`未填写 ${label}`);
    const esc = escapeODataString(name);
    const { data } = await api(`mcs_personnels?$select=mcs_personnelid,mcs_name,mcs_code&$filter=${encodeURIComponent(`statecode eq 0 and (${containsEveryWord('mcs_name', name)} or mcs_code eq '${esc}')`)}&$top=20`);
    let rows = data.value || [];
    const exact = rows.filter((row) => normText(row.mcs_name) === normText(name) || normText(row.mcs_code) === normText(name));
    if (exact.length === 1) rows = exact;
    if (rows.length !== 1) {
      throw new Error(rows.length
        ? `${label}“${name}”匹配到 ${rows.length} 人：${rows.slice(0, 8).map((row) => `${String(row.mcs_name).trim()}（${row.mcs_code || '无工号'}）`).join('；')}，请填写更完整的姓名或工号`
        : `找不到 ${label}“${name}”`);
    }
    return { id: normalizeGuid(rows[0].mcs_personnelid), name: String(rows[0].mcs_name).replace(/\s+/g, ' ').trim(), entityType: 'mcs_personnel' };
  }

  async function resolveEcSettings(config) {
    const hours = Number(config.ecHours);
    if (!Number.isFinite(hours) || hours < 0) throw new Error('Current working time 请填写数字');
    if (!String(config.ecRemark || '').trim()) throw new Error('未填写 Change Remarks');
    // Service Dealer 不是必填：留空就保持设备原来的经销商不变。但至少要改一样东西。
    const dealerText = String(config.ecDealer || '').trim();
    // Dealer 单独一个框：填了就用它；留空就和 Service Dealer 填同一个（两个都空就都不改）。
    const mainDealerText = String(config.ecDealerMain || '').trim();
    // 质保：留空就不改；填了必须是整数，月数 D365 规定 1～60。
    const intOrNull = (value, label, min, max) => {
      const text = String(value ?? '').trim();
      if (!text) return null;
      const n = Number(text);
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} 要填 ${min}～${max} 的整数（现在是“${text}”）`);
      return n;
    };
    const warrantyValue = intOrNull(config.ecWarrantyValue, 'Warranty Policy Value', 0, 2147483647);
    const warrantyMonth = intOrNull(config.ecWarrantyMonth, 'Warranty Policy Month', 1, 60);
    if (!dealerText && !mainDealerText && !config.ecType && warrantyValue === null && warrantyMonth === null) {
      throw new Error('Dealer、Service Dealer、Equipment Type、质保都没填，没有要变更的内容');
    }
    return {
      dealer: dealerText ? await resolveEcDealer(dealerText) : null,
      mainDealer: mainDealerText
        ? await resolveEcDealer(mainDealerText)
        : (dealerText ? await resolveEcDealer(dealerText) : null),
      engineer: await resolveEcPersonnel(config.ecEngineer, 'Responsible Service Engineer'),
      manager: await resolveEcPersonnel(config.ecManager, 'Service Manager'),
      hours,
      remark: String(config.ecRemark).trim(),
      usage: String(config.ecUsage || '').trim(),
      address: String(config.ecAddress || '').trim(),
      model: String(config.ecModel || '').trim(),
      equipmentType: config.ecType ? Number(config.ecType) : null,
      warrantyValue,
      warrantyMonth,
    };
  }

  async function findEquipmentRecord(machineNo) {
    const filter = `mcs_name eq '${escapeODataString(machineNo)}'`;
    const { data } = await api(`mcs_equipments?$select=mcs_equipmentid,mcs_name,_mcs_servicedealerid_value,_mcs_dealerid_value,mcs_equipmenttype,mcs_warrantypolicyvalue,mcs_warrantypolicymonth&$filter=${encodeURIComponent(filter)}&$top=2`,
      { headers: { Prefer: FORMATTED_PREFER } });
    if (!data.value?.length) throw new Error(`D365 中未找到设备：${machineNo}`);
    if (data.value.length > 1) throw new Error(`D365 中存在多个同名设备：${machineNo}`);
    return data.value[0];
  }

  async function equipmentChangeRequests(equipmentId) {
    const filter = `_mcs_equipment_value eq ${equipmentId} and statecode eq 0`;
    const { data } = await api(`${EC_SET}?$select=mcs_equipmentchangerequestid,mcs_name,mcs_changestatus,createdon&$filter=${encodeURIComponent(filter)}&$orderby=createdon desc&$top=50`,
      { headers: { Prefer: FORMATTED_PREFER } });
    return data.value || [];
  }

  async function readEcRequest(id) {
    const { data } = await api(`${EC_SET}(${normalizeGuid(id)})?$select=mcs_name,mcs_changestatus,_mcs_servicedealerid_value,_mcs_dealerid_value,_mcs_personnel_30_value,_mcs_servicemanagerid_value,mcs_currentworkingtime,mcs_equipmenttype,mcs_warrantypolicyvalue,mcs_warrantypolicymonth`,
      { headers: { Prefer: FORMATTED_PREFER } });
    return data;
  }

  function ecRecordUrl(id = null) {
    return `${clientUrl()}/main.aspx?appid=${currentAppId()}&pagetype=entityrecord&etn=${EC_ENTITY}${id ? `&id=${normalizeGuid(id)}` : ''}`;
  }

  function currentFormIs(entity, id = null) {
    try {
      const page = globalThis.Xrm?.Page;
      if (page?.data?.entity?.getEntityName?.() !== entity) return false;
      if (id === null) return page.ui.getFormType() === 1;
      return normalizeGuid(page.data.entity.getId()) === normalizeGuid(id);
    } catch {
      return false;
    }
  }

  async function waitForEcForm(id = null) {
    return waitForPage(
      () => (currentFormIs(EC_ENTITY, id) && globalThis.Xrm?.Page?.getAttribute?.('mcs_equipment') ? globalThis.Xrm.Page : null),
      '等待设备变更单表单加载超过60秒',
      500,
    );
  }

  function setFormLookup(page, name, ref) {
    const attr = page.getAttribute(name);
    if (!attr) return false;
    const current = attr.getValue()?.[0];
    if (current && normalizeGuid(current.id) === ref.id) return false;
    attr.setValue([{ id: `{${ref.id.toUpperCase()}}`, name: ref.name, entityType: ref.entityType }]);
    attr.fireOnChange();
    return true;
  }

  function setFormValue(page, name, value, { onlyIfEmpty = false } = {}) {
    const attr = page.getAttribute(name);
    if (!attr) return false;
    const current = attr.getValue();
    if (onlyIfEmpty && hasFieldValue(current)) return false;
    if (current === value) return false;
    attr.setValue(value);
    attr.fireOnChange();
    return true;
  }

  function setFormOption(page, name, label, options = {}) {
    const attr = page.getAttribute(name);
    if (!attr) return false;
    const option = (attr.getOptions?.() || []).find((x) => normText(x.text) === normText(label));
    if (!option) throw new Error(`“${name}”没有选项“${label}”`);
    return setFormValue(page, name, option.value, options);
  }

  function ecMainDealer(settings) {
    return settings?.mainDealer === undefined ? (settings?.dealer || null) : settings.mainDealer;
  }

  function fillEcForm(page, settings, item) {
    const changed = [];
    const hours = Number.isFinite(item.ecHours) ? item.ecHours : settings.hours;
    if (settings.dealer && setFormLookup(page, 'mcs_servicedealerid', settings.dealer)) changed.push(`Service Dealer = ${settings.dealer.name}`);
    // Dealer（必填）：单独填了就用单独的，没填就和 Service Dealer 一样（旧任务没有 mainDealer 也按这个）。
    const mainDealer = ecMainDealer(settings);
    if (mainDealer && setFormLookup(page, 'mcs_dealerid', mainDealer)) changed.push(`Dealer = ${mainDealer.name}`);
    if (setFormLookup(page, 'mcs_personnel_30', settings.engineer)) changed.push(`Responsible Service Engineer = ${settings.engineer.name}`);
    if (setFormLookup(page, 'mcs_servicemanagerid', settings.manager)) changed.push(`Service Manager = ${settings.manager.name}`);
    if (setFormValue(page, 'mcs_currentworkingtime', hours)) changed.push(`Current working time = ${hours}`);
    if (setFormValue(page, 'cr0c0_changeremark', settings.remark)) changed.push(`Change Remarks = ${settings.remark}`);
    if (settings.usage && setFormOption(page, 'mcs_equipmentusagestatus', settings.usage, { onlyIfEmpty: true })) changed.push(`Equipment Usage Status = ${settings.usage}`);
    if (settings.address && setFormValue(page, 'mcs_equipmentaddress', settings.address, { onlyIfEmpty: true })) changed.push(`Equipment Address = ${settings.address}`);
    if (settings.model && setFormValue(page, 'mcs_modelmachinetype', settings.model, { onlyIfEmpty: true })) changed.push(`Model (Machine Type) = ${settings.model}`);
    if (settings.equipmentType) {
      // 这个字段可能是只读显示，强制随保存一起提交。
      try { page.getAttribute('mcs_equipmenttype')?.setSubmitMode?.('always'); } catch { /* 忽略 */ }
      if (setFormValue(page, 'mcs_equipmenttype', settings.equipmentType)) changed.push(`Equipment Type = ${ecTypeLabel(settings.equipmentType)}`);
    }
    if (Number.isInteger(settings.warrantyValue) && setFormValue(page, 'mcs_warrantypolicyvalue', settings.warrantyValue)) changed.push(`Warranty Policy Value = ${settings.warrantyValue}`);
    if (Number.isInteger(settings.warrantyMonth) && setFormValue(page, 'mcs_warrantypolicymonth', settings.warrantyMonth)) changed.push(`Warranty Policy Month = ${settings.warrantyMonth}`);
    return changed;
  }

  async function saveEcForm(page, what) {
    try {
      await waitForPagePromise(page.data.save(), `等待${what}保存超过60秒`);
    } catch (error) {
      if (error instanceof RunPausedError) throw error;
      throw new Error(`${what}保存失败：${error?.message || error}`);
    }
  }

  function ecSubmitCommand() {
    return [...document.querySelectorAll('[data-id*="SubmitApprove"]')].find((element) => (
      visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true'
    )) || findTopLevelAction(['Submit for Approval', '提交审批', '提交审核']);
  }

  async function submitEcRequest(run, item, panel) {
    item.stage = 'ec-submitting';
    saveState(run);
    let lastClick = 0;
    let lastOverflow = 0;
    let lastPoll = 0;
    const dialogSeen = new WeakMap();
    const result = await waitForPage(async () => {
      for (const dialog of nonMapDialogs()) {
        const text = (dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim();
        if (/Operation successful|操作成功|submitted successfully|提交成功/i.test(text)) {
          clickDialogConfirm(dialog);
          continue;
        }
        if (/^Error\b|错误|失败|failed|required|必填|cannot|不能|不允许/i.test(text)
          && !/Are you sure|确认要|确定要/i.test(text)) {
          return { error: text, dialog };
        }
        const button = findAnyClickable(['Yes', '是', 'OK', 'Ok', '确定', 'Confirm', '确认', 'Continue', '继续', 'Submit', '提交'], { exact: true, root: dialog });
        if (button) {
          const seen = dialogSeen.get(dialog) || Date.now();
          dialogSeen.set(dialog, seen);
          if (Date.now() - seen >= 800) {
            clickUiControl(button);
            dialogSeen.delete(dialog);
            panel.log(`${item.machineNo}：提交审批弹出提示，已确认（${text.slice(0, 80)}）`);
          }
        }
      }
      if (Date.now() - lastPoll >= 2000) {
        lastPoll = Date.now();
        const record = await readEcRequest(item.ecRequestId);
        if (Number(record.mcs_changestatus) !== EC_STATUS_NEW) {
          return { status: formattedValue(record, 'mcs_changestatus') };
        }
      }
      if (nonMapDialogs().length) return false;
      const command = ecSubmitCommand();
      if (command) {
        // 已点过且没有反应时，20 秒后才再点一次，避免重复提交。
        if (!lastClick || Date.now() - lastClick >= 20000) {
          clickUiControl(command);
          lastClick = Date.now();
        }
      } else if (Date.now() - lastOverflow >= 3000) {
        const overflow = [...document.querySelectorAll('button[data-id="OverflowButton"]')].filter(visible).at(-1);
        if (overflow) {
          clickUiControl(overflow);
          lastOverflow = Date.now();
        }
      }
      return false;
    }, '等待设备变更单提交审批超过60秒', 500);
    if (result.error) {
      clickDialogConfirm(result.dialog);
      throw new Error(`提交审批失败：${result.error.slice(0, 300)}`);
    }
    return result.status;
  }

  function finishEcItem(run, item, panel, message) {
    item.stage = 'done';
    item.error = '';
    run.currentIndex += 1;
    saveState(run);
    panel.log(`${item.machineNo}：${message}`);
    panel.refresh();
    return 'done';
  }

  // 返回 'navigated' 表示已跳转页面（刷新后自动继续）。
  async function processEquipmentChangeItem(run, item, panel) {
    const settings = run.ecSettings;
    if (!settings || (!settings.dealer?.id && !ecMainDealer(settings)?.id && !settings.equipmentType && !Number.isInteger(settings.warrantyValue) && !Number.isInteger(settings.warrantyMonth))) throw new Error('设备变更设置未确认，请清除任务后重新开始');

    if (item.stage === 'ec-submitting' && item.ecRequestId) {
      const record = await readEcRequest(item.ecRequestId);
      if (Number(record.mcs_changestatus) !== EC_STATUS_NEW) {
        return finishEcItem(run, item, panel, `设备变更单 ${item.ecRequestNo || record.mcs_name} 已提交（${formattedValue(record, 'mcs_changestatus')}）`);
      }
    }

    if (!item.ecRequestId) {
      const equipment = await findEquipmentRecord(item.machineNo);
      item.ecEquipmentId = normalizeGuid(equipment.mcs_equipmentid);
      const typeOk = !settings.equipmentType || Number(equipment.mcs_equipmenttype) === settings.equipmentType;
      const mainDealer = ecMainDealer(settings);
      const dealerOk = (!settings.dealer || normalizeGuid(equipment._mcs_servicedealerid_value) === settings.dealer.id)
        && (!mainDealer || normalizeGuid(equipment._mcs_dealerid_value) === mainDealer.id);
      const valueOk = !Number.isInteger(settings.warrantyValue) || Number(equipment.mcs_warrantypolicyvalue) === settings.warrantyValue;
      const monthOk = !Number.isInteger(settings.warrantyMonth) || Number(equipment.mcs_warrantypolicymonth) === settings.warrantyMonth;
      if (dealerOk && typeOk && valueOk && monthOk) {
        const done = [
          mainDealer && `Dealer 已经是 ${mainDealer.name}`,
          settings.dealer && `Service Dealer 已经是 ${settings.dealer.name}`,
          settings.equipmentType && `Equipment Type 已经是 ${ecTypeLabel(settings.equipmentType)}`,
          Number.isInteger(settings.warrantyValue) && `Warranty Policy Value 已经是 ${settings.warrantyValue}`,
          Number.isInteger(settings.warrantyMonth) && `Warranty Policy Month 已经是 ${settings.warrantyMonth}`,
        ].filter(Boolean).join('、');
        skipDispatchItem(run, item, panel, `设备的 ${done}，不需要变更`);
        return 'skipped';
      }
      const requests = await equipmentChangeRequests(item.ecEquipmentId);
      const pending = requests.find((record) => Number(record.mcs_changestatus) === EC_STATUS_SUBMITTED);
      if (pending) {
        skipDispatchItem(run, item, panel, `已有审批中的设备变更单 ${pending.mcs_name}`);
        return 'skipped';
      }
      const draft = requests.find((record) => Number(record.mcs_changestatus) === EC_STATUS_NEW);
      if (draft) {
        item.ecRequestId = normalizeGuid(draft.mcs_equipmentchangerequestid);
        item.ecRequestNo = draft.mcs_name;
        item.stage = 'ec-filling';
        saveState(run);
        panel.log(`${item.machineNo}：找到未提交的设备变更单 ${draft.mcs_name}，继续使用`);
      } else {
        if (!currentFormIs(EC_ENTITY, null)) {
          item.stage = 'ec-creating';
          saveState(run);
          location.href = ecRecordUrl(null);
          return 'navigated';
        }
        const page = await waitForEcForm(null);
        panel.log(`${item.machineNo}：新建设备变更单，选择设备并保存…`);
        setFormLookup(page, 'mcs_equipment', { id: item.ecEquipmentId, name: equipment.mcs_name, entityType: 'mcs_equipment' });
        await sleep(3000);
        fillEcForm(page, settings, item);
        await sleep(1000);
        await saveEcForm(page, '新建的设备变更单');
        const id = normalizeGuid(page.data.entity.getId());
        if (!id) throw new Error('设备变更单已保存，但没有拿到单据 ID');
        item.ecRequestId = id;
        item.stage = 'ec-filling';
        saveState(run);
        try { item.ecRequestNo = (await readEcRequest(id)).mcs_name; } catch { /* 单号稍后再取 */ }
        saveState(run);
        panel.log(`${item.machineNo}：已新建设备变更单 ${item.ecRequestNo || id}`);
      }
    }

    if (!currentFormIs(EC_ENTITY, item.ecRequestId)) {
      saveState(run);
      location.href = ecRecordUrl(item.ecRequestId);
      return 'navigated';
    }
    const page = await waitForEcForm(item.ecRequestId);
    await sleep(2000);
    const record = await readEcRequest(item.ecRequestId);
    item.ecRequestNo ||= record.mcs_name;
    if (Number(record.mcs_changestatus) !== EC_STATUS_NEW) {
      return finishEcItem(run, item, panel, `设备变更单 ${item.ecRequestNo} 已是 ${formattedValue(record, 'mcs_changestatus')}，不再重复提交`);
    }

    panel.log(`${item.machineNo}：填写 Service Dealer、Responsible Service Engineer、Service Manager、工时和必填项…`);
    const changes = fillEcForm(page, settings, item);
    await sleep(1500);
    if (page.data.entity.getIsDirty()) await saveEcForm(page, '设备变更单');
    panel.log(`${item.machineNo}：${changes.length ? `已写入 ${changes.join('；')}` : '字段已是目标值'}`);

    const saved = await readEcRequest(item.ecRequestId);
    if (settings.dealer && normalizeGuid(saved._mcs_servicedealerid_value) !== settings.dealer.id) {
      throw new Error(`保存后 Service Dealer 是“${formattedValue(saved, '_mcs_servicedealerid_value') || '空'}”，不是 ${settings.dealer.name}，请检查表单`);
    }
    const savedMain = ecMainDealer(settings);
    if (savedMain && normalizeGuid(saved._mcs_dealerid_value) !== savedMain.id) {
      throw new Error(`保存后 Dealer 是“${formattedValue(saved, '_mcs_dealerid_value') || '空'}”，不是 ${savedMain.name}，请检查表单`);
    }
    if (settings.equipmentType && Number(saved.mcs_equipmenttype) !== settings.equipmentType) {
      throw new Error(`保存后 Equipment Type 是“${formattedValue(saved, 'mcs_equipmenttype') || '空'}”，不是 ${ecTypeLabel(settings.equipmentType)}，请检查表单（这个字段可能不允许修改）`);
    }
    for (const [key, field, label] of [['warrantyValue', 'mcs_warrantypolicyvalue', 'Warranty Policy Value'], ['warrantyMonth', 'mcs_warrantypolicymonth', 'Warranty Policy Month']]) {
      if (Number.isInteger(settings[key]) && Number(saved[field]) !== settings[key]) {
        throw new Error(`保存后 ${label} 是“${saved[field] ?? '空'}”，不是 ${settings[key]}，请检查表单`);
      }
    }

    panel.log(`${item.machineNo}：提交审批…`);
    const status = await submitEcRequest(run, item, panel);
    item.ecSubmittedStatus = status;
    return finishEcItem(run, item, panel, `设备变更单 ${item.ecRequestNo} 已提交（${status}）`);
  }

  function recordUrl(orderId, formId = FORM_ID) {
    return `${clientUrl()}/main.aspx?appid=${currentAppId()}&pagetype=entityrecord&etn=${ORDER_ENTITY}&id=${orderId}&formid=${formId || FORM_ID}`;
  }

  // ===== 交机 =====
  // 只处理已经建好的交机单（本版不新建）。开始前先确认：这台机有 PDI 订单，且 PDI 里有 Service Ticket；
  // 任何一项没有就跳过这台、不做交机，此时还没有改动任何数据。
  const PDI_ORDER_TYPE_LABEL = '到货预验收';
  const HANDOVER_TRAINING_NO = 0;

  function isServiceTicketFile(file) {
    return ['098', '118', '98'].includes(String(file?.Type || ''))
      || /service\s*ticket|服务工单/i.test(String(file?.Name || ''));
  }

  async function listOrderFiles(orderId) {
    const files = [];
    for (let page = 1; page <= 10; page += 1) {
      const { data } = await api('mcs_QueryUploadFile', {
        method: 'POST',
        body: JSON.stringify({
          EntityID: `{${normalizeGuid(orderId).toUpperCase()}}`,
          EntityName: ORDER_ENTITY,
          Page: page,
        }),
      });
      const result = JSON.parse(data?.Result || '{}');
      const rows = result.Results || [];
      files.push(...rows);
      if (!rows.length || files.length >= Number(result.TotalCount || 0)) break;
    }
    return files;
  }

  async function findOrderRecordsByType(equipmentId, typeValue, model) {
    const selectFields = [model.orderEntity.PrimaryIdAttribute, model.orderEntity.PrimaryNameAttribute, 'statuscode', 'statecode', 'createdon'];
    if (model.orderStatusField) selectFields.push(model.orderStatusField.LogicalName);
    const filter = `_${model.equipmentLookup.LogicalName}_value eq ${equipmentId} and ${model.orderTypeField.LogicalName} eq ${typeValue}`;
    const { data } = await api(
      `${model.orderEntity.EntitySetName}?$select=${selectFields.join(',')}&$filter=${encodeURIComponent(filter)}&$orderby=createdon desc&$top=50`,
      { headers: { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' } },
    );
    return (data.value || []).filter((record) => !recordIsCancelled(record, model));
  }

  async function resolveHandoverOrder(item, model) {
    const equipmentId = await findEquipment(item.machineNo, model);
    const idField = model.orderEntity.PrimaryIdAttribute;
    const nameField = model.orderEntity.PrimaryNameAttribute;

    const handoverType = metadata.optionValue(model.orderTypeField, TYPE_CONFIG.handover.orderTypeLabel);
    const handovers = (await findOrderRecordsByType(equipmentId, handoverType, model))
      .filter((record) => Number(record.statecode) === 0);
    // 已有交机单处于 现场完工 / 提交审核 / 已完成：已经做完，跳过。其他状态（含做到一半的）都继续做。
    const open = handovers.find((record) => !isRustMonthFinished(record, model)) || null;
    if (handovers.length && !open) {
      return { skipReason: `交机单 ${handovers[0][nameField]} 已是 ${rustSkipStatus(handovers[0], model) || '现场完工/提交审核/已完成'}` };
    }

    const pdiType = metadata.optionValue(model.orderTypeField, PDI_ORDER_TYPE_LABEL);
    const pdis = await findOrderRecordsByType(equipmentId, pdiType, model);
    if (!pdis.length) return { skipReason: '没有 PDI 订单，不做交机' };
    let ticketPdi = null;
    for (const pdi of pdis) {
      const files = await listOrderFiles(pdi[idField]);
      if (files.some(isServiceTicketFile)) {
        ticketPdi = pdi;
        break;
      }
    }
    // PDI 附件里没有 Service Ticket：和平时手动一样，从 PDI 的 Service Completion 现场生成一份（优先用已完成的 PDI）
    let generateTicket = false;
    if (!ticketPdi) {
      ticketPdi = pdis.find((pdi) => isRustMonthFinished(pdi, model)) || pdis[0];
      generateTicket = true;
    }
    const pdiInfo = {
      pdiOrderId: normalizeGuid(ticketPdi[idField]),
      pdiOrderNumber: ticketPdi[nameField] || '',
      generateTicket,
    };
    if (open) {
      return {
        orderId: normalizeGuid(open[idField]),
        existing: true,
        orderNumber: open[nameField] || '',
        matchedStatus: orderStatusTexts(open, model).slice(-1)[0] || '',
        ...pdiInfo,
      };
    }
    // 没有交机单：确认 PDI 和 Service Ticket 都在之后才新建。
    const created = await createHandoverOrder(equipmentId, handoverType, model, item.handoverDate);
    return { ...created, existing: false, matchedStatus: '', ...pdiInfo };
  }

  async function createHandoverOrder(equipmentId, handoverType, model, dateText = '') {
    const base = {
      [`${model.equipmentLookup.LogicalName}@odata.bind`]: `/${model.equipmentEntity.EntitySetName}(${equipmentId})`,
      [model.orderTypeField.LogicalName]: handoverType,
    };
    let response;
    try {
      ({ response } = await api(model.orderEntity.EntitySetName, {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ ...base, mcs_handoverdate: handoverDateIso(dateText) }),
      }));
    } catch (error) {
      // 个别环境新建时不接受交机日期：去掉后重试，日期在打开订单后再写。
      if (!/mcs_handoverdate/i.test(d365ErrorMessage(error))) {
        throw new Error(`新建交机单失败：${d365ErrorMessage(error).slice(0, 300)}`);
      }
      ({ response } = await api(model.orderEntity.EntitySetName, {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(base),
      }));
    }
    const match = (response.headers.get('OData-EntityId') || '').match(/\(([0-9a-f-]{36})\)/i);
    if (!match) throw new Error('交机单已创建，但响应中没有返回订单 ID');
    const orderId = normalizeGuid(match[1]);
    let orderNumber = '';
    try {
      const { data } = await api(`${model.orderEntity.EntitySetName}(${orderId})?$select=${model.orderEntity.PrimaryNameAttribute}`);
      orderNumber = data?.[model.orderEntity.PrimaryNameAttribute] || '';
    } catch { /* 单号读取失败不影响后续 */ }
    return { orderId, orderNumber };
  }

  // 每次重新查询，拿到新的下载链接。
  // ===== 不打开页面，直接生成某张订单的 Service Ticket（PDF） =====
  // 和订单表单 Service Completion 标签里的预览一模一样：
  // ms_GenerateFileTemplateData 拿模板和数据 → docxtemplater 填成 Word → 传到临时存储 → mcs_convertpdf 转成 PDF。
  // 只生成文件，不改订单。
  async function loadServiceTicketLibs() {
    for (const [name, ready] of [
      ['pizzip.js', () => window.PizZip],
      ['pizzip-utils.js', () => window.PizZipUtils],
      ['docxtemplater.js', () => window.docxtemplater],
      ['imagemodule.js', () => window.ImageModule],
    ]) {
      if (ready()) continue;
      const res = await fetch(`/WebResources/mcs_/CommonCore/Scripts/${name}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`加载 ${name} 失败：HTTP ${res.status}`);
      (0, eval)(await res.text()); // eslint-disable-line no-eval -- 和 D365 页面自己加载这些库一样
    }
  }

  async function generateServiceTicketPdf(orderId, fileName) {
    const id = normalizeGuid(orderId);
    const { data: tpl } = await api('ms_GenerateFileTemplateData', {
      method: 'POST',
      body: JSON.stringify({ EntityID: id, EntityName: 'mcs_consultationorder', ActionName: 'ConsultationOrderTemplate' }),
    });
    const file = tpl?.File ? JSON.parse(tpl.File) : null;
    if (!file?.Url) throw new Error('没有拿到 Service Ticket 模板');
    const values = JSON.parse(tpl.Data || '{}');
    // 图片：三张一行，转成 base64（和 docviewer.html 一样）
    const mime = (n) => ({ jpg: 'image/jpg', jpeg: 'image/jpg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp' })[String(n).split('.').pop().toLowerCase()] || 'application/octet-stream';
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
    await loadServiceTicketLibs();
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
    const docx = doc.getZip().generate({
      type: 'blob', compression: 'DEFLATE',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const { data: init } = await api('mcs_inittempfile', { method: 'POST', body: '{}' });
    const temp = JSON.parse(init.Result || '{}');
    const put = await fetch(temp.Url, {
      method: 'PUT', body: docx,
      headers: { 'Content-Type': 'application/octet-stream', 'x-ms-version': '2019-12-12', 'x-ms-date': new Date().toUTCString() },
    });
    if (!put.ok) throw new Error(`上传 Service Ticket 草稿失败：HTTP ${put.status}`);
    const { data: conv } = await api('mcs_convertpdf', {
      method: 'POST', body: JSON.stringify({ FileName: temp.FileName, DisplayName: `${id}.docx` }),
    });
    const pdfUrl = String(conv?.Result || '').replace(/^"|"$/g, '');
    if (!pdfUrl) throw new Error('转换 PDF 没有返回地址');
    const pdf = await fetch(pdfUrl);
    if (!pdf.ok) throw new Error(`下载生成的 Service Ticket 失败：HTTP ${pdf.status}`);
    const blob = await pdf.blob();
    if (!blob.size) throw new Error('生成的 Service Ticket 是空文件');
    return new File([blob], fileName || `${id.toUpperCase()}.pdf`, { type: 'application/pdf' });
  }

  async function downloadPdiServiceTicket(item) {
    const files = await listOrderFiles(item.pdiOrderId);
    const ticket = files.find(isServiceTicketFile);
    if (!ticket?.FileUrl) {
      // PDI 附件里没有：从 PDI 的 Service Completion 生成
      panelLog?.(`${item.machineNo}：PDI ${item.pdiOrderNumber} 附件里没有 Service Ticket，从它的 Service Completion 生成一份…`);
      return generateServiceTicketPdf(item.pdiOrderId, `${item.pdiOrderNumber || 'Service Ticket'}.pdf`);
    }
    const response = await fetch(ticket.FileUrl);
    if (!response.ok) throw new Error(`下载 PDI 的 Service Ticket 失败：HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.size) throw new Error('下载到的 PDI Service Ticket 是空文件');
    const name = String(ticket.Name || 'Service Ticket.pdf');
    const ext = (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
    const type = blob.type && blob.type !== 'application/octet-stream'
      ? blob.type
      : ({ pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' })[ext] || 'application/octet-stream';
    return new File([blob], name, { type });
  }

  function todayHandoverIso() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0).toISOString();
  }

  // 交机日期：面板上选了日期（YYYY-MM-DD）就用那天上午 9 点，没选就用今天。
  function handoverDateLocal(dateText) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText || ''));
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9, 0, 0);
  }
  function handoverDateIso(dateText) {
    const date = handoverDateLocal(dateText);
    return date ? date.toISOString() : todayHandoverIso();
  }

  function sameLocalDay(value, reference = new Date()) {
    if (!value) return false;
    const date = new Date(value);
    return date.getFullYear() === reference.getFullYear()
      && date.getMonth() === reference.getMonth()
      && date.getDate() === reference.getDate();
  }

  // 用 API 写入交机专用字段：交机日期=当天；到达后再写 Assessment Pass、无需培训、无故障。
  async function patchHandoverFields(item, panel, { afterArrival = false } = {}) {
    const { data } = await api(
      `mcs_consultationorders(${normalizeGuid(item.orderId)})?$select=mcs_handoverdate,mcs_ispassed,mcs_isneedonsitetrainingnew,mcs_existfault`,
    );
    const payload = {};
    const changes = [];
    const wanted = handoverDateLocal(item.handoverDate);
    if (!sameLocalDay(data.mcs_handoverdate, wanted || new Date())) {
      payload.mcs_handoverdate = handoverDateIso(item.handoverDate);
      changes.push(`Handover Date = ${wanted ? item.handoverDate : '今天'}`);
    }
    if (afterArrival) {
      if (data.mcs_ispassed !== true) {
        payload.mcs_ispassed = true;
        changes.push('Assessment Pass = Yes');
      }
      if (data.mcs_isneedonsitetrainingnew !== HANDOVER_TRAINING_NO) {
        payload.mcs_isneedonsitetrainingnew = HANDOVER_TRAINING_NO;
        changes.push('On-site training required = No');
      }
      if (data.mcs_existfault !== false) {
        payload.mcs_existfault = false;
        changes.push('Exist Fault = No');
      }
    }
    if (!Object.keys(payload).length) return;
    await api(`mcs_consultationorders(${normalizeGuid(item.orderId)})`, {
      method: 'PATCH',
      headers: { 'If-Match': '*' },
      body: JSON.stringify(payload),
    });
    await refreshOpenOrderForm(item.orderId);
    panel?.log(`${item.machineNo}：已写入 ${changes.join('；')}`);
  }

  // ---- 交机：出发前把设备位置设为当前所在位置 ----
  const DEFAULT_MAP_LAT = 28.23857;
  const DEFAULT_MAP_LNG = 113.092568;

  function selectEquipmentLocationCommand() {
    return [...document.querySelectorAll('[data-id*="SelectEquipmentLocation"]')].find((element) => (
      visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true'
    )) || findTopLevelAction(['Select Equipment Location', '选择设备位置']);
  }

  async function openSelectEquipmentLocationMap() {
    let lastCommand = 0;
    let lastOverflow = 0;
    await waitForPage(() => {
      closeExtraMapDialogs();
      if (visibleMapFrame(/AddressChoose\.html/i)) return true;
      if (nonMapDialogs().length) return false;
      const command = selectEquipmentLocationCommand();
      if (command) {
        if (!lastCommand || Date.now() - lastCommand >= MAP_COMMAND_RETRY_MS) {
          clickUiControl(command);
          lastCommand = Date.now();
        }
        return false;
      }
      // 窗口较窄时按钮会收进“更多命令”。
      const overflow = [...document.querySelectorAll('button[data-id="OverflowButton"]')].filter(visible).at(-1);
      if (overflow && Date.now() - lastOverflow >= 3000) {
        clickUiControl(overflow);
        lastOverflow = Date.now();
      }
      return false;
    }, '等待 Select Equipment Location 地图打开超过60秒', 500);
  }

  function usablePosition(lat, lng) {
    const a = Number(lat);
    const b = Number(lng);
    if (!Number.isFinite(a) || !Number.isFinite(b) || (a === 0 && b === 0)) return null;
    // 系统取不到定位时会退回长沙的默认坐标，不能当成当前位置。
    if (Math.abs(a - DEFAULT_MAP_LAT) < 1e-4 && Math.abs(b - DEFAULT_MAP_LNG) < 1e-4) return null;
    return { lat: a, lng: b };
  }

  async function currentBrowserPosition(win) {
    try {
      const client = win.Xrm?.Utility?.getGlobalContext?.().client?.getClient?.() || '';
      const getter = win.commonService?.getLatLng;
      if (typeof getter === 'function') {
        const resp = await Promise.race([getter.call(win.commonService, client), sleep(15000).then(() => null)]);
        const position = usablePosition(resp?.latitude, resp?.longitude);
        if (position) return position;
      }
    } catch { /* 改用浏览器定位 */ }
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve(usablePosition(pos.coords.latitude, pos.coords.longitude)),
        () => resolve(null),
        { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 },
      );
    });
  }

  function pauseForUser(run, item, panel, message) {
    saveState(run);
    panel.log(`${item.machineNo}：${message}`);
    pauseRequested = true;
    throw new RunPausedError();
  }

  async function selectEquipmentLocationHere(run, item, panel) {
    // 上次因定位失败暂停、由用户手动选好并关闭了地图：视为已完成。
    if (item.handoverLocationPending && !visibleMapFrame(/AddressChoose\.html/i)) {
      item.handoverLocationPending = false;
      item.handoverLocationSet = true;
      saveState(run);
      panel.log(`${item.machineNo}：设备位置已由你手动选好，继续`);
      return;
    }
    panel.log(`${item.machineNo}：点击 Select Equipment Location，把设备位置设为你当前所在的位置…`);
    await openSelectEquipmentLocationMap();
    const frame = visibleMapFrame(/AddressChoose\.html/i);
    const win = frame?.contentWindow;
    const doc = await mapDocument(/AddressChoose\.html/i);
    await waitForPage(
      () => Boolean(win?.google?.maps && win.addressChooseMap && findEquipmentLocationConfirm(doc) !== undefined),
      '等待设备位置地图加载超过60秒',
      500,
    );
    const position = await currentBrowserPosition(win);
    if (!position) {
      item.handoverLocationPending = true;
      pauseForUser(run, item, panel, '无法自动获取你当前的位置。请在打开的地图里选好你所在的位置并点 Confirm，然后点“重新授权并继续”');
    }
    const addressText = () => (doc.querySelector('.selected-address')?.innerText || '').replace(/\s+/g, ' ').trim();
    const before = addressText();
    win.google.maps.event.trigger(win.addressChooseMap, 'click', {
      latLng: new win.google.maps.LatLng(position.lat, position.lng),
    });
    const startedAt = Date.now();
    await waitForPage(() => {
      const confirm = findEquipmentLocationConfirm(doc);
      if (!confirm || confirm.classList.contains('disabled')) return false;
      const text = addressText();
      if (/:\s*-$/.test(text)) return false;
      return text !== before || Date.now() - startedAt >= 8000;
    }, '等待设备位置地址解析超过60秒', 500);
    await sleep(800);
    panel.log(`${item.machineNo}：设备位置选为 ${addressText().replace(/^[^:]*:\s*/, '') || `${position.lat}, ${position.lng}`}`);
    await confirmPdiEquipmentLocation();
    await ensureVisibleMapClosed('设备位置');
    item.handoverLocationSet = true;
    saveState(run);
  }

  // ---- 交机：到达前把 Environmental Safety 的 Assessment Pass/Fail 设为 Yes ----
  async function setHandoverAssessmentPass(item, panel) {
    const { data } = await api(`mcs_consultationorders(${normalizeGuid(item.orderId)})?$select=mcs_ispassed`);
    if (data.mcs_ispassed === true) return;
    await api(`mcs_consultationorders(${normalizeGuid(item.orderId)})`, {
      method: 'PATCH',
      headers: { 'If-Match': '*' },
      body: JSON.stringify({ mcs_ispassed: true }),
    });
    await refreshOpenOrderForm(item.orderId);
    panel.log(`${item.machineNo}：Environmental Safety 的 Assessment Pass/Fail 已设为 Yes`);
  }

  // ---- 交机：到达；如果要求填写地址就暂停，交给你手动处理 ----
  function arrivalNeedsAddress() {
    if (visibleMapFrame(/AddressChoose\.html/i)) return '弹出了选择地址的地图';
    if (equipmentLocationRequiredVisible()) return 'Equipment Location 必填';
    for (const dialog of nonMapDialogs()) {
      const text = (dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim();
      if (/Operation successful|操作成功/i.test(text)) continue;
      if (/address|地址/i.test(text) && /required|please|enter|fill|select|choose|必填|请|填写|选择/i.test(text)) {
        return text.slice(0, 120);
      }
    }
    return '';
  }

  async function arriveOrPauseForAddress(run, item, panel) {
    let watching = true;
    let addressReason = '';
    const watcher = (async () => {
      while (watching) {
        const reason = arrivalNeedsAddress();
        if (reason) {
          addressReason = reason;
          pauseRequested = true;
          return;
        }
        await sleep(500);
      }
    })();
    try {
      await runPdiArrive();
    } catch (error) {
      if (addressReason) {
        item.handoverAddressPause = true;
        saveState(run);
        panel.log(`${item.machineNo}：到达时要求填写地址（${addressReason}）。请你手动填写并完成“到达”，然后点“重新授权并继续”，脚本会接着上传文件和完成后续步骤`);
        throw new RunPausedError();
      }
      throw error;
    } finally {
      watching = false;
      await watcher;
    }
  }

  function hasFieldValue(value) {
    if (Array.isArray(value)) return value.length > 0;
    return value !== null && value !== undefined && String(value).trim() !== '';
  }

  // ===== 自动从客户那里找联系人和电话 =====
  // 像电话的才用：至少 7 个数字，只含 + 数字 空格 括号 横杠（排除“1970-07-09 02:30:38”这种错填）。
  function looksLikePhone(value) {
    const text = String(value || '').trim();
    return /^[+\d\s()\-]+$/.test(text) && (text.match(/\d/g) || []).length >= 7;
  }
  const cleanName = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  // 按顺序找：① 设备上记录的联系人 ② 同一客户以前订单里填过的联系人 ③ 客户名下的联系人（Contact）④ 客户本身的法人/名称和电话。
  async function findCustomerContact(order, orderId) {
    let accountId = normalizeGuid(order._mcs_customer_value || '');
    let accountName = formattedValue(order, '_mcs_customer_value') || '';
    if (order._mcs_equipment_value) {
      const { data: eq } = await api(
        `mcs_equipments(${normalizeGuid(order._mcs_equipment_value)})?$select=mcs_equipmentcontact1,mcs_equipmentcontacttel,_mcs_customer_value,_mcs_actualcustomer_value`,
        { headers: { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' } },
      );
      if (cleanName(eq.mcs_equipmentcontact1) && looksLikePhone(eq.mcs_equipmentcontacttel)) {
        return { name: cleanName(eq.mcs_equipmentcontact1), phone: String(eq.mcs_equipmentcontacttel).trim(), source: '设备档案' };
      }
      if (!accountId) {
        const id = eq._mcs_actualcustomer_value || eq._mcs_customer_value;
        accountId = id ? normalizeGuid(id) : '';
        accountName = formattedValue(eq, eq._mcs_actualcustomer_value ? '_mcs_actualcustomer_value' : '_mcs_customer_value') || '';
      }
    }
    if (!accountId) return null;
    const filter = `_mcs_customer_value eq ${accountId} and mcs_consultationorderid ne ${normalizeGuid(orderId)} and mcs_equipmentcontact1 ne null and mcs_equipmentcontacttel ne null`;
    const { data: past } = await api(
      `mcs_consultationorders?$select=mcs_name,mcs_equipmentcontact1,mcs_equipmentcontacttel&$filter=${encodeURIComponent(filter)}&$orderby=createdon desc&$top=10`,
    );
    const hit = (past.value || []).find((x) => cleanName(x.mcs_equipmentcontact1) && looksLikePhone(x.mcs_equipmentcontacttel));
    if (hit) return { name: cleanName(hit.mcs_equipmentcontact1), phone: String(hit.mcs_equipmentcontacttel).trim(), source: `${accountName} 以前的订单 ${hit.mcs_name}` };
    const { data: contacts } = await api(
      `contacts?$select=fullname,mobilephone,telephone1&$filter=${encodeURIComponent(`_parentcustomerid_value eq ${accountId} and statecode eq 0`)}&$orderby=modifiedon desc&$top=20`,
    );
    for (const c of contacts.value || []) {
      const phone = [c.mobilephone, c.telephone1].find(looksLikePhone);
      if (cleanName(c.fullname) && phone) return { name: cleanName(c.fullname), phone: String(phone).trim(), source: `${accountName} 的联系人` };
    }
    const { data: account } = await api(`accounts(${accountId})?$select=name,mcs_legalperson,mcs_phone,telephone1`);
    const phone = [account.mcs_phone, account.telephone1].find(looksLikePhone);
    if (phone) return { name: cleanName(account.mcs_legalperson) || cleanName(account.name), phone: String(phone).trim(), source: `客户 ${cleanName(account.name)} 本身` };
    return null;
  }

  // 订单上的联系人字段为空时，从客户那里找到联系人和电话写进去（只填空的，不覆盖已有的）。
  async function autoFillOrderContact(item, panel) {
    const orderId = normalizeGuid(item.orderId);
    const { data: order } = await api(
      `mcs_consultationorders(${orderId})?$select=_mcs_customer_value,_mcs_equipment_value,mcs_equipmentcontact1,mcs_equipmentcontacttel,mcs_customercontact,mcs_telephone`,
      { headers: { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' } },
    );
    const targets = [
      ['mcs_equipmentcontact1', 'name', 'Equipment Contact'],
      ['mcs_equipmentcontacttel', 'phone', 'Equipment Contact Phone'],
      ['mcs_customercontact', 'name', 'Customer contact'],
      ['mcs_telephone', 'phone', 'Telephone'],
    ].filter(([field]) => !String(order[field] || '').trim());
    if (!targets.length) return;
    const found = await findCustomerContact(order, orderId);
    if (!found) {
      panel.log(`${item.machineNo}：客户那里没找到可用的联系人和电话`);
      return;
    }
    const payload = Object.fromEntries(targets.map(([field, key]) => [field, found[key]]));
    await api(`mcs_consultationorders(${orderId})`, { method: 'PATCH', headers: { 'If-Match': '*' }, body: JSON.stringify(payload) });
    await refreshOpenOrderForm(orderId);
    panel.log(`${item.machineNo}：从${found.source}找到联系人 ${found.name} / ${found.phone}，已填入 ${targets.map(([, , label]) => label).join('、')}`);
  }

  // Completion On Site 需要 Equipment Contact 和电话：先自动从客户那里找；找不到才暂停，等你在表单里填好保存后继续。
  async function ensureHandoverContact(run, item, panel) {
    const specs = [['equipmentContact', 'Equipment Contact'], ['equipmentContactPhone', 'Equipment Contact Phone']];
    const formAttrs = specs.map(([key]) => formAttributeByLabel(ORDER_FIELD_SPECS[key].labels));
    // 你在表单里填了但还没保存：先替你保存，避免后面清理未保存内容时被丢掉。
    if (formAttrs.some((attr) => attr?.getIsDirty?.() && hasFieldValue(attr.getValue?.()))) {
      panel.log(`${item.machineNo}：保存你填写的设备联系人信息…`);
      await saveCurrentFormIfNeeded(true);
    }
    try {
      await autoFillOrderContact(item, panel);
    } catch (error) {
      if (error instanceof RunPausedError) throw error;
      panel.log(`${item.machineNo}：自动查找联系人失败（${error.message}），改为检查是否已填写`);
    }
    let missing;
    try {
      const model = await resolveModel(TYPE_CONFIG[run.orderKind]);
      const fields = [];
      for (const [key] of specs) fields.push(await resolveOrderField(key));
      const current = await readOrderFields(item.orderId, model, fields);
      missing = specs.filter(([key]) => !current[key].text).map(([, label]) => label);
    } catch (error) {
      if (error instanceof RunPausedError) throw error;
      missing = specs
        .filter(([key], index) => {
          const attr = formAttrs[index] || formAttributeByLabel(ORDER_FIELD_SPECS[key].labels);
          return attr && !hasFieldValue(attr.getValue?.());
        })
        .map(([, label]) => label);
    }
    if (missing.length) {
      pauseForUser(run, item, panel, `现场完工前需要填写 ${missing.join('、')}。请在 General 页填好并保存，然后点“重新授权并继续”`);
    }
  }

  async function uploadHandoverServiceTicket(run, item, panel) {
    const doc = await openAttachmentTab();
    const existing = attachmentRow(doc, SERVICE_TICKET_RULE, [englishTypeLabel(SERVICE_TICKET_RULE)]);
    if (existing) {
      await renameAttachmentRow(doc, existing, SERVICE_TICKET_RULE);
      item.handoverTicketUploaded = true;
      saveState(run);
      return;
    }
    panel?.log(`${item.machineNo}：从 PDI 订单 ${item.pdiOrderNumber} 下载 Service Ticket…`);
    const file = await downloadPdiServiceTicket(item);
    panel?.log(`${item.machineNo}：上传 Service Ticket（${file.name}）到交机单…`);
    await uploadOne(doc, SERVICE_TICKET_RULE, file);
    item.handoverTicketUploaded = true;
    saveState(run);
  }

  async function processHandoverItem(run, item, panel, initialOrderState) {
    const finishing = ['pdi-on-site-completing', 'handover-completing', 'pdi-approval-submitting'].includes(item.stage);
    if (!finishing) {
      item.stage = 'handover-preparing';
      saveState(run);
      await patchHandoverFields(item, panel);
      const state = await waitForOrderInitialCommandState();
      if (state === 'already-approved' || isPdiApprovedUi()) return 'already-approved';
      if (!isArrivedUi()) {
        await ensurePdiAccepted();
        if (!isSetOffUi() && !findTopLevelAction([
          'Navigation Set Off', '出发', 'Set Off',
          'Navigation Arrived', '到达', 'Arrived', 'Arrive',
        ])) {
          await sleep(3000);
          if (!findTopLevelAction(['Navigation Set Off', '出发', 'Set Off', 'Navigation Arrived', '到达', 'Arrived', 'Arrive'])) {
            pauseForUser(run, item, panel, `交机单 ${item.orderNumber || ''} 状态为 ${currentRecordStatusText() || '未知'}，当前账号没有接受/出发按键（可能需要先派单）。处理好后点“重新授权并继续”`);
          }
        }
        if (!isSetOffUi()) {
          if (!item.handoverLocationSet) await selectEquipmentLocationHere(run, item, panel);
          panel.log(`${item.machineNo}：出发（选择 Ground transportation）…`);
          await runPdiSetOff();
        }
        await setHandoverAssessmentPass(item, panel);
        panel.log(`${item.machineNo}：到达…`);
        await arriveOrPauseForAddress(run, item, panel);
      }
      await ensurePdiAccessoriesReady();
      item.stage = 'handover-fields';
      saveState(run);
      await patchHandoverFields(item, panel, { afterArrival: true });
      panel.log(`${item.machineNo}：检查并写入 Check Passed、工作小时 ${workingHoursValue(item)}…`);
      await applyOrderFields(run, item, panel, ['checkPassed', 'operatingHours'], async () => {
        await setPdiCheckPassed();
        await fillOperatingHours(run, item, panel);
      });
      item.stage = 'uploading';
      saveState(run);
      panel.log(`${item.machineNo}：上传四张照片…`);
      await uploadAttachments(run, item);
      await uploadHandoverServiceTicket(run, item, panel);
      item.stage = 'handover-completing';
      saveState(run);
    }
    if (item.stage !== 'pdi-approval-submitting') await ensureHandoverContact(run, item, panel);
    await discardFormChangesBeforeFinish(item, panel);
    if (item.stage !== 'pdi-approval-submitting') {
      panel.log(`${item.machineNo}：自动执行 Completion On Site…`);
      await completeOnSite(run, item, panel);
      item.stage = 'handover-completing';
      saveState(run);
    }
    await submitWithHoursCheck(run, item, panel);
    return 'done';
  }

  function visible(element) {
    if (!element?.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function elementText(element) {
    return (
      element.getAttribute?.('aria-label')
      || ('value' in element ? element.value : '')
      || element.textContent
      || ''
    ).replace(/\s+/g, ' ').trim();
  }

  function candidateElements(root = document) {
    const result = [...root.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],[role="tab"],[role="combobox"],input')];
    for (const iframe of root.querySelectorAll('iframe')) {
      try {
        if (iframe.contentDocument) result.push(...candidateElements(iframe.contentDocument));
      } catch { /* cross-origin iframe */ }
    }
    return result;
  }

  function findClickable(text, { exact = true, root = document } = {}) {
    const wanted = text.trim();
    const matches = candidateElements(root).filter((element) => {
      if (!visible(element)) return false;
      const value = elementText(element);
      const normalizedValue = value.toLocaleLowerCase();
      const normalizedWanted = wanted.toLocaleLowerCase();
      return exact ? normalizedValue === normalizedWanted : normalizedValue.includes(normalizedWanted);
    });
    // D365 命令栏经常是 role=menuitem 外层包着真正的 button。
    // 优先返回原生按钮，避免点到只有文字和布局作用的外层容器。
    const priority = (element) => {
      if (element.tagName === 'BUTTON') return 0;
      if (element.tagName === 'INPUT') return 1;
      if (element.getAttribute('role') === 'button') return 2;
      if (element.getAttribute('role') === 'menuitem') return 3;
      return 4;
    };
    return matches.sort((a, b) => priority(a) - priority(b))[0] || null;
  }

  function findAnyClickable(labels, options = {}) {
    return labels.map((label) => findClickable(label, options)).find(Boolean) || null;
  }

  // 高频轮询只能扫描顶层 D365 命令区。递归扫描所有 iframe 会在大型订单页
  // 每几百毫秒遍历数千个节点，是页面卡顿的主要来源。
  function findTopLevelAction(labels) {
    const wanted = labels.map((label) => label.trim().toLocaleLowerCase());
    return [...document.querySelectorAll(
      'button,[role="button"],[role="menuitem"],[role="tab"],input[type="button"],input[type="submit"]',
    )].find((element) => (
      visible(element)
      && wanted.includes(elementText(element).toLocaleLowerCase())
    )) || null;
  }

  function commandBarSignature() {
    const roots = [...document.querySelectorAll(
      '[role="menubar"],[data-id="command-bar"],[data-lp-id*="commandbar"],[class*="commandBar"]',
    )].filter(visible);
    const controls = roots.length
      ? roots.flatMap((root) => [...root.querySelectorAll('button,[role="button"],[role="menuitem"]')])
      : [...document.querySelectorAll('[role="menuitem"]')];
    return [...new Set(controls)].filter(visible).map(elementText).filter(Boolean).join('\u001f');
  }

  async function waitForCommandBarSettled(getState, reason, observeMs = 8000, stableMs = 2000) {
    let firstReadyAt = 0;
    let lastSignature = '';
    let stableSince = 0;
    return waitForPage(() => {
      const state = getState();
      if (!state) {
        firstReadyAt = 0;
        lastSignature = '';
        stableSince = 0;
        return false;
      }

      const now = Date.now();
      firstReadyAt ||= now;
      const signature = commandBarSignature();
      if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = now;
        return false;
      }
      if (now - firstReadyAt < observeMs || now - stableSince < stableMs) return false;
      return state;
    }, reason, 500);
  }

  let operationSuccessSequence = 0;

  function isPageDataChangedMessage(text) {
    return /The page data has changed\.?\s*Please refresh the page and try again!?/i.test(text)
      || /页面数据.*(?:已更改|已变更|发生变化|已修改).*刷新.*(?:重试|再试)/i.test(text);
  }

  function installScriptErrorAutoDismiss(panel) {
    const dialogSelector = '[role="dialog"],div[aria-modal="true"]';
    const handled = new WeakSet();
    const pending = new Set();
    let timer = null;

    const scan = (dialogs) => {
      for (const dialog of dialogs) {
        if (handled.has(dialog) || !visible(dialog)) continue;
        const text = (dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim();
        const isScriptError = /Script error/i.test(text)
          && /one of the scripts for this record has caused an error/i.test(text);
        const isKnownUatPropertyError = /Could not find a property named ['"]mcs_whetherbuclaims['"]/i.test(text)
          && /mcs_consultationorder/i.test(text);
        const isGateway502 = /RetrieveUserContext:\s*502|UciError:\s*502/i.test(text)
          || (/502/.test(text) && /gateway or proxy server/i.test(text));
        const isSignInPrompt = /Sign in to continue/i.test(text)
          && /Some components of this app require you to sign in/i.test(text);
        const isLeavePagePrompt = /Leave this page\?/i.test(text)
          && /select Cancel|选择.*取消|stay here/i.test(text);
        const isSavingInProgress = /Saving in Progress/i.test(text)
          && /Please wait while saving is completed/i.test(text);
        const isOperationSuccessful = /Operation successful!?/i.test(text);
        const isPageDataChanged = isPageDataChangedMessage(text);
        const isTarget = isScriptError
          || isKnownUatPropertyError
          || isGateway502
          || isSignInPrompt
          || isLeavePagePrompt
          || isSavingInProgress
          || isOperationSuccessful
          || isPageDataChanged;
        if (!isTarget) continue;

        const buttons = [...dialog.querySelectorAll('button,[role="button"]')].filter(visible);
        const closeButton = buttons.find((button) => /^(ok|确定)$/i.test(elementText(button)))
          || buttons.find((button) => /close|关闭/i.test([
            button.getAttribute('aria-label'),
            button.getAttribute('title'),
            button.getAttribute('data-id'),
          ].filter(Boolean).join(' ')))
          || (isSignInPrompt
            ? buttons.find((button) => !/sign in|登录/i.test(elementText(button)))
            : null);
        if (!closeButton) continue;

        if (isOperationSuccessful) operationSuccessSequence += 1;
        handled.add(dialog);
        clickUiControl(closeButton);
        panel?.log(isLeavePagePrompt
          ? '已自动确认并关闭 D365 “Leave this page?”弹窗'
          : isSavingInProgress
            ? '已自动关闭 D365 “Saving in Progress”弹窗'
            : isOperationSuccessful
              ? '已自动关闭 D365 “Operation successful!”弹窗'
              : isPageDataChanged
                ? '已自动关闭 D365 “The page data has changed”弹窗'
            : isSignInPrompt
              ? '已自动关闭 D365 “Sign in to continue”弹窗'
              : isKnownUatPropertyError
                ? '已自动关闭 UAT mcs_whetherbuclaims 配置错误弹窗'
                : isGateway502
                  ? '已自动关闭 D365 RetrieveUserContext 502 弹窗'
                  : '已自动关闭 D365 Script Error 弹窗');
      }
    };

    const addDialog = (node, includeDescendants = false) => {
      const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      if (!element) return;
      if (element.matches?.(dialogSelector)) pending.add(element);
      const owner = element.closest?.(dialogSelector);
      if (owner) pending.add(owner);
      if (includeDescendants) {
        for (const dialog of element.querySelectorAll?.(dialogSelector) || []) pending.add(dialog);
      }
    };

    const scheduleScan = (records) => {
      for (const record of records) {
        // mutation.target 往往是 D365 的大型页面容器，只检查其所属弹窗；
        // 仅对真正新增的节点检查子树，避免每次页面更新都遍历整页。
        addDialog(record.target, false);
        for (const node of record.addedNodes) addDialog(node, true);
      }
      if (!pending.size || timer) return;
      timer = setTimeout(() => {
        timer = null;
        const dialogs = [...pending];
        pending.clear();
        scan(dialogs);
      }, 250);
    };
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scan([...document.querySelectorAll(dialogSelector)]);
  }

  async function waitFor(getter, timeoutMs = 30000, intervalMs = 350, reloadOnStall = null) {
    const start = Date.now();
    let lastError;
    // timeoutMs === 0 表示无限等待，用于 D365 记录和自定义控件加载。
    while (timeoutMs === 0 || Date.now() - start < timeoutMs) {
      throwIfPaused();
      try {
        const value = await getter();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      if (reloadOnStall && Date.now() - start >= reloadOnStall.afterMs) {
        const run = getState();
        if (run) {
          const stallKey = `${run.currentIndex ?? 'none'}:${reloadOnStall.reason}`;
          run.stallReloads ||= {};
          if ((run.stallReloads[stallKey] || 0) >= 1) {
            throw new Error(`${reloadOnStall.reason}；自动刷新后仍无响应`);
          }
          run.stallReloads[stallKey] = 1;
          run.autoReloadCount = (run.autoReloadCount || 0) + 1;
          run.lastAutoReload = {
            at: new Date().toISOString(),
            reason: reloadOnStall.reason,
          };
          saveState(run);
        }
        location.reload();
        // 等待浏览器终止当前页面，防止刷新生效前继续执行后续步骤。
        await new Promise(() => {});
      }
      await sleep(intervalMs);
    }
    throw lastError || new Error(`等待页面元素超时（${Math.round(timeoutMs / 1000)}秒）`);
  }

  function waitForPage(getter, reason, intervalMs = 700) {
    return waitFor(getter, 0, intervalMs, { afterMs: PAGE_STALL_MS, reason });
  }

  async function clickCommand(labels, { exact = false } = {}) {
    const wanted = Array.isArray(labels) ? labels : [labels];
    const button = await waitForPage(
      () => (exact ? findTopLevelAction(wanted) : findAnyClickable(wanted, { exact })),
      `等待命令“${wanted[0]}”超过60秒`,
    );
    clickUiControl(button);
    await sleep(700);
  }

  async function selectDialogReason(labels) {
    const wanted = Array.isArray(labels) ? labels : [labels];
    let option = findAnyClickable(wanted, { exact: true });
    if (!option) {
      const dialog = [...document.querySelectorAll('[role="dialog"]')].find(visible) || document;
      const combo = [...dialog.querySelectorAll('[role="combobox"],input')].find(visible);
      if (combo) combo.click();
      option = await waitFor(() => findAnyClickable(wanted, { exact: true }), 12000);
    }
    option.click();
    await sleep(300);
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find(visible) || document;
    const confirm = findAnyClickable(['确定', '确认', '提交', 'OK', 'Confirm', 'Submit'], { exact: true, root: dialog });
    if (!confirm) throw new Error(`已选择“${wanted[0]}”，但未找到弹窗确认按钮`);
    confirm.click();
  }

  function visibleDialogs() {
    return [...document.querySelectorAll('[role="dialog"],div[aria-modal="true"]')].filter(visible);
  }

  function clickDialogConfirm(dialog) {
    const button = findAnyClickable(
      ['确定', '确认', '继续', '提交', 'OK', 'Confirm', 'Continue', 'Submit'],
      { exact: true, root: dialog },
    );
    if (!button) return false;
    clickUiControl(button);
    return true;
  }

  function currentRecordStatusText() {
    try {
      const pageId = normalizeGuid(globalThis.Xrm?.Page?.data?.entity?.getId?.());
      const urlId = normalizeGuid(new URLSearchParams(location.search).get('id'));
      // D365 是单页应用，切换订单后 Xrm.Page 可能短时间仍指向上一张订单。
      // 记录 ID 不一致时绝不能使用旧 statuscode 判断当前流程。
      if (!pageId || !urlId || pageId !== urlId) return '';
      return globalThis.Xrm?.Page?.getAttribute?.('statuscode')?.getText?.() || '';
    } catch {
      return '';
    }
  }

  function currentRecordContextReady() {
    try {
      const pageId = normalizeGuid(globalThis.Xrm?.Page?.data?.entity?.getId?.());
      const urlId = normalizeGuid(new URLSearchParams(location.search).get('id'));
      return !pageId || !urlId || pageId === urlId;
    } catch {
      return true;
    }
  }

  function isPdiApprovedUi() {
    if (!currentRecordContextReady()) return false;
    try {
      const attributes = globalThis.Xrm?.Page?.data?.entity?.attributes?.get?.() || [];
      const approvedAttribute = attributes.find((attribute) => {
        const name = String(attribute.getName?.() || '');
        const text = String(attribute.getText?.() || attribute.getValue?.() || '');
        return /approval/i.test(name) && /^(Approved|已批准|已审批)$/i.test(text.trim());
      });
      if (approvedAttribute) return true;
    } catch { /* fall back to visible form text */ }

    const labels = [...document.querySelectorAll('label,span,div')].filter((element) => (
      visible(element)
      && /^(Approval Status|审批状态|审核状态)$/i.test(elementText(element))
    ));
    return labels.some((label) => {
      let container = label.parentElement;
      for (let depth = 0; container && depth < 5; depth += 1, container = container.parentElement) {
        const text = (container.innerText || container.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length <= 300
          && /Approval Status|审批状态|审核状态/i.test(text)
          && /(?:^|\s)(Approved|已批准|已审批)(?:\s|$)/i.test(text)) return true;
      }
      return false;
    });
  }

  function isArrivedUi() {
    if (findTopLevelAction(['接受', 'Accept'])) return false;
    const status = currentRecordStatusText();
    return /已到达|Arrived/i.test(status)
      || Boolean(findTopLevelAction(
        ['现场完工', 'Completion On Site', '附件', 'Attachments', 'Accessories'],
      ));
  }

  function isSetOffUi() {
    if (findTopLevelAction(['接受', 'Accept'])) return false;
    if (isArrivedUi()) return false;
    const status = currentRecordStatusText();
    return /已出发|Departed|Set Off/i.test(status)
      || Boolean(findTopLevelAction(['到达', 'Arrive', 'Arrived', 'Navigation Arrived']));
  }

  // 地图 Web Resource 在 D365 弹窗中加载较慢：弹窗外框先出现，iframe 稍后才有尺寸。
  // 命令点击后只要有弹窗在打开/加载就不再重复点击；完全没有弹窗时才按此间隔重试。
  const MAP_COMMAND_RETRY_MS = 15000;
  const MAP_ACTION_RETRY_MS = 10000;

  function visibleMapFrames(fileNamePattern = /\/Map\//i) {
    return [...document.querySelectorAll('iframe')].filter((frame) => (
      visible(frame) && fileNamePattern.test(frame.src || '')
    ));
  }

  // 同时打开多个地图窗口时，DOM 中最后一个位于最上层，后续操作只针对它。
  function visibleMapFrame(fileNamePattern = /\/Map\//i) {
    return visibleMapFrames(fileNamePattern).at(-1) || null;
  }

  function closeMapFrame(frame) {
    const dialog = frame.closest('[role="dialog"],div[aria-modal="true"]');
    const root = dialog || frame.parentElement || document;
    const close = [...root.querySelectorAll('button,[role="button"]')].find((button) => (
      visible(button) && /^(Close|关闭)$/i.test(
        button.getAttribute('aria-label') || button.getAttribute('title') || elementText(button),
      )
    ));
    if (!close) return false;
    clickUiControl(close);
    return true;
  }

  // 只保留最上层的地图窗口，关闭之前重复打开、被压在下面的窗口。
  function closeExtraMapDialogs() {
    const frames = visibleMapFrames();
    for (const frame of frames.slice(0, -1)) closeMapFrame(frame);
    return frames.length > 1;
  }

  // 不包含地图 iframe 的弹窗（确认框、原因选择、提示等）。
  function nonMapDialogs() {
    return visibleDialogs().filter((dialog) => (
      ![...dialog.querySelectorAll('iframe')].some((frame) => /\/Map\//i.test(frame.src || ''))
    ));
  }

  async function mapDocument(fileNamePattern) {
    return waitForPage(() => {
      const frame = visibleMapFrame(fileNamePattern);
      try {
        return frame?.contentDocument?.body ? frame.contentDocument : null;
      } catch {
        return null;
      }
    }, '等待导航地图页面加载超过60秒');
  }

  function closeVisibleMapDialog() {
    const frame = visibleMapFrame();
    return frame ? closeMapFrame(frame) : false;
  }

  async function ensureVisibleMapClosed(actionName) {
    let lastCloseClick = 0;
    await waitForPage(() => {
      if (!visibleMapFrame()) return true;
      if (Date.now() - lastCloseClick >= 3000 && closeVisibleMapDialog()) {
        lastCloseClick = Date.now();
      }
      return false;
    }, `等待${actionName}地图完全关闭超过60秒`, 300);
  }

  function findEquipmentLocationConfirm(doc) {
    const candidates = [
      ...doc.querySelectorAll('.confirm-button,button,input[type="button"],input[type="submit"],[role="button"]'),
    ];
    return candidates.find((element) => (
      visible(element)
      && /^(Confirm|确认)$/i.test(elementText(element))
      && !element.disabled
      && element.getAttribute('aria-disabled') !== 'true'
    )) || null;
  }

  async function confirmPdiEquipmentLocation() {
    let lastClick = 0;
    let stableControl = null;
    let stableSince = 0;
    // 面板自带的弹窗监听器会抢先关掉“Operation successful!”，这里就看不到成功提示，
    // 以前会以为没成功、每 10 秒再点一次 Confirm，造成反复提交。用全局成功计数判断：
    // 点过 Confirm 之后计数增加，就算成功，不再重复点击。
    const successAtStart = operationSuccessSequence;
    await waitForPage(() => {
      if (lastClick && operationSuccessSequence > successAtStart) return true;
      for (const dialog of visibleDialogs()) {
        const text = (dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim();
        if (/Operation successful|操作成功/i.test(text)) {
          if (clickDialogConfirm(dialog)) return true;
          continue;
        }
        if (/Are you sure.*equipment location|确认.*设备位置|确定.*设备位置/i.test(text)) {
          clickDialogConfirm(dialog);
        }
      }

      const frame = visibleMapFrame(/AddressChoose\.html/i);
      if (!frame) return true;
      let doc;
      try {
        doc = frame.contentDocument;
      } catch {
        return false;
      }
      const confirmLocation = doc && findEquipmentLocationConfirm(doc);
      if (confirmLocation !== stableControl) {
        stableControl = confirmLocation;
        stableSince = Date.now();
        return false;
      }
      if (confirmLocation && Date.now() - stableSince < 1000) return false;
      // 只点一次；30 秒内既没成功提示也没关闭窗口，才补点一次。
      if (confirmLocation && !nonMapDialogs().length
        && (!lastClick || Date.now() - lastClick >= 30000)) {
        clickUiControl(confirmLocation);
        lastClick = Date.now();
      }
      return false;
    }, '等待设备位置 Confirm 完成超过60秒', 750);
    await sleep(500);
  }

  async function completeMapAction({
    question,
    reasons = [],
    actionName,
    retryControl = null,
    reachedTarget = null,
  }) {
    const successSequenceAtStart = operationSuccessSequence;
    const handledReasons = new WeakSet();
    let actionDialogSeen = false;
    let lastControlClick = 0;
    await waitForPage(async () => {
      // 全局弹窗监听器可能比当前步骤更早关闭 Operation successful。
      // 使用递增序号确认本次操作出现过成功提示，避免一直卡在地图中。
      if (operationSuccessSequence > successSequenceAtStart) return true;
      if (reachedTarget?.()) return true;
      for (const dialog of visibleDialogs()) {
        const text = (dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim();
        if (/Operation successful|操作成功/i.test(text)) {
          if (clickDialogConfirm(dialog)) return true;
          continue;
        }
        if (question.test(text)) {
          actionDialogSeen = true;
          clickDialogConfirm(dialog);
          continue;
        }
        const containsReason = reasons.some((label) => text.toLocaleLowerCase().includes(
          label.toLocaleLowerCase(),
        ));
        const reason = containsReason
          ? findAnyClickable(reasons, { exact: true, root: dialog })
          : null;
        if (reason && !handledReasons.has(dialog)) {
          actionDialogSeen = true;
          handledReasons.add(dialog);
          reason.click();
          await sleep(300);
          clickDialogConfirm(dialog);
        }
      }
      if (!actionDialogSeen && retryControl && !nonMapDialogs().length
        && (!lastControlClick || Date.now() - lastControlClick >= MAP_ACTION_RETRY_MS)) {
        const control = retryControl();
        if (control) {
          clickUiControl(control);
          lastControlClick = Date.now();
        }
      }
      return false;
    }, `等待${actionName}确认及成功提示超过60秒`, 300);
    await sleep(500);
    await ensureVisibleMapClosed(actionName);
  }

  async function ensurePdiAccepted() {
    const accept = findTopLevelAction(['接受', 'Accept']);
    if (!accept) return;
    clickUiControl(accept);
    await waitForPage(() => {
      for (const dialog of visibleDialogs()) {
        const text = (dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim();
        if (/Are you sure you want to accept order|确认.*接受|确定.*接受/i.test(text)) {
          clickDialogConfirm(dialog);
        } else if (/Operation successful|操作成功/i.test(text)) {
          clickDialogConfirm(dialog);
        }
      }
      // 普通 PDI 接受后出现出发/到达；经销商 PDI 没有出发/到达，接受后直接出现现场完工。
      return !findTopLevelAction(['接受', 'Accept'])
        && Boolean(findTopLevelAction(
          ['出发', 'Set Off', 'Navigation Set Off', '到达', 'Arrived', 'Navigation Arrived',
            '现场完工', 'Completion On Site'],
        ));
    }, '等待 PDI Accept 完成超过60秒', 750);
  }

  async function waitForPdiSetOffMap(fileNamePattern, reason) {
    let lastClick = 0;
    let stableCommand = null;
    let stableSince = 0;
    return waitForPage(() => {
      closeExtraMapDialogs();
      const frame = visibleMapFrame(fileNamePattern);
      if (frame) return frame;
      // 地图弹窗正在打开或加载（外框已出现、iframe 尚未显示）时，等待而不是再次点击。
      if (visibleDialogs().length) return false;

      const setOffCommand = findTopLevelAction(['Navigation Set Off', '出发', 'Set Off']);
      if (setOffCommand !== stableCommand) {
        stableCommand = setOffCommand;
        stableSince = Date.now();
        return false;
      }
      const disabled = !setOffCommand
        || setOffCommand.disabled
        || setOffCommand.getAttribute('aria-disabled') === 'true';
      if (!disabled && Date.now() - stableSince >= 1000
        && (!lastClick || Date.now() - lastClick >= MAP_COMMAND_RETRY_MS)) {
        clickUiControl(setOffCommand);
        lastClick = Date.now();
      }
      return false;
    }, reason, 1000);
  }

  async function openPdiSetOffPreview() {
    let frame = await waitForPdiSetOffMap(
      /AddressChoose\.html|NavigationPreview\.html/i,
      '等待 Set Off 地图加载超过60秒',
    );

    if (/AddressChoose\.html/i.test(frame.src || '')) {
      await mapDocument(/AddressChoose\.html/i);
      await confirmPdiEquipmentLocation();
      await ensureVisibleMapClosed('设备位置');

      frame = await waitForPdiSetOffMap(
        /NavigationPreview\.html/i,
        '等待 Set Off 出发模式页面加载超过60秒',
      );
    }
    return mapDocument(/NavigationPreview\.html/i);
  }

  async function waitForPdiTravelModes() {
    let previousDirect = null;
    let previousGround = null;
    let stableSince = 0;
    return waitForPage(() => {
      const frame = visibleMapFrame(/NavigationPreview\.html/i);
      let doc;
      try {
        doc = frame?.contentDocument;
      } catch {
        return false;
      }
      if (!doc?.body || doc.readyState !== 'complete') return false;

      const candidates = [...doc.querySelectorAll(
        '.travel-tag,button,[role="button"],label,[class*="travel"]',
      )].filter(visible);
      const shortestMatch = (pattern) => candidates
        .filter((element) => pattern.test(elementText(element)))
        .sort((a, b) => elementText(a).length - elementText(b).length)[0] || null;
      const direct = shortestMatch(/Direct access to the scene|直达现场/i);
      const ground = shortestMatch(/Ground Transportation|地面交通|其他/i);
      if (!direct || !ground) {
        previousDirect = null;
        previousGround = null;
        stableSince = 0;
        return false;
      }
      if (direct !== previousDirect || ground !== previousGround) {
        previousDirect = direct;
        previousGround = ground;
        stableSince = Date.now();
        return false;
      }
      return Date.now() - stableSince >= 1000 ? { doc, direct, ground } : false;
    }, '等待出发模式控件加载超过60秒', 750);
  }

  // Set Off 地图（NavigationPreview.html）默认出行方式是 Self Driving（代码 30），
  // 选它必须再选车辆，否则点 Set Off 只会弹“Please select a vehicle”、什么也不发生。
  // 所以每次点 Set Off 前都检查：Direct access to the scene 和 Ground Transportation
  // 两个标签都带 selected 样式；没有就补点，等页面真正切换过去再点 Set Off。
  let lastTravelTagClick = 0;
  function ensurePdiTravelSelection() {
    const frame = visibleMapFrame(/NavigationPreview\.html/i);
    let doc;
    try {
      doc = frame?.contentDocument;
    } catch {
      return false;
    }
    if (!doc?.body) return false;
    const tags = [...doc.querySelectorAll('.travel-tag')].filter(visible);
    const direct = tags.find((tag) => /Direct access to the scene|直达现场/i.test(elementText(tag)));
    const ground = tags.find((tag) => /Ground Transportation|地面交通|其他/i.test(elementText(tag)));
    if (!direct || !ground) return false;
    const isSelected = (tag) => tag.classList.contains('selected');
    if (isSelected(direct) && isSelected(ground)) return true;
    if (Date.now() - lastTravelTagClick >= 1200) {
      const target = isSelected(direct) ? ground : direct;
      target.scrollIntoView?.({ block: 'center' });
      clickUiControl(target);
      lastTravelTagClick = Date.now();
    }
    return false;
  }

  async function selectPdiTravelModes() {
    await waitForPage(
      () => ensurePdiTravelSelection(),
      '选择出发方式（Direct access to the scene + Ground Transportation）超过60秒',
      400,
    );
    // 再等一下确认没有被页面的异步加载改回 Self Driving。
    await sleep(800);
    if (!ensurePdiTravelSelection()) await selectPdiTravelModes();
  }

  function findVisibleMapAction(framePattern, classSelector, textPattern) {
    const frame = visibleMapFrame(framePattern);
    let doc;
    try {
      doc = frame?.contentDocument;
    } catch {
      return null;
    }
    if (!doc?.body) return null;
    const candidates = [...doc.querySelectorAll(
      `${classSelector},button,[role="button"],input[type="button"],input[type="submit"]`,
    )].filter((element) => (
      visible(element)
      && textPattern.test(elementText(element))
      && !element.disabled
      && element.getAttribute('aria-disabled') !== 'true'
    ));
    return candidates.sort((a, b) => elementText(a).length - elementText(b).length)[0] || null;
  }

  async function waitForStableMapAction(framePattern, classSelector, textPattern, reason) {
    let previous = null;
    let stableSince = 0;
    return waitForPage(() => {
      const current = findVisibleMapAction(framePattern, classSelector, textPattern);
      if (!current) {
        previous = null;
        stableSince = 0;
        return false;
      }
      if (current !== previous) {
        previous = current;
        stableSince = Date.now();
        return false;
      }
      return Date.now() - stableSince >= 1000 ? current : false;
    }, reason, 750);
  }

  async function runPdiSetOff() {
    if (isSetOffUi() || isArrivedUi()) return;
    await waitForCommandBarSettled(
      () => {
        if (isSetOffUi() || isArrivedUi()) return 'already-set-off';
        return findTopLevelAction(['Navigation Set Off', '出发', 'Set Off']);
      },
      '等待 PDI Set Off 功能键完全加载超过60秒',
    );
    if (isSetOffUi() || isArrivedUi()) return;
    await openPdiSetOffPreview();
    await waitForPdiTravelModes();
    await selectPdiTravelModes();
    await waitForStableMapAction(
      /NavigationPreview\.html/i,
      '.set-off',
      /^(Set Off|出发)$/i,
      '等待地图底部 Set Off 按钮超过60秒',
    );
    await completeMapAction({
      question: /Are you sure you want to set off|确认.*出发|确定.*出发/i,
      reasons: ['其他', 'Other'],
      actionName: '出发',
      // 出行方式没选对时先补选，不点 Set Off（否则只会提示选车辆）。
      retryControl: () => (ensurePdiTravelSelection()
        ? findVisibleMapAction(
          /NavigationPreview\.html/i,
          '.set-off',
          /^(Set Off|出发)$/i,
        )
        : null),
      reachedTarget: () => isSetOffUi() || isArrivedUi(),
    });
    await waitForPage(() => isSetOffUi() || isArrivedUi(), '等待出发状态更新超过60秒', 500);
  }

  async function openPdiArriveMap() {
    let lastClick = 0;
    await waitForPage(() => {
      closeExtraMapDialogs();
      const frame = visibleMapFrame(/\/Navigation\.html/i);
      if (frame) return frame;
      if (visibleDialogs().length) return false;

      const command = findTopLevelAction(['Navigation Arrived', '到达', 'Arrive', 'Arrived']);
      const disabled = !command
        || command.disabled
        || command.getAttribute('aria-disabled') === 'true';
      if (!disabled && (!lastClick || Date.now() - lastClick >= MAP_COMMAND_RETRY_MS)) {
        clickUiControl(command);
        lastClick = Date.now();
      }
      return false;
    }, '等待 Navigation Arrived 地图打开超过60秒', 500);
    return mapDocument(/\/Navigation\.html/i);
  }

  async function runPdiArrive() {
    if (isArrivedUi()) return;
    await waitForCommandBarSettled(
      () => {
        if (isArrivedUi()) return 'already-arrived';
        return findTopLevelAction(['Navigation Arrived', '到达', 'Arrive', 'Arrived']);
      },
      '等待 PDI Arrived 功能键完全加载超过60秒',
    );
    if (isArrivedUi()) return;
    await openPdiArriveMap();
    await waitForStableMapAction(
      /\/Navigation\.html/i,
      '.arrive-button',
      /^(Arrived|到达)$/i,
      '等待地图 Arrived 按钮超过60秒',
    );
    await completeMapAction({
      question: /Are you sure you have arrived|确认.*到达|确定.*到达/i,
      reasons: [
        '手机GPS信号不佳',
        'Poor mobile GPS signal',
        'Poor Mobile GPS Signal',
        'Weak mobile GPS signal',
        'Mobile GPS signal is poor',
      ],
      actionName: '到达',
      retryControl: () => findVisibleMapAction(
        /\/Navigation\.html/i,
        '.arrive-button',
        /^(Arrived|到达)$/i,
      ),
      reachedTarget: isArrivedUi,
    });
    await waitForPage(() => isArrivedUi(), '等待到达状态更新超过60秒', 500);
  }

  async function ensurePdiAccessoriesReady() {
    if (findAnyClickable(['附件', 'Attachments', 'Accessories'], { exact: true })) return;
    await clickCommand(['刷新', 'Refresh'], { exact: true });
    await waitForPage(
      () => findAnyClickable(['附件', 'Attachments', 'Accessories'], { exact: true }),
      '等待 Refresh 后 Accessories 标签出现超过60秒',
      500,
    );
  }

  async function runOrderCommand(kind) {
    const isDepart = kind === 'depart';
    const labels = isDepart
      ? ['出发', 'Depart', 'Set Off']
      : ['到达', 'Arrive', 'Arrived'];
    const reasons = isDepart
      ? ['其他', 'Other']
      : [
        '手机GPS信号不佳',
        'Poor mobile GPS signal',
        'Poor Mobile GPS Signal',
        'Weak mobile GPS signal',
        'Mobile GPS signal is poor',
      ];
    const actionQuestion = isDepart
      ? /Are you sure you want to set off|确认.*出发|确定.*出发/i
      : /Are you sure you have arrived|确认.*到达|确定.*到达/i;
    const reachedTarget = isDepart ? isSetOffUi : isArrivedUi;

    await clickCommand(labels, { exact: true });
    const handledReasons = new WeakSet();
    await waitForPage(async () => {
      if (reachedTarget()) return true;

      for (const dialog of visibleDialogs()) {
        const text = (dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim();

        // UAT 会在命令执行前后反复显示此已知配置错误；全局观察器通常会
        // 自动关闭，这里再兜底一次，避免弹窗阻断确认和页面跳转。
        if (/Could not find a property named ['"]mcs_whetherbuclaims['"]/i.test(text)) {
          clickDialogConfirm(dialog);
          continue;
        }

        if (actionQuestion.test(text)
          || /Leave this page|离开此页面|离开此页/i.test(text)) {
          clickDialogConfirm(dialog);
          continue;
        }

        const reason = findAnyClickable(reasons, { exact: true, root: dialog });
        if (reason && !handledReasons.has(dialog)) {
          handledReasons.add(dialog);
          reason.click();
          await sleep(300);
          clickDialogConfirm(dialog);
        }
      }
      return reachedTarget();
    }, `${isDepart ? '出发' : '到达'}命令执行超过60秒`);
  }

  async function waitForOrderInitialCommandState() {
    return waitForCommandBarSettled(() => {
      if (!currentRecordContextReady()) return false;
      if (isPdiApprovedUi()) return 'already-approved';
      if (findTopLevelAction(['接受', 'Accept'])) return 'accept-ready';
      if (isArrivedUi()) return 'already-arrived';
      if (isSetOffUi()) return 'already-set-off';
      return findTopLevelAction([
        'Navigation Set Off', '出发', 'Set Off',
        'Navigation Arrived', '到达', 'Arrived',
        '现场完工', 'Completion On Site',
        '提交审核', 'Submit for Approval',
        '刷新', 'Refresh',
      ]) ? 'form-ready' : false;
    }, '等待订单页面、审批状态及功能键完全加载超过60秒');
  }

  async function ensureArrived(orderKind, initialPdiState = null, dealerPdi = false) {
    if (orderKind === 'pdi') {
      const state = initialPdiState || await waitForOrderInitialCommandState();
      if (state === 'already-approved' || isPdiApprovedUi()) return 'already-approved';
      if (isArrivedUi()) return;
      await ensurePdiAccepted();
      // 经销商 PDI 页面没有出发/到达：接受后（或已是 Accepted）直接进入附件和现场完工。
      if (dealerPdi || isArrivedUi()) {
        if (!isArrivedUi()) {
          await waitForCommandBarSettled(
            () => (findTopLevelAction(['现场完工', 'Completion On Site']) ? true : false),
            '经销商 PDI：等待 Completion On Site 按键出现超过60秒',
          );
        }
        return;
      }
      await runPdiSetOff();
      await runPdiArrive();
      return 'processed';
    }
    await waitForPage(() => {
      const text = document.body.innerText || '';
      return text.includes('已到达')
        || text.includes('Arrived')
        || findClickable('出发', { exact: true })
        || findClickable('Depart', { exact: true })
        || findClickable('Set Off', { exact: true })
        || findClickable('到达', { exact: true })
        || findClickable('Arrive', { exact: true });
    }, '等待订单页面和出发/到达命令超过60秒');
    if (isArrivedUi()) return;
    const depart = findAnyClickable(['出发', 'Depart', 'Set Off'], { exact: true });
    if (depart) {
      await runOrderCommand('depart');
    }
    if (isArrivedUi()) return;
    await runOrderCommand('arrive');
  }

  function documentsIn(root = document) {
    const docs = [root];
    for (const iframe of root.querySelectorAll('iframe')) {
      try {
        if (iframe.contentDocument) docs.push(...documentsIn(iframe.contentDocument));
      } catch { /* cross-origin iframe */ }
    }
    return docs;
  }

  function documentSurfaceVisible(doc) {
    try {
      const frame = doc.defaultView?.frameElement;
      return !frame || visible(frame);
    } catch {
      return false;
    }
  }

  function transferDocuments() {
    return documentsIn().filter((doc) => {
      if (!documentSurfaceVisible(doc)) return false;
      try {
        // 必须是服务转移 Web Resource 自己的 document。不能用父页面中的
        // “服务转移”文字判断，否则会把 D365 顶部全局搜索框当成姓名框。
        return /agentservicetransfer\.html/i.test(doc.location.href);
      } catch {
        return false;
      }
    });
  }

  function transferDocument() {
    const matches = transferDocuments();
    // D365 可能把旧的服务转移 iframe 留在 DOM 中但隐藏起来。优先选择
    // 当前真正包含可见输入框/操作按钮的页面，避免一直等待隐藏旧页面。
    return matches.find((doc) => transferEditables(doc).length > 0)
      || matches.find((doc) => Boolean(
        findAnyClickable(['永久转派', 'Permanent transfer'], { exact: true, root: doc }),
      ))
      || matches[0]
      || null;
  }

  function setInputValue(input, value) {
    const view = input.ownerDocument?.defaultView || window;
    const isTextArea = input.tagName === 'TEXTAREA';
    const Control = isTextArea ? view.HTMLTextAreaElement : view.HTMLInputElement;
    const isNativeControl = input.tagName === 'INPUT' || isTextArea;
    const setter = isNativeControl
      ? Object.getOwnPropertyDescriptor(Control.prototype, 'value')?.set
      : null;
    if (setter) setter.call(input, value);
    else if (isNativeControl) input.value = value;
    else input.textContent = value;
    input.dispatchEvent(new view.Event('input', { bubbles: true }));
    input.dispatchEvent(new view.Event('change', { bubbles: true }));
  }

  function editableValue(input) {
    return String('value' in input ? input.value : input.textContent || '').trim();
  }

  async function enterTransferName(input, value) {
    input.scrollIntoView?.({ block: 'center', inline: 'center' });
    input.focus?.({ preventScroll: true });
    input.select?.();
    setInputValue(input, '');
    setInputValue(input, value);
    await waitFor(() => editableValue(input) === value, 5000, 100);
    // 再留一个短周期给受控组件回写；如果框被组件清空，不得误报已输入。
    await sleep(300);
    if (editableValue(input) !== value) {
      throw new Error(`姓名输入框未保留“${value}”，已停止搜索`);
    }
  }

  function transferEditables(doc) {
    const selector = 'input,textarea,[contenteditable="true"],[role="textbox"]';
    const controls = documentsIn(doc)
      .filter(documentSurfaceVisible)
      .flatMap((current) => [...current.querySelectorAll(selector)]);
    return controls.filter((input) => {
      if (!visible(input)) return false;
      const type = (input.getAttribute('type') || 'text').toLocaleLowerCase();
      return !['radio', 'checkbox', 'button', 'submit', 'hidden', 'file'].includes(type);
    }).sort((a, b) => {
      const placeholderA = /搜索关键字|search the keywords/i.test(a.getAttribute('placeholder') || '') ? 0 : 1;
      const placeholderB = /搜索关键字|search the keywords/i.test(b.getAttribute('placeholder') || '') ? 0 : 1;
      if (placeholderA !== placeholderB) return placeholderA - placeholderB;
      const nativeA = ['INPUT', 'TEXTAREA'].includes(a.tagName) ? 0 : 1;
      const nativeB = ['INPUT', 'TEXTAREA'].includes(b.tagName) ? 0 : 1;
      return nativeA - nativeB;
    });
  }

  function transferRows(doc) {
    return [...doc.querySelectorAll('tr,[role="row"]')].map((row) => {
      const radio = row.querySelector('input[type="radio"],[role="radio"]');
      const text = (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim();
      return { row, radio, text };
    }).filter((entry) => entry.radio && entry.text);
  }

  function transferResultBody(doc) {
    return doc.getElementById('tb_content')
      || doc.querySelector('tbody.grid,table tbody,[role="rowgroup"]');
  }

  async function waitForTransferPageReady(doc) {
    let previous = null;
    let stableSince = 0;
    await waitForPage(() => {
      if (doc.readyState !== 'complete') return false;
      const body = transferResultBody(doc);
      if (!body) return false;
      const current = body.innerHTML;
      if (current !== previous) {
        previous = current;
        stableSince = Date.now();
        return false;
      }
      return Date.now() - stableSince >= 1000;
    }, '等待服务转移页面初始化超过60秒', 200);
  }

  function clickUiControl(control) {
    const view = control.ownerDocument?.defaultView || window;
    control.scrollIntoView?.({ block: 'center', inline: 'center' });
    control.focus?.({ preventScroll: true });
    // 旧版 Web Resource 可能把逻辑绑定在鼠标按下/抬起事件，而不只监听 click。
    for (const type of ['mousedown', 'mouseup']) {
      control.dispatchEvent(new view.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view,
        button: 0,
        buttons: type === 'mousedown' ? 1 : 0,
      }));
    }
    control.click();
  }

  function rowsReflectSearch(rows, target) {
    if (!rows.length) return true;
    const wanted = target.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    return rows.every(({ text }) => text.replace(/\s+/g, ' ').trim().toLocaleLowerCase().includes(wanted));
  }

  function transferBusy() {
    return documentsIn().some((doc) => {
      if (!doc.body) return false;
      const showText = doc.defaultView?.NodeFilter?.SHOW_TEXT || 4;
      const walker = doc.createTreeWalker(doc.body, showText);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (/系统处理中|Processing/i.test(node.nodeValue || '') && visible(node.parentElement)) return true;
      }
      return false;
    });
  }

  async function serviceTransfer(run, item, panel) {
    const target = String(run.transferTarget || '').trim();
    if (!target) throw new Error('未填写“转移给”');

    // 永久转派提交前先存盘。若此刻刷新或中断，恢复时暂停人工核对，
    // 绝不自动再次点击，避免同一工单被重复转派。
    if (item.stage === 'transfer-submitting') {
      throw new Error('上次永久转派提交后的结果未能自动确认；为避免重复转派，请人工核对后再清除任务');
    }

    let lastCommandClick = 0;
    const doc = await waitForPage(() => {
      const opened = transferDocument();
      if (opened) return opened;

      // 服务转移弹窗正在打开或加载时不重复点击，避免叠出多个转移窗口。
      const now = Date.now();
      if (!visibleDialogs().length
        && (!lastCommandClick || now - lastCommandClick >= MAP_COMMAND_RETRY_MS)) {
        const command = findAnyClickable(['服务转移', 'Service transfer'], { exact: true });
        if (command && !command.disabled && command.getAttribute('aria-disabled') !== 'true') {
          command.scrollIntoView?.({ block: 'center', inline: 'center' });
          command.focus?.({ preventScroll: true });
          command.click();
          lastCommandClick = now;
        }
      }
      return null;
    }, '等待“服务转移”页面打开超过60秒');
    panel?.log(`${item.machineNo}：服务转移页面已打开，等待姓名输入框…`);
    const nameInput = await waitForPage(() => {
      const docs = transferDocuments();
      return docs.map((current) => current.getElementById('filterName')).find((input) => visible(input))
        || docs.flatMap((current) => transferEditables(current)).find(Boolean)
        || null;
    }, '等待服务转移姓名输入框加载超过60秒');
    const controlsDoc = nameInput.ownerDocument || doc;
    const search = await waitForPage(() => {
      const exactButton = controlsDoc.getElementById('searchBtn');
      if (visible(exactButton)) return exactButton;
      const roots = documentsIn(controlsDoc);
      return roots.map((root) => findAnyClickable(['搜索', 'Search'], { exact: true, root })).find(Boolean) || null;
    }, '等待服务转移搜索按钮加载超过60秒');

    // 输入框和按钮会先出现，默认人员列表及其事件处理器稍后才初始化。
    // 等结果区域稳定后再输入并点击，避免 click 发生在监听器绑定之前。
    await waitForTransferPageReady(controlsDoc);
    await enterTransferName(nameInput, target);

    const searchStartedAt = Date.now();
    let searchContentChanged = false;
    let lastSearchMutation = 0;
    let sawSearchBusy = false;
    let lastSearchClick = 0;
    let clickCount = 0;
    const ResultObserver = controlsDoc.defaultView?.MutationObserver || MutationObserver;
    const resultObserver = new ResultObserver(() => {
      searchContentChanged = true;
      lastSearchMutation = Date.now();
    });
    resultObserver.observe(controlsDoc.body, { childList: true, subtree: true, attributes: true });

    const clickSearch = () => {
      searchContentChanged = false;
      sawSearchBusy = false;
      lastSearchMutation = Date.now();
      lastSearchClick = Date.now();
      clickCount += 1;
      clickUiControl(search);
      panel?.log(clickCount === 1
        ? `${item.machineNo}：已输入“${target}”并点击“搜索”，等待结果…`
        : `${item.machineNo}：搜索未返回有效结果，正在第 ${clickCount} 次点击“搜索”…`);
    };
    clickSearch();

    try {
      await waitForPage(
        () => {
          if (transferBusy()) {
            sawSearchBusy = true;
            return false;
          }
          const rows = transferRows(controlsDoc);
          const responseObserved = sawSearchBusy || searchContentChanged;
          const settled = Date.now() - lastSearchMutation >= 400;
          if (responseObserved && settled && rowsReflectSearch(rows, target)) return true;

          // 页面初始化尚未完成时，第一次 DOM click 可能没有任何效果。
          // 搜索是只读操作，可以安全重试；一分钟仍无有效响应则沿用全局刷新恢复。
          if (Date.now() - lastSearchClick >= 3000) clickSearch();
          return false;
        },
        '等待服务转移人员搜索超过60秒',
        250,
      );
    } finally {
      resultObserver.disconnect();
    }
    const matches = transferRows(controlsDoc);
    panel?.log(`${item.machineNo}：人员搜索返回 ${matches.length} 条`);
    if (matches.length !== 1) {
      throw new Error(matches.length
        ? `“${target}”返回 ${matches.length} 位人员，请输入能唯一匹配的姓名或工号`
        : `未找到转移人员“${target}”，请检查拼写后重试`);
    }

    matches[0].radio.click();
    item.transferResolved = matches[0].text;
    item.stage = 'transfer-submitting';
    saveState(run);

    const permanent = controlsDoc.getElementById('btn_permanenttransfer')
      || findAnyClickable(['永久转派', 'Permanent transfer'], { exact: true, root: controlsDoc });
    if (!permanent) throw new Error('未找到“永久转派”按钮');
    const successSequenceAtSubmit = operationSuccessSequence;
    clickUiControl(permanent);

    await waitForPage(() => (
      operationSuccessSequence > successSequenceAtSubmit
      || /操作成功|转派成功|转移成功|transfer(?:red)? successfully/i.test(
        document.body?.innerText || '',
      )
    ), '等待永久转派成功提示超过60秒');
    const successDialog = visibleDialogs().find((dialog) => /操作成功|转派成功|转移成功|success/i.test(
      dialog.innerText || dialog.textContent || '',
    ));
    if (successDialog) clickDialogConfirm(successDialog);
  }

  let currentUserIdCache = null;
  async function currentUserId() {
    if (!currentUserIdCache) {
      const { data } = await api('WhoAmI');
      currentUserIdCache = normalizeGuid(data.UserId);
    }
    return currentUserIdCache;
  }

  // 服务转移前先用 API 判断：已有的到港预验收订单如果负责人（Owner）已经不是当前账号，
  // 说明之前已经转移过（或别人在处理），不用打开页面等“服务转移”按键。
  async function transferPrecheck(item) {
    const { data } = await api(
      `mcs_consultationorders(${normalizeGuid(item.orderId)})?$select=mcs_name,mcs_status,_ownerid_value,_mcs_engineer_value`,
      { headers: { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' } },
    );
    item.orderNumber ||= data.mcs_name || '';
    const me = await currentUserId();
    const ownerId = normalizeGuid(data._ownerid_value);
    return {
      ownedByMe: !ownerId || ownerId === me,
      ownerName: formattedValue(data, '_ownerid_value') || '未知',
      status: formattedValue(data, 'mcs_status') || '',
    };
  }

  async function transferOrderCommandState() {
    return waitForCommandBarSettled(() => {
      const handover = findTopLevelAction([
        '交机',
        'Handover',
        'Equipment Handover',
        'Machine Handover',
      ]);
      const receive = findTopLevelAction(['接收', 'Receive']);
      const transfer = findTopLevelAction(['服务转移', 'Service transfer']);
      if (handover) return 'already-handed-over';
      if (receive) return 'already-received';
      if (transfer) return 'transfer-ready';
      // 页面和命令栏已加载（有刷新/保存），但一直没有服务转移按键：交给调用方跳过，不再无限等待。
      if (currentRecordContextReady() && findTopLevelAction(['刷新', 'Refresh', '保存', 'Save'])) return 'no-transfer';
      return false;
    }, '等待网页功能及服务转移/交机/接收命令完全加载超过60秒');
  }

  async function rootHandleForRun(run, requireWrite = false) {
    const handle = await loadHandle(run.handleKey);
    if (!handle) throw new Error('找不到已授权文件夹，请重新选择文件夹');
    const mode = requireWrite ? 'readwrite' : 'read';
    const permission = await handle.queryPermission({ mode });
    if (permission !== 'granted') throw new Error('文件夹读取权限已失效，请在脚本面板点击“重新授权并继续”');
    return handle;
  }

  async function fileForItem(run, item, fileName) {
    if (run.handoverFromPdi) {
      const rule = photoRulesForRun(run, item).find((x) => x.name === fileName);
      const file = await pdiPhotoFile(item, rule);
      saveState(run); // 记住“其他照片”选用的是哪一张
      return file;
    }
    const root = await rootHandleForRun(run);
    // 0.7.21 之前的任务进度没有 dirName，此时文件夹名即机号。
    const dir = await itemDir(root, item);
    // 每次按当前规则实时查找，不依赖选择文件夹时保存的文件名（那时的规则可能还不支持 jpeg 等格式）。
    const fileNames = await photoNamesIn(dir);
    const actualName = fileNames[fileName];
    if (!actualName) {
      const rule = ALL_PHOTO_NAMES.find((x) => x.name === fileName);
      throw new Error(`文件夹“${item.dirName || item.machineNo}”中找不到 ${rule ? rule.aliases.join('/') : fileName}`);
    }
    item.fileNames = fileNames;
    item.files = Object.keys(fileNames);
    const handle = await dir.getFileHandle(actualName);
    return handle.getFile();
  }

  async function uploaderDocument() {
    const iframe = await waitForPage(
      () => [...document.querySelectorAll('iframe')].find((x) => x.src.includes('/Uploader.html')),
      '等待附件上传器出现超过60秒',
    );
    return waitForPage(() => {
      try {
        return iframe.contentDocument?.querySelector('input[placeholder="Select file type"]') ? iframe.contentDocument : null;
      } catch {
        return null;
      }
    }, '等待附件上传器初始化超过60秒');
  }

  async function openAttachmentTab() {
    const tab = await waitForPage(
      () => findAnyClickable(['附件', 'Attachments', 'Accessories'], { exact: true }),
      '等待附件标签出现超过60秒',
    );
    clickUiControl(tab);
    return uploaderDocument();
  }

  async function chooseUploaderType(doc, rule) {
    const input = doc.querySelector('input[placeholder="Select file type"]');
    if (!input) throw new Error('附件上传器缺少文件类型选择器');
    const trigger = input.closest('.el-select')?.querySelector('.select-trigger') || input;
    clickUiControl(trigger);
    const option = await waitFor(() => {
      const options = [...doc.querySelectorAll(
        '[role="option"],.ant-select-item-option,.el-select-dropdown__item',
      )];
      return options.find((current) => rule.typeLabels.some((label) => elementText(current) === label));
    }, 5000, 100);
    clickUiControl(option);
    await waitFor(
      () => rule.typeLabels.some((label) => editableValue(input) === label),
      5000,
      100,
    );
  }

  function englishTypeLabel(rule) {
    if (rule.fileLabel) return rule.fileLabel;
    return rule.typeLabels.find((label) => /^[\x00-\x7F]+$/.test(label))
      || rule.typeLabels[rule.typeLabels.length - 1];
  }

  // 附件表格每行有两个输入框：文件类型（下拉框）和文件名称。文件类型下拉框的提示文字跟随
  // 账号语言变化（英文 "Please select the file type"，中文是“请选择文件类型”之类），
  // 所以不能只靠英文提示文字找它：优先认下拉框结构（.el-select），再按中英文提示兜底。
  function attachmentRowInputs(row) {
    const inputs = [...row.querySelectorAll('input[type="text"],input:not([type])')];
    const typeInput = inputs.find((input) => input.closest('.el-select'))
      || inputs.find((input) => /select the file type|file type|文件类型|请选择/i.test(input.placeholder || ''));
    const nameInput = inputs.find((input) => input !== typeInput && !input.readOnly && !input.closest('.el-select'));
    return { typeInput, nameInput };
  }

  function attachmentRow(doc, rule, acceptedNames) {
    return [...doc.querySelectorAll('tr.el-table__row,tr')].find((row) => {
      const { typeInput, nameInput } = attachmentRowInputs(row);
      return typeInput && nameInput
        && rule.typeLabels.some((label) => editableValue(typeInput) === label)
        && acceptedNames.includes(editableValue(nameInput));
    }) || null;
  }

  function uploadedAttachmentRow(doc, rule, file) {
    const baseName = file.name.replace(/\.[^.]+$/, '');
    return attachmentRow(doc, rule, [baseName, englishTypeLabel(rule)]);
  }

  async function renameAttachmentRow(doc, row, rule) {
    const target = englishTypeLabel(rule);
    const { nameInput } = attachmentRowInputs(row);
    if (!nameInput) throw new Error(`附件“${target}”缺少 File Name 输入框`);
    if (editableValue(nameInput) === target) return;
    const view = doc.defaultView || window;
    const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')?.set;
    nameInput.focus();
    if (setter) setter.call(nameInput, target);
    else nameInput.value = target;
    nameInput.dispatchEvent(new view.Event('input', { bubbles: true }));
    nameInput.dispatchEvent(new view.Event('change', { bubbles: true }));
    nameInput.dispatchEvent(new view.KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
    }));
    nameInput.blur();
    await waitFor(() => editableValue(nameInput) === target, 5000, 100);
  }

  async function uploadOne(doc, rule, file) {
    let row = uploadedAttachmentRow(doc, rule, file);
    const existed = Boolean(row);
    if (!row) {
      await chooseUploaderType(doc, rule);
      let fileInput = doc.querySelector('input[type="file"]');
      if (!fileInput) {
        const uploadButton = [...doc.querySelectorAll('button')].find((x) => !elementText(x) && visible(x));
        if (uploadButton) clickUiControl(uploadButton);
        fileInput = await waitFor(() => doc.querySelector('input[type="file"]'), 5000);
      }
      const Transfer = doc.defaultView?.DataTransfer || DataTransfer;
      const transfer = new Transfer();
      transfer.items.add(file);
      fileInput.files = transfer.files;
      fileInput.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
      row = await waitFor(() => uploadedAttachmentRow(doc, rule, file), 60000, 300);
    }
    await renameAttachmentRow(doc, row, rule);
    return existed ? 'skipped' : 'uploaded';
  }

  async function uploadAttachments(run, item) {
    const doc = await openAttachmentTab();
    for (const rule of photoRulesForRun(run, item)) {
      const hadFallback = Boolean(item.otherPhotoSourceId);
      const file = await fileForItem(run, item, rule.name);
      if (!hadFallback && item.otherPhotoSourceId) {
        panelLog?.(`${item.machineNo}：PDI 里没有“其他照片”，随机选用 PDI 的“${item.otherPhotoSourceName}”作为 Other photos（不与铭牌/远照/工时照重复）`);
      }
      await uploadOne(doc, rule, file);
      item.uploaded = [...new Set([...(item.uploaded || []), rule.name])];
      saveState(run);
    }
  }

  async function setPdiCheckPassed() {
    const tab = await waitForPage(
      () => findAnyClickable(['现场处理', 'On-Site Processing'], { exact: true }),
      '等待 On-Site Processing 标签出现超过60秒',
    );
    clickUiControl(tab);

    const toggle = await waitForPage(() => {
      const exact = document.querySelector(
        '[data-id="mcs_acceptancepassed.fieldControl-toggle-container"] input[role="switch"]',
      );
      if (visible(exact)) return exact;
      return [...document.querySelectorAll('input[role="switch"]')].find((input) => (
        visible(input) && /^Check Passed:/i.test(input.getAttribute('aria-label') || '')
      )) || null;
    }, '等待 Check Passed 开关出现超过60秒');

    const isChecked = () => toggle.checked
      || /Check Passed:\s*Yes|检查通过[:：]?\s*是/i.test(toggle.getAttribute('aria-label') || '');
    if (!isChecked()) {
      toggle.scrollIntoView?.({ block: 'center', inline: 'center' });
      clickUiControl(toggle);
      await waitForPage(() => isChecked(), '等待 Check Passed 切换为 Yes 超过60秒', 250);
    }

    if (/Unsaved|未保存/i.test(document.body.innerText || '')) {
      const save = await waitForPage(
        () => findClickable('Save (CTRL+S)', { exact: false })
          || findClickable('保存', { exact: true }),
        '等待 Save 命令出现超过60秒',
      );
      clickUiControl(save);
      await waitForPage(() => (
        isChecked() && !/Unsaved|未保存/i.test(document.body.innerText || '')
      ), '等待 Check Passed 保存超过60秒', 300);
    }
  }

  async function waitForPagePromise(promise, reason) {
    let settled = false;
    let value;
    let error;
    Promise.resolve(promise).then(
      (result) => {
        value = result;
        settled = true;
      },
      (caught) => {
        error = caught;
        settled = true;
      },
    );
    await waitForPage(() => settled, reason, 300);
    if (error) throw error;
    return value;
  }

  async function saveCurrentFormIfNeeded(force = false) {
    if (!force && !/Unsaved|未保存/i.test(document.body.innerText || '')) return;
    const save = await waitForPage(
      () => findClickable('Save (CTRL+S)', { exact: false })
        || findClickable('保存', { exact: true }),
      '等待 Save 命令出现超过60秒',
    );
    clickUiControl(save);
    await waitForPage(
      () => !/Unsaved|未保存/i.test(document.body.innerText || '')
        && !globalThis.Xrm?.Page?.data?.entity?.getIsDirty?.(),
      '等待表单保存超过60秒',
      300,
    );
  }

  function equipmentLocationAttribute() {
    try {
      const attributes = globalThis.Xrm?.Page?.data?.entity?.attributes?.get?.() || [];
      return attributes.find((attribute) => {
        const name = String(attribute.getName?.() || '');
        const controls = attribute.controls?.get?.() || [];
        const labels = controls.map((control) => String(control.getLabel?.() || ''));
        return /(^|_)equipmentlocation$/i.test(name)
          || labels.some((label) => /^Equipment Location$/i.test(label.trim()));
      }) || null;
    } catch {
      return null;
    }
  }

  function equipmentLocationInput() {
    const direct = [...document.querySelectorAll(
      '[data-id*="equipmentlocation" i] input, [data-id*="equipmentlocation" i] textarea, input[aria-label="Equipment Location" i], textarea[aria-label="Equipment Location" i]',
    )].find((control) => visible(control) && !control.disabled && !control.readOnly);
    if (direct) return direct;

    const labels = [...document.querySelectorAll('label,span,div')].filter((element) => (
      visible(element) && /^Equipment Location$/i.test(elementText(element))
    ));
    for (const label of labels) {
      let container = label.parentElement;
      for (let depth = 0; container && depth < 5; depth += 1, container = container.parentElement) {
        const input = [...container.querySelectorAll('input,textarea,[role="textbox"]')]
          .find((control) => visible(control) && !control.disabled && !control.readOnly);
        if (input) return input;
      }
    }
    return null;
  }

  async function ensureEquipmentLocationUk() {
    const generalTab = await waitForPage(
      () => findAnyClickable(['常规', 'General'], { exact: true }),
      '等待 General 标签出现超过60秒',
    );
    clickUiControl(generalTab);

    const target = await waitForPage(() => {
      const attribute = equipmentLocationAttribute();
      if (attribute) return { attribute };
      const input = equipmentLocationInput();
      return input ? { input } : null;
    }, '等待 Equipment Location 输入框出现超过60秒');

    let changed = false;
    if (target.attribute) {
      if (!(await persistedHasData(target.attribute))) {
        target.attribute.setValue('uk');
        target.attribute.fireOnChange?.();
        target.attribute.setSubmitMode?.('always');
        changed = true;
      }
    } else {
      if (!editableValue(target.input)) {
        target.input.scrollIntoView?.({ block: 'center', inline: 'center' });
        target.input.focus?.({ preventScroll: true });
        setInputValue(target.input, 'uk');
        target.input.blur?.();
        changed = true;
      }
    }

    if (!changed) return false;
    await waitForPage(() => {
      const attribute = equipmentLocationAttribute();
      if (String(attribute?.getValue?.() || '').trim().toLocaleLowerCase() === 'uk') return true;
      const input = equipmentLocationInput();
      return String(editableValue(input || {})).toLocaleLowerCase() === 'uk';
    }, '等待 Equipment Location 写入 uk 超过60秒', 250);
    await saveCurrentFormIfNeeded(true);
    return true;
  }

  async function ensureItemEquipmentLocation(run, item, panel) {
    const orderId = normalizeGuid(item.orderId);
    if (item.equipmentLocationCheckedOrderId === orderId) return;
    panel?.log(`${item.machineNo}：检查 Equipment Location…`);
    const changed = await ensureEquipmentLocationUk();
    item.equipmentLocationCheckedOrderId = orderId;
    if (changed) item.equipmentLocationAutoFilled = true;
    saveState(run);
    panel?.log(changed
      ? `${item.machineNo}：Equipment Location 为空，已填写 uk 并保存`
      : `${item.machineNo}：Equipment Location 已有内容，保持不变`);
  }

  function equipmentLocationRequiredVisible() {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    return /Equipment Location\s*:\s*Required fields must be filled in/i.test(text)
      || /Required fields must be filled in[\s\S]{0,120}Equipment Location/i.test(text);
  }

  const PDI_GENERAL_FIELDS = {
    usageStatus: ['Equipment Usage Status', '设备使用状态'],
    model: ['Model', '机型', '型号'],
    tonnage: ['Tonnage', '吨位'],
  };
  const USABLE_LABELS = ['Usable', '可用'];
  // 防锈额外检查保修期（月），为空时填写 60。
  const WARRANTY_MONTH_LABELS = [
    'Warranty Policy (Month)', 'Warranty Policy(Month)', '保修政策（月）', '保修政策(月)', '保修期（月）', '保修期(月)',
  ];
  const RUST_WARRANTY_MONTHS = '60';

  // 按表单控件标签精确查找属性。字段可能是文本、选项集、数值或 Lookup，
  // 统一通过 Xrm 属性 API 读写，不依赖具体的输入框 DOM。
  // 控件对应的 DOM 是否真的显示在当前页签中。
  function controlOnScreen(control) {
    try {
      const name = String(control.getName?.() || '');
      if (!name) return false;
      const escaped = CSS.escape(name);
      return [...document.querySelectorAll(`[data-id="${escaped}"],[data-id^="${escaped}."]`)].some(visible);
    } catch {
      return false;
    }
  }

  // 同一标签可能对应多个属性（隐藏字段、页头、其他页签），优先选择
  // 当前屏幕上可见且可编辑的那一个，避免读到别的字段的值而误判“已有数据”。
  function formAttributeByLabel(labels) {
    if (!currentRecordContextReady()) return null;
    const wanted = labels.map((label) => label.trim().toLocaleLowerCase());
    try {
      const attributes = globalThis.Xrm?.Page?.data?.entity?.attributes?.get?.() || [];
      const scored = attributes.map((attribute) => {
        const controls = (attribute.controls?.get?.() || []).filter((control) => (
          wanted.includes(String(control.getLabel?.() || '').trim().toLocaleLowerCase())
        ));
        if (!controls.length) return null;
        const onScreen = controls.some(controlOnScreen);
        const shown = controls.some((control) => control.getVisible?.() !== false);
        const enabled = controls.some((control) => !control.getDisabled?.());
        return { attribute, score: (onScreen ? 0 : 4) + (shown ? 0 : 2) + (enabled ? 0 : 1) };
      }).filter(Boolean);
      return scored.sort((a, b) => a.score - b.score)[0]?.attribute || null;
    } catch {
      return null;
    }
  }

  function attributeLabel(attribute) {
    try {
      return attribute.controls?.get?.()?.[0]?.getLabel?.() || attribute.getName?.() || '';
    } catch {
      return '';
    }
  }

  function attributeDisplayValue(attribute) {
    const type = attribute.getAttributeType?.();
    const value = attribute.getValue?.();
    if (type === 'lookup') return value?.[0]?.name || '';
    if (type === 'optionset') return attribute.getText?.() || '';
    return value == null ? '' : String(value);
  }

  const normalizeFieldText = (value) => String(value || '').toLocaleLowerCase().replace(/[\s_-]/g, '');
  const leadingNumber = (value) => {
    const match = String(value || '').replace(/,/g, '.').match(/\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : NaN;
  };

  // 吨位允许“21T”与“21”“21 t”等写法按数值匹配；机型只做忽略空格/大小写的精确匹配，
  // 避免 SY21 误匹配到 SY215C。
  function fieldValueMatches(actual, target, numeric) {
    if (normalizeFieldText(actual) === normalizeFieldText(target)) return true;
    if (!numeric) return false;
    const a = leadingNumber(actual);
    const b = leadingNumber(target);
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }

  async function lookupReferenceByName(attribute, name) {
    const control = attribute.controls?.get?.()?.[0];
    const entityTypes = control?.getEntityTypes?.() || [];
    if (!entityTypes.length) throw new Error(`无法识别“${attributeLabel(attribute)}”的 Lookup 目标实体`);
    for (const logicalName of entityTypes) {
      const entity = await metadata.entity(logicalName);
      const filter = `${entity.PrimaryNameAttribute} eq '${escapeODataString(name)}'`;
      const { data } = await api(
        `${entity.EntitySetName}?$select=${entity.PrimaryIdAttribute},${entity.PrimaryNameAttribute}&$filter=${encodeURIComponent(filter)}&$top=2`,
      );
      if ((data.value || []).length > 1) {
        throw new Error(`“${attributeLabel(attribute)}”中存在多个名为“${name}”的记录`);
      }
      const record = data.value?.[0];
      if (record) {
        return [{
          id: normalizeGuid(record[entity.PrimaryIdAttribute]),
          name: record[entity.PrimaryNameAttribute],
          entityType: logicalName,
        }];
      }
    }
    throw new Error(`“${attributeLabel(attribute)}”中找不到“${name}”`);
  }

  // D365 的 AI 表单填写助手会在空字段上显示建议值（例如质保时间），这些值没有保存到服务器，
  // 不能当作“已有数据”。判断字段是否有数据时以服务器上已保存的值为准；读取失败才退回表单值。
  async function persistedHasData(attribute) {
    try {
      const orderId = normalizeGuid(globalThis.Xrm?.Page?.data?.entity?.getId?.());
      const name = String(attribute.getName?.() || '');
      if (!orderId || !name) throw new Error('缺少订单或字段信息');
      const column = attribute.getAttributeType?.() === 'lookup' ? `_${name}_value` : name;
      const entity = await metadata.entity(ORDER_ENTITY);
      const { data } = await api(`${entity.EntitySetName}(${orderId})?$select=${column}`);
      const value = data?.[column];
      return value !== null && value !== undefined && String(value).trim() !== '';
    } catch (error) {
      if (error instanceof RunPausedError) throw error;
      return Boolean(attributeDisplayValue(attribute).trim());
    }
  }

  // 返回 true 表示字段被修改；值已一致时不做任何改动。
  // force：服务器上该字段为空时使用，即使表单显示的（AI 建议）值与目标相同也写入。
  async function setFormAttribute(attribute, target, { numeric = false, force = false } = {}) {
    const label = attributeLabel(attribute);
    if (!force && fieldValueMatches(attributeDisplayValue(attribute), target, numeric)) return false;
    const type = attribute.getAttributeType?.();
    let value;
    if (type === 'optionset') {
      const options = attribute.getOptions?.() || [];
      const option = options.find((x) => normalizeFieldText(x.text) === normalizeFieldText(target))
        || (numeric ? options.find((x) => fieldValueMatches(x.text, target, true)) : null);
      if (!option) {
        throw new Error(`“${label}”没有选项“${target}”（可选：${options.map((x) => x.text).filter(Boolean).join('、')}）`);
      }
      value = option.value;
    } else if (type === 'lookup') {
      value = await lookupReferenceByName(attribute, target);
    } else if (['integer', 'decimal', 'double', 'money'].includes(type)) {
      value = leadingNumber(target);
      if (!Number.isFinite(value)) throw new Error(`“${label}”是数值字段，无法从“${target}”解析出数字`);
    } else {
      value = String(target);
    }
    attribute.setValue(value);
    attribute.fireOnChange?.();
    attribute.setSubmitMode?.('always');
    return true;
  }

  // 每次都实际检查：已有数据的字段不覆盖，只写入空字段，因此可安全重复执行。
  async function fillGeneralInfo(run, item, panel) {
    const generalTab = await waitForPage(
      () => findAnyClickable(['常规', 'General'], { exact: true }),
      '等待 General 标签出现超过60秒',
    );
    clickUiControl(generalTab);

    const specs = [
      { labels: PDI_GENERAL_FIELDS.usageStatus, targets: USABLE_LABELS },
      { labels: PDI_GENERAL_FIELDS.model, targets: [item.equipmentModel] },
      { labels: PDI_GENERAL_FIELDS.tonnage, targets: [item.tonnage], numeric: true },
      ...(run.orderKind === 'rust'
        ? [{ labels: WARRANTY_MONTH_LABELS, targets: [RUST_WARRANTY_MONTHS], numeric: true }]
        : []),
    ];
    const fieldNames = specs.map((spec) => spec.labels[0]).join(' / ');
    const attributes = await waitForPage(() => {
      const found = specs.map((spec) => formAttributeByLabel(spec.labels));
      return found.every(Boolean) ? found : null;
    }, `等待 General 中 ${fieldNames} 字段超过60秒`);

    const plan = specs.map((spec, index) => ({
      attribute: attributes[index],
      labels: spec.targets,
      numeric: spec.numeric,
    }));
    // D365 显示格式可能与文件夹名不同（如 1.9t 显示为 1.90），
    // 因此只要求字段有数据：已有数据的字段不覆盖，写入后也只检查是否非空。
    const hasData = (attribute) => Boolean(attributeDisplayValue(attribute).trim());
    const changes = [];
    for (const { attribute, labels, numeric } of plan) {
      if (await persistedHasData(attribute)) continue;
      if (!labels.every(Boolean)) {
        throw new Error(`“${attributeLabel(attribute)}”为空，但文件夹“${item.dirName || item.machineNo}”缺少机型或吨位，请按“机台号_机型_吨位_工作时间”命名`);
      }
      let lastError = null;
      let changed = null;
      // Usable 兼容中英文选项；其他字段只有一个目标值。
      for (const target of labels) {
        try {
          changed = await setFormAttribute(attribute, target, { numeric, force: true });
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (changed === null) throw lastError;
      if (changed) changes.push(`${attributeLabel(attribute)} = ${attributeDisplayValue(attribute)}`);
    }

    const allFilled = () => plan.every(({ attribute }) => hasData(attribute));
    const summary = () => plan
      .map(({ attribute }) => `${attributeLabel(attribute)}=${attributeDisplayValue(attribute) || '空'}`)
      .join('，');
    if (changes.length) {
      await waitForPage(allFilled, `等待 ${fieldNames} 写入超过60秒`, 250);
      const blocked = await saveFormChangesLenient({ force: true });
      if (blocked) await fillOperatingHours(run, item, panel, { minHours: blocked.cumulativeHours });
      if (!allFilled()) throw new Error(`保存后 ${fieldNames} 仍有空值：${summary()}`);
    }
    panel?.log(changes.length
      ? `${item.machineNo}：已填写并保存 ${changes.join('；')}`
      : `${item.machineNo}：${fieldNames} 已有数据（${summary()}），继续下一步`);
  }

  // D365 业务校验：Current Running Time + Running Time Before Program Replacement
  // 必须 >= 设备累计运行时间。返回弹窗及其中的累计小时数，未出现时返回 null。
  // 从弹窗或 API 错误信息中读取“Cumulative Running Time (X hours)”中的 X，读不到返回 NaN。
  function parseCumulativeHours(text) {
    const match = String(text || '').match(/Cumulative Running Time\s*[(（]\s*(\d+(?:\.\d+)?)\s*hours?\s*[)）]/i)
      || String(text || '').match(/累计运行时间\s*[(（]\s*(\d+(?:\.\d+)?)\s*小时?\s*[)）]/);
    return match ? Number(match[1]) : NaN;
  }

  function runningTimeErrorDialog() {
    for (const dialog of visibleDialogs()) {
      const text = (dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim();
      const cumulativeHours = parseCumulativeHours(text);
      if (Number.isFinite(cumulativeHours)) return { dialog, cumulativeHours, text };
    }
    return null;
  }

  // 比累计运行时间略大一点：保留两位小数并加 0.01（1.0 → 1.01，1.234 → 1.24）。
  // D365 提示设备累计运行时间后，在它的基础上 +0.1 小时（整数字段则 +1）。
  function hoursJustAbove(cumulativeHours, integerOnly = false) {
    if (integerOnly) return Math.floor(cumulativeHours) + 1;
    return Number((Math.floor(cumulativeHours * 10 + 1e-6) / 10 + 0.1).toFixed(1));
  }

  // 只在表单确实有未保存修改时点击 Save；保存完成以 Unsaved 提示消失为准，
  // 不强求 getIsDirty 归零，避免其他表单脚本标脏导致一直等待并刷新重写。
  // 保存时若出现累计运行时间校验弹窗，关闭弹窗并返回 { cumulativeHours }，否则返回 null。
  async function saveFormChangesLenient({ force = false } = {}) {
    const isUnsaved = () => /Unsaved|未保存/i.test(document.body.innerText || '');
    const isDirty = () => {
      try {
        return Boolean(globalThis.Xrm?.Page?.data?.entity?.getIsDirty?.());
      } catch {
        return false;
      }
    };
    if (!force && !isUnsaved() && !isDirty()) return null;
    const save = await waitForPage(
      () => findClickable('Save (CTRL+S)', { exact: false })
        || findClickable('保存', { exact: true }),
      '等待 Save 命令出现超过60秒',
    );
    clickUiControl(save);
    await sleep(1500);
    const result = await waitForPage(() => {
      const runningTime = runningTimeErrorDialog();
      if (runningTime) return runningTime;
      return !isUnsaved() ? { saved: true } : false;
    }, '等待表单保存超过60秒', 300);
    if (!result.dialog) return null;
    clickDialogConfirm(result.dialog);
    await sleep(500);
    return { cumulativeHours: result.cumulativeHours };
  }

  const OPERATING_HOURS_LABELS = ['Current Operating Hours', '当前工作小时', '当前运行小时', '当前工作时间'];

  // minHours：D365 提示的设备累计运行时间。给定时，工作小时必须大于它，
  // 即使字段已有数据也会调高；未给定时只在字段为空时写入文件夹名中的工作时间。
  async function fillOperatingHours(run, item, panel, { minHours = null } = {}) {
    const hours = workingHoursValue(item);
    // 0.7.29 之前只有防锈记录累计运行时间，字段名为 rustCumulativeHours。
    let floor = Number.isFinite(minHours)
      ? minHours
      : item.cumulativeHours ?? item.rustCumulativeHours ?? null;
    if (Number.isFinite(minHours) && item.cumulativeHours !== minHours) {
      item.cumulativeHours = minHours;
      saveState(run);
    }
    const tab = await waitForPage(
      () => findAnyClickable(['现场处理', 'On-Site Processing'], { exact: true }),
      '等待 On-Site Processing 标签出现超过60秒',
    );
    clickUiControl(tab);
    // 页签切换后控件 DOM 稍后才渲染，优先等屏幕上可见的那个字段出现；
    // 5 秒后仍识别不到可见 DOM 时，退回使用评分最高的同名字段。
    const lookStartedAt = Date.now();
    const attribute = await waitForPage(() => {
      const found = formAttributeByLabel(OPERATING_HOURS_LABELS);
      if (!found) return null;
      const onScreen = (found.controls?.get?.() || []).some(controlOnScreen);
      return onScreen || Date.now() - lookStartedAt >= 5000 ? found : null;
    }, '等待 Current Operating Hours 字段超过60秒');
    const fieldName = attribute.getName?.() || '';
    const integerOnly = attribute.getAttributeType?.() === 'integer';
    const hasData = () => Boolean(attributeDisplayValue(attribute).trim());
    const currentNumber = () => Number(attribute.getValue?.());
    const writes = [];

    // 最多调整 3 次：每次保存若仍被累计运行时间校验拦截，按新提示的数值再调高。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const belowFloor = Number.isFinite(floor) && !(currentNumber() > floor);
      // 第一次以服务器已保存的值为准（表单上可能只是 AI 建议值）；之后是脚本自己写入的值。
      const filled = attempt === 0 ? await persistedHasData(attribute) : hasData();
      // 0 在 D365 里等于没填，也要重写。
      if (filled && !belowFloor && currentNumber() > 0) break;
      // 只有确实需要写入时才要求文件夹名提供工作时间；字段已有数据（如人工填写）时不需要。
      if (!Number.isFinite(hours) && !Number.isFinite(floor)) {
        throw new Error(`Current Operating Hours 为空，但文件夹“${item.dirName || item.machineNo}”缺少工作时间，请按“机台号_机型_吨位_工作时间”命名`);
      }
      const target = Number.isFinite(floor)
        ? Math.max(Number.isFinite(hours) ? hours : 0, hoursJustAbove(floor, integerOnly))
        : hours;
      attribute.setValue(integerOnly ? Math.ceil(target) : target);
      attribute.fireOnChange?.();
      attribute.setSubmitMode?.('always');
      writes.push(attributeDisplayValue(attribute));
      await waitForPage(hasData, '等待 Current Operating Hours 写入超过60秒', 250);
      const blocked = await saveFormChangesLenient({ force: true });
      if (!blocked) {
        if (!hasData()) throw new Error('保存后 Current Operating Hours 仍为空');
        panel?.log(`${item.machineNo}：已填写并保存 ${attributeLabel(attribute)}（${fieldName}）= ${attributeDisplayValue(attribute)}`);
        return;
      }
      floor = blocked.cumulativeHours;
      item.cumulativeHours = floor;
      saveState(run);
      // 提示的累计时间不大于当前值时，继续调高也无法通过，直接暂停，避免留下未保存的表单。
      if (!(hoursJustAbove(floor, integerOnly) > currentNumber())) {
        throw new Error(`Current Operating Hours = ${attributeDisplayValue(attribute)} 已大于设备累计运行时间 ${floor} 小时，D365 仍拒绝保存，请人工检查 Running Time Before Program Replacement 等字段`);
      }
      panel?.log(`${item.machineNo}：D365 要求运行时间不小于设备累计运行时间 ${floor} 小时，工作小时自动调为 ${hoursJustAbove(floor, integerOnly)}…`);
    }
    if (writes.length && Number.isFinite(floor) && !(currentNumber() > floor)) {
      throw new Error(`Current Operating Hours 已调整 ${writes.length} 次（${writes.join(' → ')}），仍未通过累计运行时间 ${floor} 小时的校验`);
    }
    if (!writes.length) {
      panel?.log(`${item.machineNo}：${attributeLabel(attribute)}（${fieldName}）已有数据（${attributeDisplayValue(attribute)}），不修改`);
    }
  }

  // ---- 订单字段的 Web API 读写 ----
  // 字段写入不再切换页签、点 Save：读取当前值后用一次 PATCH 写完，再刷新已打开的表单。
  // 规则与页面操作一致：只写空字段；Check Passed 为否时置为是；工时低于设备累计运行时间时调高。
  // 任何一步失败（字段无法唯一识别、类型不支持、服务器拒绝等）都会退回原来的页面操作。
  const ORDER_FIELD_SPECS = {
    usageStatus: { labels: PDI_GENERAL_FIELDS.usageStatus, targets: () => USABLE_LABELS },
    model: { labels: PDI_GENERAL_FIELDS.model, targets: (item) => [item.equipmentModel] },
    tonnage: { labels: PDI_GENERAL_FIELDS.tonnage, targets: (item) => [item.tonnage], numeric: true },
    warrantyMonths: { labels: WARRANTY_MONTH_LABELS, targets: () => [RUST_WARRANTY_MONTHS], numeric: true },
    equipmentLocation: { labels: ['Equipment Location', '设备位置'], targets: () => ['uk'] },
    checkPassed: { logicalName: 'mcs_acceptancepassed', labels: ['Check Passed', '检查通过'] },
    operatingHours: { labels: OPERATING_HOURS_LABELS },
    approvalStatus: { labels: ['Approval Status', '审批状态', '审核状态'] },
    // 表单上显示的是文本字段（还有同名的 Lookup/另一个电话字段），直接指定字段名，避免按名字匹配到两个。
    equipmentContact: { logicalName: 'mcs_equipmentcontact1', labels: ['Equipment Contact', '设备联系人'] },
    equipmentContactPhone: { logicalName: 'mcs_equipmentcontacttel', labels: ['Equipment Contact Phone', '设备联系人电话'] },
  };
  const CUMULATIVE_HOURS_LABELS = [
    'Cumulative Running Time', 'Cumulative Operating Hours', 'Cumulative Working Hours',
    '累计运行时间', '累计运行时长', '累计工作小时', '累计工作时间',
  ];
  const NUMERIC_ATTRIBUTE_TYPES = ['Integer', 'BigInt', 'Decimal', 'Double', 'Money'];
  const FORMATTED = '@OData.Community.Display.V1.FormattedValue';

  class FieldApiError extends Error {}

  const PDI_FIELD_KEYS = ['usageStatus', 'model', 'tonnage', 'checkPassed', 'operatingHours'];
  const RUST_FIELD_KEYS = [
    'equipmentLocation', 'checkPassed', 'operatingHours', 'usageStatus', 'model', 'tonnage', 'warrantyMonths',
  ];

  function learnedFieldMap() {
    try {
      return JSON.parse(localStorage.getItem(FIELD_MAP_KEY) || '{}') || {};
    } catch {
      return {};
    }
  }

  // 页面兜底成功后，把表单上实际使用的字段内部名记下来，下一单即可直接走 API。
  function learnFieldsFromForm(keys) {
    const map = learnedFieldMap();
    let changed = false;
    for (const key of keys) {
      const spec = ORDER_FIELD_SPECS[key];
      const name = spec && formAttributeByLabel(spec.labels)?.getName?.();
      if (name && map[key] !== name) {
        map[key] = name;
        changed = true;
      }
    }
    if (changed) localStorage.setItem(FIELD_MAP_KEY, JSON.stringify(map));
  }

  const resolvedFields = new Map();

  // 返回 { key, logicalName, type, options?, lookup? }；无法唯一识别时抛出 FieldApiError。
  async function resolveOrderField(key) {
    if (resolvedFields.has(key)) return resolvedFields.get(key);
    const spec = ORDER_FIELD_SPECS[key];
    const attrs = (await metadata.attributes(ORDER_ENTITY)).filter((attr) => !attr.AttributeOf);
    const learned = learnedFieldMap()[key];
    let attr = (learned && attrs.find((x) => x.LogicalName === learned))
      || (spec.logicalName && attrs.find((x) => x.LogicalName === spec.logicalName));
    if (!attr) {
      const candidates = attrs.filter((x) => labelsEqual(displayLabels(x), spec.labels));
      if (candidates.length !== 1) {
        throw new FieldApiError(`无法从元数据唯一识别字段“${spec.labels[0]}”（匹配 ${candidates.length} 个）`);
      }
      [attr] = candidates;
    }
    const field = { key, logicalName: attr.LogicalName, type: attr.AttributeType };
    if (['Picklist', 'State', 'Status'].includes(field.type)) {
      const picklist = (await metadata.picklists(ORDER_ENTITY)).find((x) => x.LogicalName === attr.LogicalName);
      field.options = picklist?.OptionSet?.Options || [];
    } else if (field.type === 'Lookup') {
      const { data } = await api(
        `EntityDefinitions(LogicalName='${ORDER_ENTITY}')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencingEntityNavigationPropertyName,ReferencedEntity&$filter=${encodeURIComponent(`ReferencingAttribute eq '${attr.LogicalName}'`)}`,
      );
      field.lookups = (data.value || []).map((x) => ({
        navigation: x.ReferencingEntityNavigationPropertyName,
        entity: x.ReferencedEntity,
      }));
      if (!field.lookups.length) throw new FieldApiError(`无法识别 Lookup 字段“${spec.labels[0]}”的目标实体`);
    } else if (!['Boolean', 'String', 'Memo', ...NUMERIC_ATTRIBUTE_TYPES].includes(field.type)) {
      throw new FieldApiError(`字段“${spec.labels[0]}”的类型 ${field.type} 暂不支持 API 写入`);
    }
    resolvedFields.set(key, field);
    return field;
  }

  function fieldSelectName(field) {
    return field.type === 'Lookup' ? `_${field.logicalName}_value` : field.logicalName;
  }

  async function readOrderFields(orderId, model, fields) {
    const select = [...new Set(fields.map(fieldSelectName))].join(',');
    const { data } = await api(
      `${model.orderEntity.EntitySetName}(${normalizeGuid(orderId)})?$select=${select}`,
      { headers: { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' } },
    );
    return Object.fromEntries(fields.map((field) => {
      const name = fieldSelectName(field);
      return [field.key, { raw: data[name], text: String(data[`${name}${FORMATTED}`] ?? data[name] ?? '').trim() }];
    }));
  }

  // 把目标值转换成 PATCH 请求体中的 [属性名, 值]。
  async function apiFieldValue(field, target, numeric) {
    const label = ORDER_FIELD_SPECS[field.key].labels[0];
    if (field.options) {
      const option = field.options.find((x) => optionLabels(x).some((text) => normalizeFieldText(text) === normalizeFieldText(target)))
        || (numeric ? field.options.find((x) => optionLabels(x).some((text) => fieldValueMatches(text, target, true))) : null);
      if (!option) {
        throw new Error(`“${label}”没有选项“${target}”（可选：${field.options.map(optionLabel).filter(Boolean).join('、')}）`);
      }
      return [field.logicalName, option.Value];
    }
    if (field.type === 'Lookup') {
      for (const lookup of field.lookups) {
        const entity = await metadata.entity(lookup.entity);
        const filter = `${entity.PrimaryNameAttribute} eq '${escapeODataString(target)}'`;
        const { data } = await api(
          `${entity.EntitySetName}?$select=${entity.PrimaryIdAttribute}&$filter=${encodeURIComponent(filter)}&$top=2`,
        );
        if ((data.value || []).length > 1) throw new Error(`“${label}”中存在多个名为“${target}”的记录`);
        const id = data.value?.[0]?.[entity.PrimaryIdAttribute];
        if (id) return [`${lookup.navigation}@odata.bind`, `/${entity.EntitySetName}(${normalizeGuid(id)})`];
      }
      throw new Error(`“${label}”中找不到“${target}”`);
    }
    if (field.type === 'Boolean') return [field.logicalName, Boolean(target)];
    if (NUMERIC_ATTRIBUTE_TYPES.includes(field.type)) {
      const value = leadingNumber(target);
      if (!Number.isFinite(value)) throw new Error(`“${label}”是数值字段，无法从“${target}”解析出数字`);
      return [field.logicalName, ['Integer', 'BigInt'].includes(field.type) ? Math.ceil(value) : value];
    }
    return [field.logicalName, String(target)];
  }

  const resolvedCumulativeField = { done: false, logicalName: null };

  // 读取设备的累计运行时间；字段无法唯一识别或读取失败时返回 null（仍可依靠服务器报错调高）。
  async function equipmentCumulativeHours(item, model) {
    try {
      if (!resolvedCumulativeField.done) {
        resolvedCumulativeField.done = true;
        const attrs = await metadata.attributes(EQUIPMENT_ENTITY);
        const candidates = attrs.filter((x) => (
          !x.AttributeOf
          && NUMERIC_ATTRIBUTE_TYPES.includes(x.AttributeType)
          && labelsEqual(displayLabels(x), CUMULATIVE_HOURS_LABELS)
        ));
        resolvedCumulativeField.logicalName = candidates.length === 1 ? candidates[0].LogicalName : null;
      }
      if (!resolvedCumulativeField.logicalName) return null;
      item.equipmentId ||= await findEquipment(item.machineNo, model);
      const { data } = await api(
        `${model.equipmentEntity.EntitySetName}(${item.equipmentId})?$select=${resolvedCumulativeField.logicalName}`,
      );
      const value = Number(data?.[resolvedCumulativeField.logicalName]);
      return Number.isFinite(value) ? value : null;
    } catch (error) {
      if (error instanceof RunPausedError) throw error;
      return null;
    }
  }

  // 本次要写入的工时：文件夹工时，且必须大于已知的设备累计运行时间。
  function operatingHoursTarget(item, field) {
    const hours = workingHoursValue(item);
    const floor = item.cumulativeHours ?? item.rustCumulativeHours ?? null;
    const integerOnly = ['Integer', 'BigInt'].includes(field.type);
    if (!Number.isFinite(floor)) return hours;
    return Math.max(Number.isFinite(hours) ? hours : 0, hoursJustAbove(floor, integerOnly));
  }

  // 已打开的同一订单表单有未保存修改时，重新加载服务器数据并放弃这些修改。
  // 流程全自动，此时的未保存修改只可能是 AI 表单助手的建议值，不能被保存。
  async function discardUnsavedFormChanges(orderId) {
    const entity = globalThis.Xrm?.Page?.data?.entity;
    if (normalizeGuid(entity?.getId?.()) !== normalizeGuid(orderId) || !entity?.getIsDirty?.()) return false;
    await refreshOpenOrderForm(orderId);
    return true;
  }

  // 刷新已打开的同一订单表单，避免页面仍显示旧值或保存时提示“页面数据已更改”。
  async function refreshOpenOrderForm(orderId) {
    try {
      const page = globalThis.Xrm?.Page;
      const pageId = normalizeGuid(page?.data?.entity?.getId?.());
      if (!page?.data?.refresh || pageId !== normalizeGuid(orderId)) return;
      await waitForPagePromise(page.data.refresh(false), '等待表单刷新超过60秒');
    } catch (error) {
      if (error instanceof RunPausedError) throw error;
    }
  }

  // 用 API 检查并写入指定字段。返回写入说明数组；失败时抛出错误，由 applyOrderFields 退回页面操作。
  async function patchOrderFields(run, item, keys, { minHours = null } = {}) {
    const model = await resolveModel(TYPE_CONFIG[run.orderKind]);
    const fields = [];
    for (const key of keys) fields.push(await resolveOrderField(key));
    const hoursField = fields.find((field) => field.key === 'operatingHours');

    if (Number.isFinite(minHours)) item.cumulativeHours = minHours;
    if (hoursField && !Number.isFinite(item.cumulativeHours)) {
      const cumulative = await equipmentCumulativeHours(item, model);
      if (Number.isFinite(cumulative)) item.cumulativeHours = cumulative;
    }

    // 已打开的表单如有未保存修改（流程全自动，通常是 AI 建议值），不保存，写入后随表单刷新一起放弃。

    const changes = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await readOrderFields(item.orderId, model, fields);
      const payload = {};
      changes.length = 0;
      for (const field of fields) {
        if (field.key === 'approvalStatus') continue;
        const { raw, text } = current[field.key];
        const spec = ORDER_FIELD_SPECS[field.key];
        let target = null;
        if (field.key === 'checkPassed') {
          if (raw !== true) target = true;
        } else if (field.key === 'operatingHours') {
          const floor = item.cumulativeHours;
          const belowFloor = Number.isFinite(floor) && !(Number(raw) > floor);
          // 0 在 D365 里等于没填（提交会报 cannot be empty），也要重写。
          if (raw == null || raw === '' || !(Number(raw) > 0) || belowFloor) {
            target = operatingHoursTarget(item, field);
            if (!Number.isFinite(target)) {
              throw new Error(`Current Operating Hours 为空，但文件夹“${item.dirName || item.machineNo}”缺少工作时间，请按“机台号_机型_吨位_工作时间”命名`);
            }
          }
        } else if (raw == null || raw === '') {
          const targets = spec.targets(item).filter(Boolean);
          if (!targets.length) {
            throw new Error(`“${spec.labels[0]}”为空，但文件夹“${item.dirName || item.machineNo}”缺少机型或吨位，请按“机台号_机型_吨位_工作时间”命名`);
          }
          let lastError = null;
          for (const candidate of targets) {
            try {
              const [name, value] = await apiFieldValue(field, candidate, spec.numeric);
              payload[name] = value;
              changes.push(`${spec.labels[0]} = ${candidate}`);
              lastError = null;
              break;
            } catch (error) {
              lastError = error;
            }
          }
          if (lastError) throw lastError;
          continue;
        }
        if (target === null) continue;
        const [name, value] = await apiFieldValue(field, target, spec.numeric);
        payload[name] = value;
        changes.push(`${spec.labels[0]} = ${field.key === 'checkPassed' ? 'Yes' : value}${text && field.key === 'operatingHours' ? `（原 ${text}）` : ''}`);
      }
      if (!Object.keys(payload).length) {
        await discardUnsavedFormChanges(item.orderId);
        return [];
      }
      try {
        await api(`${model.orderEntity.EntitySetName}(${normalizeGuid(item.orderId)})`, {
          method: 'PATCH',
          headers: { 'If-Match': '*' },
          body: JSON.stringify(payload),
        });
        await refreshOpenOrderForm(item.orderId);
        return changes;
      } catch (error) {
        const cumulative = parseCumulativeHours(d365ErrorMessage(error));
        // 服务器的累计运行时间校验：记下数值并把工时一起调高后重试。
        if (!Number.isFinite(cumulative) || attempt >= 2) throw error;
        if (Number.isFinite(item.cumulativeHours) && cumulative <= item.cumulativeHours && hoursField) throw error;
        item.cumulativeHours = cumulative;
        if (!hoursField) fields.push(await resolveOrderField('operatingHours'));
      }
    }
    return changes;
  }

  // 优先用 API 写入；失败时记录原因并执行原来的页面操作 uiFallback。
  async function applyOrderFields(run, item, panel, keys, uiFallback, options = {}) {
    try {
      const changes = await patchOrderFields(run, item, keys, options);
      saveState(run);
      panel?.log(changes.length
        ? `${item.machineNo}：已通过 API 写入 ${changes.join('；')}`
        : `${item.machineNo}：${keys.map((key) => ORDER_FIELD_SPECS[key].labels[0]).join(' / ')} 已有数据，无需修改`);
    } catch (error) {
      if (error instanceof RunPausedError) throw error;
      saveState(run);
      panel?.log(`${item.machineNo}：API 写入未完成（${d365ErrorMessage(error).slice(0, 200)}），改用页面操作…`);
      await uiFallback();
      learnFieldsFromForm(keys);
    }
  }

  // 打开页面前用 API 读取审批状态；字段无法识别或读取失败时返回 null，交给页面判断。
  async function orderApprovedViaApi(run, item) {
    try {
      const model = await resolveModel(TYPE_CONFIG[run.orderKind]);
      const field = await resolveOrderField('approvalStatus');
      const current = await readOrderFields(item.orderId, model, [field]);
      return /^(Approved|已批准|已审批)$/i.test(current.approvalStatus.text);
    } catch (error) {
      if (error instanceof RunPausedError) throw error;
      return null;
    }
  }

  async function completeOnSite(run, item, panel = null) {
    let equipmentLocationFixed = false;
    let runningTimeFixes = 0;
    while (true) {
      let lastClick = 0;
      const result = await waitForPage(() => {
      const submit = findTopLevelAction(['提交审核', 'Submit for Approval']);
      if (submit) return { success: true };

      if ((run.orderKind === 'rust' || run.pdiDealer) && !equipmentLocationFixed
        && equipmentLocationRequiredVisible()) {
        return { needsEquipmentLocation: true };
      }

      const runningTime = runningTimeErrorDialog();
      if (runningTime) return { runningTime };

      for (const dialog of visibleDialogs()) {
        const text = (dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim();
        if (/Operation successful|操作成功/i.test(text)) {
          clickDialogConfirm(dialog);
          continue;
        }
        if (/Saving in Progress/i.test(text)
          && /Please wait while saving is completed/i.test(text)) {
          clickDialogConfirm(dialog);
          continue;
        }
        if (isPageDataChangedMessage(text)) {
          clickDialogConfirm(dialog);
          continue;
        }
        if (/Are you sure.*(?:complete|completion).*site|确认.*现场完工|确定.*现场完工/i.test(text)) {
          clickDialogConfirm(dialog);
          continue;
        }
        if (/Machine running hours|System mile \(KM\)|System volume/i.test(text)) {
          return { error: text, dialog };
        }
        if (/^Error\b|错误/i.test(text)) return { error: text, dialog };
      }

      const completion = findTopLevelAction(['现场完工', 'Completion On Site']);
      // 确认框或其他弹窗仍在时不重复点击 Completion On Site。
      if (completion && !visibleDialogs().length && Date.now() - lastClick >= 3000) {
        item.stage = run.orderKind === 'rust'
          ? 'rust-on-site-completing'
          : 'pdi-on-site-completing';
        saveState(run);
        clickUiControl(completion);
        lastClick = Date.now();
      }
      return false;
      }, '等待 Completion On Site 完成超过60秒', 300);
      if (result.needsEquipmentLocation) {
        panel?.log(`${item.machineNo}：检测到 Equipment Location 必填，自动填写 uk 并保存…`);
        await ensureEquipmentLocationUk();
        item.equipmentLocationAutoFilled = true;
        saveState(run);
        equipmentLocationFixed = true;
        continue;
      }
      if (result.runningTime) {
        clickDialogConfirm(result.runningTime.dialog);
        if (runningTimeFixes >= 2) {
          throw new Error(`现场完工失败：${result.runningTime.text}`);
        }
        runningTimeFixes += 1;
        await ensureOperatingHours(run, item, panel, result.runningTime.cumulativeHours);
        continue;
      }
      if (result.error) {
        clickDialogConfirm(result.dialog);
        throw new Error(`现场完工失败：${result.error}`);
      }
      return;
    }
  }

  async function generatePdiServiceTicket(item) {
    const tab = await waitForPage(
      () => findAnyClickable(['服务完工', 'Service Completion'], { exact: true }),
      '等待 Service Completion 标签出现超过60秒',
    );
    tab.click();
    const viewer = await waitForPage(() => {
      const frame = [...document.querySelectorAll('iframe')].find((current) => (
        visible(current) && /\/docviewer\.html/i.test(current.src || '')
      ));
      try {
        const view = frame?.contentWindow;
        const doc = frame?.contentDocument;
        const loader = doc?.querySelector('.loader');
        const loaded = view?.blob
          && view?.fileName
          && typeof view.generatePDF === 'function'
          && (!loader || getComputedStyle(loader).display === 'none');
        return loaded ? { view, doc } : null;
      } catch {
        return null;
      }
    }, '等待 Service Completion 文件加载超过60秒', 500);

    if (typeof viewer.view.setCustomerConfirmationTime === 'function') {
      await waitForPagePromise(
        viewer.view.setCustomerConfirmationTime(),
        '等待客户确认时间写入超过60秒',
      );
    }
    const pdfUrlValue = await waitForPagePromise(
      viewer.view.generatePDF(),
      '等待 Service Completion PDF 生成超过60秒',
    );
    const pdfUrl = String(pdfUrlValue || '').replace(/^"|"$/g, '');
    if (!pdfUrl) throw new Error('Service Completion 未返回 PDF 下载地址');
    const response = await waitForPagePromise(
      viewer.view.fetch(pdfUrl, { credentials: 'include' }),
      '等待 Service Completion PDF 下载超过60秒',
    );
    if (!response.ok) throw new Error(`Service Completion PDF 下载失败：HTTP ${response.status}`);
    const pdfBlob = await waitForPagePromise(
      response.blob(),
      '等待 Service Completion PDF 文件读取超过60秒',
    );
    if (!pdfBlob.size) throw new Error('Service Completion PDF 文件为空');
    return new File([pdfBlob], `${normalizeGuid(item.orderId).toUpperCase()}.pdf`, {
      type: 'application/pdf',
    });
  }

  async function uploadPdiServiceTicket(run, item, panel) {
    if (item.serviceTicketUploaded) {
      const doc = await openAttachmentTab();
      const existing = attachmentRow(doc, SERVICE_TICKET_RULE, [englishTypeLabel(SERVICE_TICKET_RULE)]);
      if (existing) {
        await renameAttachmentRow(doc, existing, SERVICE_TICKET_RULE);
        return;
      }
      item.serviceTicketUploaded = false;
      saveState(run);
    }
    panel?.log(`${item.machineNo}：等待 Service Completion 文件并生成 PDF…`);
    const pdfFile = await generatePdiServiceTicket(item);
    panel?.log(`${item.machineNo}：上传 PDF 为 Service Ticket…`);
    const doc = await openAttachmentTab();
    await uploadOne(doc, SERVICE_TICKET_RULE, pdfFile);
    item.serviceTicketUploaded = true;
    saveState(run);
  }

  const submitDialogSeenAt = new WeakMap();

  async function submitForApproval(run, item) {
    const submittingStage = run.orderKind === 'rust'
      ? 'rust-approval-submitting'
      : 'pdi-approval-submitting';
    let confirmed = false;
    let lastClick = 0;
    let absentSince = 0;
    const result = await waitForPage(() => {
      const runningTime = runningTimeErrorDialog();
      if (runningTime) return { error: runningTime.text, dialog: runningTime.dialog, runningTime };
      for (const dialog of visibleDialogs()) {
        const text = (dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim();
        if (/Operation successful|操作成功/i.test(text)) {
          clickDialogConfirm(dialog);
          return { success: true };
        }
        if (/Are you sure you want to submit for approval|确认.*提交.*审核|确定.*提交.*审核/i.test(text)) {
          item.stage = submittingStage;
          saveState(run);
          confirmed = clickDialogConfirm(dialog) || confirmed;
          continue;
        }
        if (/couldn't connect to the server|无法连接.*服务器|\bOffline\b/i.test(text)) {
          clickDialogConfirm(dialog);
          confirmed = false;
          lastClick = 0;
          absentSince = 0;
          continue;
        }
        if (isPageDataChangedMessage(text)) {
          clickDialogConfirm(dialog);
          continue;
        }
        if (/Machine running hours|System mile \(KM\)|System volume/i.test(text)
          || (run.orderKind === 'pdi' && /Attachments with file type Service Ticket not uploaded/i.test(text))) {
          return { error: text, dialog };
        }
        if (/^Error\b|错误/i.test(text)) return { error: text, dialog };
        // 提交审核时弹出的其他提示框：稳定显示 1 秒后直接点 OK。
        if (![...dialog.querySelectorAll('iframe')].some((frame) => /\/Map\//i.test(frame.src || ''))) {
          const ok = findAnyClickable(['OK', '确定', 'Ok'], { exact: true, root: dialog });
          if (ok) {
            const seen = submitDialogSeenAt.get(dialog) || Date.now();
            submitDialogSeenAt.set(dialog, seen);
            if (Date.now() - seen >= 1000) {
              clickUiControl(ok);
              submitDialogSeenAt.delete(dialog);
              mapPopupPanel?.log(`${item.machineNo}：提交审核弹出提示，已点 OK（${text.slice(0, 80)}）`);
            }
          }
        }
      }

      const submit = findAnyClickable(['提交审核', 'Submit for Approval'], { exact: true });
      if (!confirmed && submit && !visibleDialogs().length && Date.now() - lastClick >= 3000) {
        clickUiControl(submit);
        lastClick = Date.now();
      }
      const pageReady = findAnyClickable(['刷新', 'Refresh'], { exact: true })
        && findAnyClickable(
          run.orderKind === 'rust'
            ? ['现场处理', 'On-Site Processing', '附件', 'Accessories']
            : ['服务完工', 'Service Completion'],
          { exact: true },
        );
      if (item.stage === submittingStage
        && pageReady && !submit && !visibleDialogs().length) {
        absentSince ||= Date.now();
        if (Date.now() - absentSince >= 5000) return { success: true };
      } else {
        absentSince = 0;
      }
      return false;
    }, '等待 Submit for Approval 完成超过60秒', 300);
    if (result.error) {
      clickDialogConfirm(result.dialog);
      const error = new Error(`提交审核失败：${result.error}`);
      if (result.runningTime) error.cumulativeHours = result.runningTime.cumulativeHours;
      throw error;
    }
  }

  // 现场完工前清理表单：流程全自动，没有需要保存的人工修改；未保存的内容（如 AI 建议值）
  // 一律放弃，避免被现场完工或后续保存顺带写入服务器。
  async function discardFormChangesBeforeFinish(item, panel) {
    if (await discardUnsavedFormChanges(item.orderId)) {
      panel?.log(`${item.machineNo}：表单上有未保存的内容（可能是 AI 建议值），已放弃，不保存`);
    }
  }

  async function finishPdiAndSubmit(run, item, panel) {
    await discardFormChangesBeforeFinish(item, panel);
    if (item.stage !== 'pdi-approval-submitting') {
      panel?.log(`${item.machineNo}：自动执行 Completion On Site…`);
      await completeOnSite(run, item, panel);
      item.stage = 'pdi-completing';
      saveState(run);
    }
    await uploadPdiServiceTicket(run, item, panel);
    await submitWithHoursCheck(run, item, panel);
  }

  async function applyRustFields(run, item, panel) {
    await applyOrderFields(run, item, panel, RUST_FIELD_KEYS, async () => {
      await ensureItemEquipmentLocation(run, item, panel);
      await setPdiCheckPassed();
      await fillOperatingHours(run, item, panel);
      await fillGeneralInfo(run, item, panel);
    });
  }

  // 已有防锈订单可能停在 Dispatched/Accepted/Departed 等状态：先把它推进到“已到达”，
  // 再走原有的字段、附件、现场完工和提交审核流程。
  async function ensureRustOrderArrived(run, item, panel, initialState = null) {
    const ready = () => isArrivedUi()
      || Boolean(findTopLevelAction(['现场完工', 'Completion On Site', '提交审核', 'Submit for Approval']));
    const state = initialState || await waitForOrderInitialCommandState();
    if (ready()) return;
    const progress = findTopLevelAction([
      '接受', 'Accept',
      'Navigation Set Off', '出发', 'Set Off',
      'Navigation Arrived', '到达', 'Arrived', 'Arrive',
    ]);
    if (state !== 'accept-ready' && !progress) {
      const status = currentRecordStatusText() || item.matchedStatus || '未知';
      throw new Error(`已有防锈订单 ${item.orderNumber || item.orderId} 状态为 ${status}，但当前账号没有接受/出发/到达/现场完工按键；可能需要先派单（可用“防锈：检查→派单”模式），派好后再继续`);
    }
    panel?.log(`${item.machineNo}：已有订单状态为 ${currentRecordStatusText() || item.matchedStatus || '进行中'}，先执行接受/出发/到达…`);
    await ensurePdiAccepted();
    await runPdiSetOff();
    await runPdiArrive();
  }

  async function finishRustAndSubmit(run, item, panel) {
    await discardFormChangesBeforeFinish(item, panel);
    if (item.stage !== 'rust-approval-submitting') {
      // 现场完工前再核对一次（通常只是一次读取），旧进度恢复到收尾阶段时也会补写。
      panel?.log(`${item.machineNo}：现场完工前核对 Equipment Location、Check Passed、工作小时、Usable/机型/吨位/保修期…`);
      await applyRustFields(run, item, panel);
      panel?.log(`${item.machineNo}：自动执行 Completion On Site…`);
      await completeOnSite(run, item, panel);
      item.stage = 'rust-completing';
      saveState(run);
    }
    await submitWithHoursCheck(run, item, panel);
  }

  // 工时为空或低于累计运行时间时写入/调高；优先 API，失败时退回页面操作。
  async function ensureOperatingHours(run, item, panel, minHours = null) {
    const options = Number.isFinite(minHours) ? { minHours } : {};
    await applyOrderFields(run, item, panel, ['operatingHours'], () => fillOperatingHours(run, item, panel, options), options);
  }

  async function submitWithHoursCheck(run, item, panel) {
    // 提交审核会校验运行小时；现场完工前后的表单脚本可能清空该字段，提交前再检查一次。
    panel?.log(`${item.machineNo}：提交前检查 Current Operating Hours…`);
    await ensureOperatingHours(run, item, panel);
    panel?.log(`${item.machineNo}：执行 Submit for Approval…`);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await submitForApproval(run, item);
        return;
      } catch (error) {
        const hoursEmpty = /Machine running hours|System mile \(KM\)|System volume/i.test(error.message);
        if (attempt >= 2 || (!hoursEmpty && !Number.isFinite(error.cumulativeHours))) throw error;
        // 运行小时为空或低于设备累计运行时间：补写或调高后重试，仍失败则暂停人工处理。
        panel?.log(Number.isFinite(error.cumulativeHours)
          ? `${item.machineNo}：提交时 D365 要求运行时间不小于累计 ${error.cumulativeHours} 小时，调高工作小时后重试…`
          : `${item.machineNo}：D365 提示运行小时为空，补写 Current Operating Hours 后重试提交…`);
        await ensureOperatingHours(run, item, panel, error.cumulativeHours);
      }
    }
  }

  // 子文件夹命名为“机台号_机型_吨位_工作时间”，只有机台号用于查询 D365 设备。
  // 四段及以上：第一段机台号，最后两段为吨位、工作时间，中间为机型（机型可含下划线）。
  // 三段的旧格式“机台号_机型_吨位”没有工作时间，PDI 和防锈都不能执行。
  // 不含下划线的旧文件夹仍按整个名称作为机台号处理。
  function parseFolderName(name) {
    const parts = String(name).split('_').map((part) => part.trim());
    const full = parts.length >= 4;
    return {
      machineNo: parts[0] || '',
      equipmentModel: full
        ? parts.slice(1, -2).join('_')
        : parts.length === 3 ? parts[1] : (parts[1] || ''),
      tonnage: full ? parts[parts.length - 2] : parts.length === 3 ? parts[2] : '',
      workingHours: full ? parts[parts.length - 1] : '',
      formatOk: full && parts.every(Boolean),
    };
  }

  // 按当前规则在机号文件夹中查找 1～4 号照片的实际文件名（扩展名不区分大小写，按 aliases 顺序优先）。
  async function photoNamesIn(dir) {
    const names = new Map();
    for await (const child of dir.values()) {
      if (child.kind === 'file') names.set(child.name.toLowerCase(), child.name);
    }
    return Object.fromEntries(ALL_PHOTO_NAMES.flatMap((rule) => {
      const actual = rule.aliases.map((name) => names.get(name)).find(Boolean);
      return actual ? [[rule.name, actual]] : [];
    }));
  }

  // 用当前规则重新扫描已授权的文件夹，更新每台机号的照片信息（不改变处理进度）。
  // 选择文件夹后脚本升级过（例如新增 jpeg 支持）时，旧的扫描结果会被更新。没有读取权限时返回 false。
  async function rescanRun(run) {
    const handle = await loadHandle(run.handleKey).catch(() => null);
    if (!handle || await handle.queryPermission({ mode: 'read' }) !== 'granted') return false;
    for (const item of run.items || []) {
      try {
        const dir = await itemDir(handle, item);
        item.fileNames = await photoNamesIn(dir);
        item.files = Object.keys(item.fileNames);
      } catch { /* 文件夹已被移动或删除：保留原扫描结果 */ }
    }
    reconcileItemValidation(run);
    return true;
  }

  async function scanRoot(handle, runMode = RUN_MODE.FULL, orderKind = 'pdi') {
    const rows = [];
    const scanRun = { runMode, orderKind };
    const makeRow = (folder, dirName, fileNames) => {
      const missing = [
        ...photoRulesForRun(scanRun, { files: Object.keys(fileNames) })
          .filter((rule) => !fileNames[rule.name])
          .map((rule) => rule.aliases.join('/')),
        ...folderInfoMissing(scanRun, folder),
      ];
      return {
        machineNo: folder.machineNo,
        dirName,
        equipmentModel: folder.equipmentModel,
        tonnage: folder.tonnage,
        workingHours: folder.workingHours,
        folderFormatOk: folder.formatOk,
        files: Object.keys(fileNames),
        fileNames,
        missing,
        stage: missing.length ? 'invalid' : 'pending',
        uploaded: [],
        error: '',
      };
    };
    for await (const entry of handle.values()) {
      if (entry.kind !== 'directory' || entry.name.startsWith('.')) continue;
      const folder = parseFolderName(entry.name);
      if (!folder.machineNo) continue;
      const fileNames = await photoNamesIn(entry);
      rows.push(makeRow(folder, entry.name, fileNames));
    }
    // 没有子文件夹、但所选文件夹本身就是“机台号_机型_吨位_工作时间”或里面有照片：当作单台机处理。
    if (!rows.length) {
      const folder = parseFolderName(handle.name);
      const fileNames = await photoNamesIn(handle);
      if (folder.machineNo && (folder.formatOk || Object.keys(fileNames).length)) {
        rows.push(makeRow(folder, SINGLE_DIR, fileNames));
      }
    }
    rows.sort((a, b) => a.machineNo.localeCompare(b.machineNo, 'zh-CN', { numeric: true }));
    return rows;
  }

  class Panel {
    constructor() {
      this.host = document.createElement('div');
      this.host.id = APP_ID;
      this.host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
      document.documentElement.appendChild(this.host);
      this.root = this.host.attachShadow({ mode: 'open' });
      this.render();
      this.enableDragging();
      this.restorePosition();
    }

    render() {
      this.root.innerHTML = `
        <style>
          *{box-sizing:border-box} .panel{width:390px;max-height:78vh;overflow:auto;background:#fff;border:1px solid #d0d7de;border-radius:12px;box-shadow:0 10px 35px #0003;color:#24292f}
          header{position:sticky;top:0;z-index:1;display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#0f6cbd;color:#fff;border-radius:11px 11px 0 0;cursor:move;user-select:none;touch-action:none} header b{font-size:15px}.body{padding:12px}
          label{display:block;font-size:12px;color:#57606a;margin:9px 0 4px} select,input,button{font:inherit} select,input[type="text"]{width:100%;padding:7px;border:1px solid #afb8c1;border-radius:6px;background:#fff}
          .row{display:flex;gap:8px;margin-top:10px}.row button{flex:1}.primary{background:#0f6cbd;color:#fff;border-color:#0f6cbd}button{padding:8px 10px;border:1px solid #afb8c1;border-radius:6px;background:#f6f8fa;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}
          .check{display:flex;gap:7px;align-items:center;color:#24292f;font-size:12px}.check input{width:auto;margin:0}
          .summary{margin-top:10px;padding:8px;background:#f6f8fa;border-radius:6px;font-size:12px}.list{margin-top:8px;max-height:220px;overflow:auto;border:1px solid #d8dee4;border-radius:6px}.item{padding:7px 8px;border-bottom:1px solid #eaeef2;font-size:12px}.item:last-child{border:0}.ok{color:#1a7f37}.bad{color:#cf222e}.run{color:#0969da}.skip{color:#8250df}.meta{color:#6e7781}.log{white-space:pre-wrap;background:#0d1117;color:#c9d1d9;border-radius:6px;padding:8px;margin-top:9px;max-height:120px;overflow:auto;font:11px ui-monospace,monospace}
          .tabs{display:flex;gap:4px;margin-bottom:4px}.tabs button{flex:1;padding:7px 4px;font-size:13px;border-radius:6px 6px 0 0;border-bottom:2px solid transparent;background:#f6f8fa}.tabs button.active{background:#fff;border-color:#0f6cbd;color:#0f6cbd;font-weight:600}
          textarea{font:12px ui-monospace,monospace}
          .tiny{font-size:11px;color:#6e7781;margin-top:7px}#collapse{background:transparent;color:#fff;border:0;padding:0 4px}.ver{margin-left:8px;font-size:11px;font-weight:400;opacity:.85;background:transparent;color:#fff;border:1px solid transparent;border-radius:4px;padding:1px 5px;cursor:pointer}.ver:hover{border-color:#ffffff80;opacity:1}.ver.new{background:#d1242f;opacity:1;font-weight:600}
        </style>
        <div class="panel">
          <header><span><b>D365 批量建单</b><button id="version" class="ver" title="点击检查更新">v${escapeHtml(SCRIPT_VERSION)}</button></span><button id="collapse">—</button></header>
          <div class="body">
            <div class="tabs"><button id="tabMake" data-tab="make">做单</button><button id="tabDispatch" data-tab="dispatch">转移 / 派单</button><button id="tabEc" data-tab="ec">设备变更</button></div>
            <div id="funcWrap"><label>功能</label><select id="func"></select></div>
            <div id="advWrap" hidden>
            <label>运行模式</label>
            <select id="runMode"><option value="full">处理 PDI / 防锈订单</option><option value="transfer">PDI 创建→服务转移</option><option value="rust-dispatch">防锈：检查→派单</option><option value="equipment-change">设备变更（粘贴机号批量）</option></select>
            <label>订单类型</label>
            <select id="orderKind"><option value="pdi">PDI（到货预验收）</option><option value="pdi-dealer">经销商 PDI（代理商入库预验收）</option><option value="pdi-shipment">Shipment PDI（出库预验收）</option><option value="rust">防锈运转</option><option value="handover">交机（没有交机单就新建）</option><option value="handover-pdi">交机（无照片，从 PDI 拿资料）</option><option value="chain">全流程</option></select>
            </div>
            <div id="preWrap"><label>预验收类型</label><select id="preType"><option>到港预验收</option></select></div>
            <div id="transferWrap" hidden><label>转移给（请输入可唯一匹配的姓名）</label><input id="transferTarget" type="text" placeholder="例如 Coetzee"></div>
            <div id="shipWrap" hidden>
              <label>要派的单号（每行一个，可以一次贴多张）</label>
              <textarea id="shipOrders" rows="4" style="width:100%;padding:7px;border:1px solid #afb8c1;border-radius:6px;font:12px ui-monospace,monospace;resize:vertical" placeholder="5226111404&#10;5226110959"></textarea>
              <label>Description（写进上面每张单；留空就不修改原来的）</label>
              <textarea id="shipDesc" rows="6" style="width:100%;padding:7px;border:1px solid #afb8c1;border-radius:6px;resize:vertical" placeholder="Customer: ...&#10;Sales Manager: ...&#10;ETA of Delivery: ..."></textarea>
              <div class="row"><button id="shipBuild">按单号生成任务</button></div>
            </div>
            <div id="dispatchWrap" hidden><label>派给（请输入可唯一匹配的人员姓名）</label><input id="dispatchTarget" type="text" placeholder="例如 Coetzee"></div>
            <div id="ecWrap" hidden>
              <label>机号（每行一个；机号后可空格写工时，如 SYK11005PT5C01885 12）</label>
              <textarea id="ecMachines" rows="5" style="width:100%;padding:7px;border:1px solid #afb8c1;border-radius:6px;font:12px ui-monospace,monospace;resize:vertical" placeholder="SYK11005PT5C01885&#10;SYK11008AT5C01130 12"></textarea>
              <label>Dealer（名称或代码；留空=和 Service Dealer 填同一个）</label><input id="ecDealerMain" type="text">
              <label>Service Dealer（名称或代码；不改就留空）</label><input id="ecDealer" type="text">
              <label>Responsible Service Engineer</label><input id="ecEngineer" type="text" placeholder="例如 林卓然">
              <label>Service Manager</label><input id="ecManager" type="text" placeholder="例如 林卓然">
              <label>Current working time of the entire machine（机号后没写工时时用这个）</label><input id="ecHours" type="text">
              <label>Change Remarks</label><input id="ecRemark" type="text" placeholder="例如 Sunbelt Machine">
              <label>Equipment Usage Status（为空时才填）</label><select id="ecUsage"><option>Usable</option><option>Abnormal</option><option>Delisting</option></select>
              <label>Equipment Address（为空时才填）</label><input id="ecAddress" type="text">
              <label>Model (Machine Type)（为空时才填）</label><input id="ecModel" type="text">
              <label>Equipment Type（选了就改成这个；不改就选“保持原值”）</label><select id="ecType"><option value="">保持原值（不修改）</option><option value="10">Host</option><option value="20">Second-hand Machine</option><option value="30">Sample Machine</option><option value="40">Legal Machine</option><option value="50">Trial Machine（50）</option><option value="60">Spare Machine</option><option value="70">Rental Machine</option><option value="80">Trial Machine（80）</option></select>
              <label>Warranty Policy Value（质保数值，不改就留空）</label><input id="ecWarrantyValue" type="text" placeholder="例如 1">
              <label>Warranty Policy Month（质保月数 1～60，不改就留空）</label><input id="ecWarrantyMonth" type="text" placeholder="例如 12">
              <div class="row"><button id="ecStart" class="primary">开始设备变更</button></div>
            </div>
            <div id="pasteWrap" hidden>
              <label>机号（每行一个；机号后可空格写工时，不写就用 PDI 里的工时）</label>
              <textarea id="pasteMachines" rows="5" style="width:100%;padding:7px;border:1px solid #afb8c1;border-radius:6px;resize:vertical" placeholder="SYK11001AT5C03785&#10;SYK11008PT5C03162 2.5"></textarea>
              <label>交机日期（不选就用当天）</label><input id="handoverDate" type="date">
              <div class="row"><button id="pasteBuild">按粘贴的机号生成任务</button></div>
            </div>
            <label id="forceNewWrap" class="check"><input id="forceNew" type="checkbox">测试模式：始终新建订单（仅服务转移）</label>
            <div class="row" id="pickRow"><button id="loadOptions">加载 D365 选项</button><button id="pick">选择待处理文件夹</button></div>
            <div class="row" id="reuseRow" hidden><button id="reuseFolder">沿用上次文件夹</button></div>
            <div id="summary" class="summary">尚未选择文件夹</div>
            <div id="list" class="list"></div>
            <div class="row"><button id="start" class="primary" disabled>确认并开始</button><button id="pause">暂停</button></div>
            <div class="row"><button id="reauthorize">重新授权并继续</button><button id="skip" disabled>跳过当前单</button></div>
            <div class="row"><button id="reset">清除任务</button></div>
            <div id="modeHint" class="tiny"></div>
            <div id="log" class="log">[${nowText()}] 脚本已加载（v${escapeHtml(SCRIPT_VERSION)}）</div>
          </div>
        </div>`;
      this.bind();
      this.refresh();
    }

    setPosition(left, top) {
      const rect = this.host.getBoundingClientRect();
      const margin = 6;
      const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
      const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
      const safeLeft = Math.min(Math.max(margin, Number(left) || margin), maxLeft);
      const safeTop = Math.min(Math.max(margin, Number(top) || margin), maxTop);
      this.host.style.right = 'auto';
      this.host.style.bottom = 'auto';
      this.host.style.left = `${safeLeft}px`;
      this.host.style.top = `${safeTop}px`;
    }

    savePosition() {
      const rect = this.host.getBoundingClientRect();
      localStorage.setItem(PANEL_POSITION_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    }

    restorePosition() {
      try {
        const position = JSON.parse(localStorage.getItem(PANEL_POSITION_KEY) || 'null');
        if (Number.isFinite(position?.left) && Number.isFinite(position?.top)) {
          requestAnimationFrame(() => this.setPosition(position.left, position.top));
        }
      } catch { /* 使用默认右下角位置 */ }
    }

    enableDragging() {
      const header = this.root.querySelector('header');
      let drag = null;
      header.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.target.closest('button,input,select,a')) return;
        const rect = this.host.getBoundingClientRect();
        drag = {
          pointerId: event.pointerId,
          offsetX: event.clientX - rect.left,
          offsetY: event.clientY - rect.top,
        };
        header.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      });
      header.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        this.setPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
      });
      const finish = (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        header.releasePointerCapture?.(event.pointerId);
        drag = null;
        this.savePosition();
      };
      header.addEventListener('pointerup', finish);
      header.addEventListener('pointercancel', finish);
      window.addEventListener('resize', () => {
        if (!this.host.style.left || !this.host.style.top) return;
        this.setPosition(parseFloat(this.host.style.left), parseFloat(this.host.style.top));
        this.savePosition();
      });
    }

    $(id) { return this.root.getElementById(id); }
    log(message) {
      const el = this.$('log');
      el.textContent += `\n[${nowText()}] ${message}`;
      el.scrollTop = el.scrollHeight;
    }

    syncModeUi() {
      const transfer = this.$('runMode').value === RUN_MODE.TRANSFER;
      const dispatch = this.$('runMode').value === RUN_MODE.RUST_DISPATCH;
      // 转移模式只能建 PDI，但可在普通 PDI / 经销商 PDI 之间选
      if (transfer && !isPdiUiKind(this.$('orderKind').value)) this.$('orderKind').value = 'pdi';
      if (dispatch) this.$('orderKind').value = 'rust';
      for (const opt of this.$('orderKind').options) opt.disabled = transfer && !isPdiUiKind(opt.value);
      this.$('orderKind').disabled = dispatch;
      this.$('transferWrap').hidden = !transfer;
      this.$('dispatchWrap').hidden = !dispatch;
      const ec = this.$('runMode').value === RUN_MODE.EQUIPMENT_CHANGE;
      this.$('ecWrap').hidden = !ec;
      this.$('orderKind').disabled = this.$('orderKind').disabled || ec;
      this.$('forceNewWrap').hidden = !transfer;
      this.$('preWrap').hidden = this.$('orderKind').value !== 'pdi';
      const dealerPdi = this.$('orderKind').value === 'pdi-dealer';
      const shipmentPdi = this.$('orderKind').value === 'pdi-shipment';
      const handoverPdi = !ec && !transfer && !dispatch && this.$('orderKind').value === 'handover-pdi';
      this.$('pasteWrap').hidden = !handoverPdi;
      const shipByNo = transfer && shipmentPdi;
      this.$('shipWrap').hidden = !shipByNo;
      this.$('pickRow').hidden = ec || handoverPdi || shipByNo;
      if (ec || handoverPdi || shipByNo) this.$('reuseRow').hidden = true;
      this.syncFuncFromSelects();
      this.$('modeHint').textContent = ec
        ? '设备变更：不用选文件夹。粘贴机号、填好上面的框后点“开始设备变更”。逐台新建（已有未提交的就继续用）设备变更单，填 Service Dealer、负责工程师、服务经理、工时、备注和空着的必填项，保存后提交审批。Service Dealer 已是目标值或已有审批中的变更单会跳过。'
        : dispatch
        ? '防锈派单：本月已做过防锈运转则跳过；只处理本月状态为 Created、且当前账号看不到接受/出发/到达等按键的防锈单，派给指定人员。不新建订单，不需要照片。需用有派单权限的账号运行。'
        : transfer
        ? (shipmentPdi
          ? 'Shipment PDI 服务转移：不用选文件夹。贴上要派的单号（每行一个）和 Description，填“转移给”，点“按单号生成任务”再“确认并开始”。逐张：确认是出库预验收单 → 把 Description 写进去（留空不改）→ 服务转移。负责人已不是自己或已交机/已接收的跳过。'
          : dealerPdi
          ? '创建经销商 PDI（预验收类型=代理商入库预验收）；已有未取消的代理商入库预验收单就复用，不会用这台机的到港 PDI。经销商 PDI 没有服务转移，创建后用 Assign 派单给“转移给”里填的人（已经是他就跳过，状态不是 Created 的不再派）。'
          : '转移模式固定创建 PDI；搜索结果必须唯一，并执行永久转派。')
        : this.$('orderKind').value === 'chain'
          ? '全流程（在执行账号如 Coetzee 里跑）：选照片文件夹（机台号_机型_吨位_工作时间，里面 1～4 号照片，防锈有 5 号就按 5 张），每台机依次做 到港 PDI → 防锈 → 经销商 PDI（只做经销商设备）。到港 PDI 需要先在你自己的账号用“转移/派单 → PDI 创建 → 服务转移”建好并转过来；经销商 PDI 没有就新建并派给当前账号，派不了会暂停提示你用自己的账号派。已完成或已提交审核的步骤自动跳过。'
        : handoverPdi
          ? '交机（无照片）：不用选文件夹，粘贴机号后点“按粘贴的机号生成任务”。先确认这台机有 PDI 且 PDI 里有 Service Ticket，没有就跳过；四张照片（铭牌、远照、工时照、其他）和工作小时都从这台机最近的 PDI 里下载/读取，机号后写了工时的用写的；其余步骤和交机一样：交机日期=下面选的日期（不选就今天）、设备位置、出发/到达、Assessment Pass、无需培训、Check Passed、Service Ticket、现场完工（没填联系人就暂停等你填）并提交审核。'
        : this.$('orderKind').value === 'handover'
          ? '交机：先确认这台机有 PDI 订单且 PDI 里有 Service Ticket，没有就跳过不做；已有交机单是 现场完工/提交审核/已完成 的跳过，其他状态（做到一半的）继续做，没有交机单就新建；然后交机日期=今天、把设备位置设为当前所在位置、出发（Ground transportation）、Assessment Pass、到达（要求填地址就暂停交给你）、无需培训、Check Passed、工作小时、四张照片、从 PDI 拉 Service Ticket、现场完工（没填设备联系人就暂停等你填）并提交审核。'
        : dealerPdi
          ? '经销商 PDI 全自动：只打开预验收类型为“代理商入库预验收”的已有 PDI 单。经销商 PDI 没有出发/到达：需要时先接受，然后直接四张照片、Usable/机型/吨位、Check Passed、工作小时、现场完工、Service Ticket 和提交审核。'
        : this.$('orderKind').value === 'pdi'
          ? 'PDI 全自动：接受/出发/到达、四张照片、Usable/机型/吨位、Check Passed、工作小时、现场完工、Service Ticket 和提交审核。'
          : '防锈：本月订单已是 现场完工/提交审核(In Approval)/已完成 则跳过；本月有其他状态的订单就打开继续完成；没有才新建。完成内容：Check Passed、工作小时、附件（文件夹有 5 号照片按 5 张：1 铭牌、2 远照、3 和 4 工时照、5 其他；只有 1～4 号按原来 4 张）、Usable/机型/吨位/保修期、现场完工和提交审核。';
    }

    // ===== 功能分区 =====
    // 三个分区：做单 / 转移·派单 / 设备变更。每个“功能”对应原来的（运行模式, 订单类型）组合，
    // 选功能时写回这两个（已隐藏的）下拉框，后面的逻辑不变。
    static FUNCS = {
      make: [
        ['full|chain', '全流程：到港 PDI → 防锈 → 经销商 PDI'],
        ['full|pdi', 'PDI（到港预验收）'],
        ['full|pdi-dealer', '经销商 PDI（代理商入库预验收）'],
        ['full|rust', '防锈运转'],
        ['full|handover', '交机（用文件夹里的照片）'],
        ['full|handover-pdi', '交机（无照片，从 PDI 拿资料）'],
      ],
      dispatch: [
        ['transfer|pdi', 'PDI 创建 → 服务转移'],
        ['transfer|pdi-dealer', '经销商 PDI 创建 → Assign 派单'],
        ['transfer|pdi-shipment', 'Shipment PDI（出库预验收）创建 → 服务转移'],
        ['rust-dispatch|rust', '防锈：检查 → 派单'],
      ],
      ec: [['equipment-change|pdi', '设备变更（粘贴机号批量）']],
    };

    currentFuncKey() {
      const mode = this.$('runMode').value;
      if (mode === RUN_MODE.EQUIPMENT_CHANGE) return 'equipment-change|pdi';
      if (mode === RUN_MODE.RUST_DISPATCH) return 'rust-dispatch|rust';
      return `${mode}|${this.$('orderKind').value}`;
    }

    tabOfFunc(key) {
      return Object.keys(Panel.FUNCS).find((tab) => Panel.FUNCS[tab].some(([k]) => k === key)) || 'make';
    }

    showTab(tab, keepFunc = '') {
      for (const id of ['tabMake', 'tabDispatch', 'tabEc']) {
        this.$(id).classList.toggle('active', this.$(id).dataset.tab === tab);
      }
      const funcs = Panel.FUNCS[tab];
      this.$('func').innerHTML = funcs.map(([k, text]) => `<option value="${k}">${escapeHtml(text)}</option>`).join('');
      this.$('func').value = funcs.some(([k]) => k === keepFunc) ? keepFunc : funcs[0][0];
      this.$('funcWrap').hidden = funcs.length < 2;
    }

    // 隐藏下拉框的值变了（例如从保存的任务恢复）时，同步分区和功能显示。
    syncFuncFromSelects() {
      if (this.syncingFunc) return;
      const key = this.currentFuncKey();
      const tab = this.tabOfFunc(key);
      const activeTab = ['tabMake', 'tabDispatch', 'tabEc'].map((id) => this.$(id)).find((b) => b.classList.contains('active'))?.dataset.tab;
      if (activeTab !== tab || this.$('func').value !== key) this.showTab(tab, key);
    }

    applyFunc(key) {
      const [mode, kind] = key.split('|');
      this.syncingFunc = true;
      try {
        this.$('runMode').value = mode;
        if (mode !== RUN_MODE.EQUIPMENT_CHANGE) this.$('orderKind').value = kind;
        this.syncModeUi();
      } finally {
        this.syncingFunc = false;
      }
      const run = getState();
      if (run?.status === 'completed' && mode !== RUN_MODE.EQUIPMENT_CHANGE && kind !== 'handover-pdi') {
        this.reuseLastFolder({ auto: true });
        return;
      }
      if (run?.status === 'draft') {
        run.runMode = mode;
        if (mode !== RUN_MODE.EQUIPMENT_CHANGE) Object.assign(run, uiKindToRun(kind));
        if (isTransferMode(run)) run.orderKind = 'pdi';
        if (isRustDispatchMode(run)) run.orderKind = 'rust';
        reconcileItemValidation(run);
        saveState(run);
        this.refresh();
      }
    }

    async buildShipmentTask() {
      const existing = getState();
      if (existing && ['running', 'paused'].includes(existing.status)) {
        this.log('当前还有未完成的任务，请先完成或点“清除任务”');
        return;
      }
      const seen = new Set();
      const numbers = this.$('shipOrders').value.split(/[\s,，;；]+/).map((x) => x.trim()).filter((x) => x && !seen.has(x) && seen.add(x));
      if (!numbers.length) {
        this.log('请先在框里粘贴要派的单号（每行一个）');
        return;
      }
      const items = numbers.map((no) => ({
        machineNo: no,
        orderNumberInput: no,
        dirName: null,
        files: [],
        missing: [],
        noFolder: true,
        stage: 'pending',
        uploaded: [],
        error: '',
      }));
      saveState({
        version: 1,
        status: 'draft',
        handleKey: null,
        folderName: '粘贴单号',
        runMode: RUN_MODE.TRANSFER,
        orderKind: 'pdi',
        pdiDealer: false,
        pdiShipment: true,
        chainMode: false,
        preInspectionType: SHIPMENT_PDI_PRE_TYPE,
        shipmentDescription: this.$('shipDesc').value,
        currentIndex: 0,
        items,
        createdAt: new Date().toISOString(),
      });
      this.log(`已按单号生成 Shipment PDI 服务转移任务，共 ${items.length} 张${this.$('shipDesc').value.trim() ? '，会写入 Description' : '，Description 留空不修改'}。填好“转移给”后点“确认并开始”`);
      this.refresh();
    }

    // ===== 工作台接口：D365 工作台程序把 Excel 里整理好的一批任务送进来 =====
    // 只负责切到对应功能、把内容填进面板；点“开始”仍然由你在面板里确认。
    async loadJob(job) {
      const run = getState();
      if (run && ['running', 'paused', 'awaiting-pdi-user'].includes(run.status)) {
        return { ok: false, error: '执行窗口里还有未完成的任务，请先完成或点“清除任务”' };
      }
      const all = Object.values(Panel.FUNCS).flat().map(([k]) => k);
      if (!all.includes(job?.func)) return { ok: false, error: `不认识的功能：${job?.func}` };
      if (run) clearState(); // 已完成/草稿的旧任务清掉，避免切功能时自动沿用旧文件夹
      const body = this.root.querySelector('.body');
      if (body?.hidden) this.$('collapse').click();
      this.showTab(this.tabOfFunc(job.func), job.func);
      this.applyFunc(job.func);
      for (const [id, value] of Object.entries(job.fields || {})) {
        const el = this.$(id);
        if (el) el.value = value ?? '';
      }
      if (Object.keys(job.fields || {}).some((id) => EC_FIELDS.includes(id))) saveEcConfig(this.readEcConfig());
      this.log(`工作台送来：${job.title || job.func}`);
      if (job.build === 'paste') await this.buildPasteTask();
      if (job.build === 'ship') await this.buildShipmentTask();
      this.refresh();
      // 工作台后台执行：填好后直接开始（确认框由工作台自动点确定）
      if (job.autoStart) {
        setTimeout(() => {
          const go = job.func === 'equipment-change|pdi' ? this.startEquipmentChange() : this.start();
          Promise.resolve(go).catch((error) => this.log(`自动开始失败：${error.message}`));
        }, 300);
      }
      return { ok: true };
    }

    async buildPasteTask() {
      const existing = getState();
      if (existing && ['running', 'paused'].includes(existing.status)) {
        this.log('当前还有未完成的任务，请先完成或点“清除任务”');
        return;
      }
      const items = parseMachineLines(this.$('pasteMachines').value).map((item) => ({
        ...item,
        dirName: null,
        workingHours: Number.isFinite(item.ecHours) ? String(item.ecHours) : '',
        noFolder: true,
      }));
      if (!items.length) {
        this.log('请先在框里粘贴机号（每行一个）');
        return;
      }
      saveState({
        version: 1,
        status: 'draft',
        handleKey: null,
        folderName: '粘贴机号',
        runMode: RUN_MODE.FULL,
        orderKind: 'handover',
        handoverFromPdi: true,
        pdiDealer: false,
        currentIndex: 0,
        items,
        createdAt: new Date().toISOString(),
      });
      this.log(`已按粘贴的机号生成交机任务（无照片，从 PDI 拿资料），共 ${items.length} 台。确认后点“确认并开始”`);
      this.refresh();
    }

    bind() {
      for (const id of ['tabMake', 'tabDispatch', 'tabEc']) {
        this.$(id).onclick = () => {
          const tab = this.$(id).dataset.tab;
          this.showTab(tab);
          this.applyFunc(this.$('func').value);
        };
      }
      this.$('func').onchange = () => this.applyFunc(this.$('func').value);
      this.$('pasteBuild').onclick = () => this.buildPasteTask();
      this.$('shipBuild').onclick = () => this.buildShipmentTask();
      this.$('collapse').onclick = () => {
        const body = this.root.querySelector('.body');
        body.hidden = !body.hidden;
        this.$('collapse').textContent = body.hidden ? '+' : '—';
        requestAnimationFrame(() => {
          if (!this.host.style.left || !this.host.style.top) return;
          const rect = this.host.getBoundingClientRect();
          this.setPosition(rect.left, rect.top);
          this.savePosition();
        });
      };
      this.$('runMode').onchange = () => {
        const transfer = this.$('runMode').value === RUN_MODE.TRANSFER;
        const run = getState();
        if (run?.status === 'completed' && this.$('runMode').value !== RUN_MODE.EQUIPMENT_CHANGE) {
          this.syncModeUi();
          this.reuseLastFolder({ auto: true });
          return;
        }
        if (run?.status === 'draft') {
          run.runMode = this.$('runMode').value;
          if (transfer) run.orderKind = 'pdi';
          if (isRustDispatchMode(run)) run.orderKind = 'rust';
          reconcileItemValidation(run);
          saveState(run);
          this.refresh();
          return;
        }
        this.syncModeUi();
      };
      this.$('orderKind').onchange = () => {
        this.$('preWrap').hidden = this.$('orderKind').value !== 'pdi';
        this.syncModeUi();
        const run = getState();
        if (run?.status === 'completed') {
          this.reuseLastFolder({ auto: true });
          return;
        }
        if (run?.status === 'draft') {
          Object.assign(run, uiKindToRun(this.$('orderKind').value));
          saveState(run);
          this.refresh();
        }
      };
      this.$('preType').onchange = () => {
        const run = getState();
        if (run?.status === 'draft') {
          run.preInspectionType = this.$('preType').value;
          saveState(run);
        }
      };
      this.$('transferTarget').oninput = () => {
        const run = getState();
        if (run && ['draft', 'paused'].includes(run.status)) {
          run.transferTarget = this.$('transferTarget').value;
          const item = run.items?.[run.currentIndex];
          if (run.status === 'paused' && item?.stage === 'failed' && item.orderId) {
            item.stage = 'created';
            item.error = '';
          }
          saveState(run);
        }
      };
      this.$('dispatchTarget').oninput = () => {
        const run = getState();
        if (run?.status === 'draft') {
          run.dispatchTarget = this.$('dispatchTarget').value;
          delete run.dispatchPersonnel;
          saveState(run);
        }
      };
      this.$('forceNew').onchange = () => {
        const run = getState();
        if (run && ['draft', 'paused'].includes(run.status)) {
          run.forceCreateNew = this.$('forceNew').checked;
          discardReusableOrdersForForceNew(run);
          saveState(run);
          this.refresh();
        }
      };
      this.$('version').onclick = () => this.checkUpdate({ manual: true });
      this.$('loadOptions').onclick = () => this.loadOptions();
      const ecConfig = loadEcConfig();
      for (const key of EC_FIELDS) {
        this.$(key).value = ecConfig[key] ?? '';
        this.$(key).onchange = () => saveEcConfig(this.readEcConfig());
      }
      this.$('ecStart').onclick = () => this.startEquipmentChange();
      this.$('pick').onclick = () => this.pickFolder();
      this.$('reuseFolder').onclick = () => this.reuseLastFolder();
      this.$('start').onclick = () => this.start();
      this.$('pause').onclick = () => {
        const run = getState();
        if (!run || run.status !== 'running') {
          this.log('当前没有正在运行的任务');
          return;
        }
        pauseRequested = true;
        saveState({ ...run, status: 'paused' });
        this.log(resuming ? '正在暂停：当前操作会在下一次检查时立即停止…' : '已暂停');
        this.refresh();
      };
      this.$('reauthorize').onclick = () => this.reauthorize();
      this.$('skip').onclick = () => this.skipCurrent();
      this.$('reset').onclick = () => {
        if (!confirm('清除当前批量任务和进度？不会删除 D365 中已创建的订单或附件。')) return;
        clearState();
        this.log('本地任务进度已清除');
        this.refresh();
      };
    }

    async checkUpdate({ manual = false } = {}) {
      const button = this.$('version');
      if (this.checkingUpdate) return;
      this.checkingUpdate = true;
      if (manual) {
        button.textContent = '检查中…';
        this.log(`正在检查更新（当前 v${SCRIPT_VERSION}）…`);
      }
      try {
        const latest = await fetchLatestVersion();
        try { localStorage.setItem(UPDATE_CHECK_KEY, String(Date.now())); } catch { /* 忽略 */ }
        if (compareVersions(latest, SCRIPT_VERSION) <= 0) {
          button.textContent = `v${SCRIPT_VERSION}`;
          button.classList.remove('new');
          button.title = '已是最新版本，点击可再次检查';
          if (manual) this.log(`已是最新版本 v${SCRIPT_VERSION}`);
          return;
        }
        button.textContent = `v${SCRIPT_VERSION} → v${latest}`;
        button.classList.add('new');
        button.title = `发现新版本 v${latest}，点击更新`;
        if (!manual) {
          this.log(`发现新版本 v${latest}，点击标题栏的版本号即可更新`);
          return;
        }
        const run = getState();
        if (run?.status === 'running') {
          this.log(`发现新版本 v${latest}。任务正在运行，请先点“暂停”，再点版本号更新`);
          return;
        }
        if (!confirm(`发现新版本 v${latest}（当前 v${SCRIPT_VERSION}）。\n\n点击“确定”后会打开油猴的更新页面，请在那里点“更新”，然后刷新 D365 页面。`)) return;
        this.log(`正在打开油猴更新页面（v${latest}）…`);
        window.open(UPDATE_URL, '_blank');
      } catch (error) {
        button.textContent = `v${SCRIPT_VERSION}`;
        if (manual) this.log(`检查更新失败：${error.message}`);
      } finally {
        this.checkingUpdate = false;
      }
    }

    readEcConfig() {
      return Object.fromEntries(EC_FIELDS.map((key) => [key, String(this.$(key).value || '').trim()]));
    }

    async startEquipmentChange() {
      const existing = getState();
      if (existing && ['running', 'paused'].includes(existing.status)) {
        this.log('当前还有未完成的任务，请先完成或点“清除任务”');
        return;
      }
      const config = this.readEcConfig();
      saveEcConfig(config);
      const items = parseMachineLines(this.$('ecMachines').value);
      if (!items.length) {
        this.log('请先在框里粘贴机号（每行一个）');
        return;
      }
      this.log('正在核对 Service Dealer、负责工程师和服务经理…');
      let settings;
      try {
        settings = await resolveEcSettings(config);
      } catch (error) {
        this.log(`设置有误：${error.message}`);
        return;
      }
      const summary = [
        `Dealer → ${ecMainDealer(settings) ? ecMainDealer(settings).name : '保持原值（不修改）'}`,
        `Service Dealer → ${settings.dealer ? settings.dealer.name : '保持原值（不修改）'}`,
        `Responsible Service Engineer → ${settings.engineer.name}`,
        `Service Manager → ${settings.manager.name}`,
        `Current working time → ${settings.hours}（机号后写了工时的按各自的）`,
        `Change Remarks → ${settings.remark}`,
        `Equipment Type → ${settings.equipmentType ? ecTypeLabel(settings.equipmentType) : '保持原值'}`,
        `Warranty Policy Value → ${Number.isInteger(settings.warrantyValue) ? settings.warrantyValue : '保持原值'}，Warranty Policy Month → ${Number.isInteger(settings.warrantyMonth) ? settings.warrantyMonth : '保持原值'}`,
        `为空时填：Usage = ${settings.usage || '不填'}，Address = ${settings.address || '不填'}，Model = ${settings.model || '不填'}`,
      ].join('\n');
      if (!confirm(`将为 ${items.length} 台设备新建（或继续未提交的）设备变更单并提交审批：\n\n${summary}\n\n确认继续？`)) return;
      pauseRequested = false;
      saveState({
        version: 1,
        status: 'running',
        runMode: RUN_MODE.EQUIPMENT_CHANGE,
        orderKind: 'equipmentChange',
        folderName: '设备变更',
        ecSettings: settings,
        currentIndex: 0,
        items,
        stallReloads: {},
        createdAt: new Date().toISOString(),
      });
      this.log(`设备变更任务已开始，共 ${items.length} 台`);
      this.refresh();
      resumeRun(this);
    }

    async loadOptions() {
      try {
        this.log('正在读取 D365 预验收类型…');
        const field = await metadata.picklistByLabel(
          ORDER_ENTITY,
          ['预验收类型', 'PDI Type', 'Pre-Inspection Type', 'Pre-inspection Type'],
        );
        const labels = (field.OptionSet?.Options || []).map(optionLabel).filter(Boolean);
        this.$('preType').innerHTML = labels.map((x) => `<option>${escapeHtml(x)}</option>`).join('');
        const preferred = [...this.$('preType').options].find((x) => x.value === '到港预验收');
        if (preferred) this.$('preType').value = preferred.value;
        this.log(`已加载 ${labels.length} 个预验收类型`);
      } catch (error) {
        this.log(`加载选项失败：${error.message}`);
      }
    }

    async pickFolder() {
      try {
        if (!window.showDirectoryPicker) throw new Error('当前浏览器不支持文件夹授权，请使用最新版 Chrome/Edge');
        const run = getState();
        if (run?.status === 'running') throw new Error('任务正在运行，请先暂停或等它完成');
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        const handleKey = `root:${Date.now()}`;
        await storeHandle(handleKey, handle);
        saveLastFolder(handleKey, handle.name);
        await this.prepareFromHandle(handle, handleKey);
      } catch (error) {
        if (error.name !== 'AbortError') this.log(`选择文件夹失败：${error.message}`);
      }
    }

    // 沿用上次选择的文件夹，按当前选择的运行模式/订单类型重新扫描，生成新任务（不用重新选文件夹）。
    // auto=true 用于换功能时自动沿用：只在已有读取权限时进行，不弹授权框。
    async reuseLastFolder({ auto = false } = {}) {
      try {
        const last = loadLastFolder();
        if (!last?.handleKey) {
          if (!auto) this.log('还没有选过文件夹，请先点“选择待处理文件夹”');
          return false;
        }
        const run = getState();
        if (run && !['draft', 'completed'].includes(run.status)) {
          if (!auto) this.log(`当前任务状态为 ${run.status}，请先完成或“清除任务”后再沿用文件夹`);
          return false;
        }
        const handle = await loadHandle(last.handleKey);
        if (!handle) throw new Error('找不到上次的文件夹，请重新选择');
        let permission = await handle.queryPermission({ mode: 'read' });
        if (permission !== 'granted') {
          if (auto) {
            this.log(`换了功能：点“沿用上次文件夹”即可继续用“${last.name}”，不用重新选`);
            return false;
          }
          permission = await handle.requestPermission({ mode: 'read' });
          if (permission !== 'granted') throw new Error('未授予读取权限');
        }
        await this.prepareFromHandle(handle, last.handleKey, { reused: true });
        return true;
      } catch (error) {
        this.log(`沿用上次文件夹失败：${error.message}`);
        return false;
      }
    }

    async prepareFromHandle(handle, handleKey, { reused = false } = {}) {
      {
        const runMode = this.$('runMode').value;
        const { orderKind, pdiDealer, pdiShipment, chainMode } = uiKindToRun(this.$('orderKind').value);
        const scanned = await scanRoot(handle, runMode, orderKind);
        const items = chainMode ? expandChainItems(scanned) : scanned;
        saveState({
          version: 1,
          status: 'draft',
          handleKey,
          folderName: handle.name,
          runMode,
          orderKind,
          pdiDealer,
          pdiShipment,
          chainMode,
          preInspectionType: runPreType({ pdiDealer, pdiShipment }, this.$('preType').value),
          transferTarget: this.$('transferTarget').value.trim(),
          dispatchTarget: this.$('dispatchTarget').value.trim(),
          forceCreateNew: this.$('forceNew').checked,
          currentIndex: 0,
          items,
          createdAt: new Date().toISOString(),
        });
        const single = scanned.length === 1 && scanned[0].dirName === SINGLE_DIR;
        this.log(`${reused ? '沿用' : '已扫描'}文件夹“${handle.name}”，${single ? '按单台机处理' : `找到 ${scanned.length} 个机号`}（${kindLabel({ orderKind, pdiDealer, pdiShipment, chainMode })}）${chainMode ? `，展开为 ${items.length} 步` : ''}`);
        if (!items.length) this.log('提示：请选包含“机台号_机型_吨位_工作时间”子文件夹的上一层文件夹，或者直接选单台机的文件夹');
        const badFormat = items.filter((item) => !item.folderFormatOk).map((item) => (item.dirName === SINGLE_DIR ? handle.name : item.dirName));
        if (badFormat.length) {
          this.log(`注意：${badFormat.length} 个文件夹不是“机台号_机型_吨位_工作时间”格式，已取第一段作为机台号：${badFormat.join('、')}`);
        }
        const seen = new Map();
        for (const item of items) seen.set(item.machineNo, [...(seen.get(item.machineNo) || []), item.dirName]);
        for (const [machineNo, dirs] of seen) {
          if (dirs.length > 1) this.log(`警告：机台号 ${machineNo} 对应多个文件夹（${dirs.join('、')}），会重复处理同一设备，请核对`);
        }
        this.refresh();
      }
    }

    async start() {
      const run = getState();
      if (!run) return;
      run.runMode = this.$('runMode').value;
      Object.assign(run, uiKindToRun(this.$('orderKind').value));
      run.preInspectionType = runPreType(run, this.$('preType').value);
      if (run.chainMode && !run.items.some((x) => x.chainKind)) {
        return this.log('这个任务是按单个功能扫描的，请重新点“选择待处理文件夹”或“沿用上次文件夹”生成全流程任务');
      }
      if (run.chainMode) applyChainStep(run, run.items[run.currentIndex] || run.items[0]);
      run.transferTarget = this.$('transferTarget').value.trim();
      run.dispatchTarget = this.$('dispatchTarget').value.trim();
      run.forceCreateNew = this.$('forceNew').checked;
      if (run.handoverFromPdi) {
        const dateText = this.$('handoverDate').value;
        const chosen = handoverDateLocal(dateText);
        if (dateText && !chosen) return this.log(`交机日期“${dateText}”格式不对`);
        if (chosen && chosen > new Date(new Date().setHours(23, 59, 59, 999))) return this.log(`交机日期 ${dateText} 在今天之后，交机日期不能是未来的日子`);
        run.handoverDate = chosen ? dateText : '';
        run.items.forEach((x) => { x.handoverDate = run.handoverDate; });
      }
      if (run.pdiShipment && run.items.some((x) => x.orderNumberInput)) {
        run.shipmentDescription = this.$('shipDesc').value; // 生成任务后又改了 Description，以开始时为准
      } else if (run.pdiShipment && isTransferMode(run)) {
        return this.log('Shipment PDI 现在按单号派：请在框里贴单号，点“按单号生成任务”');
      }
      if (isTransferMode(run)) {
        run.orderKind = 'pdi';
        if (!run.transferTarget) return this.log('请填写“转移给”');
        if (!run.pdiDealer && run.preInspectionType === DEALER_PDI_PRE_TYPE) run.pdiDealer = true;
        if (!run.pdiShipment && !run.pdiDealer && run.preInspectionType === SHIPMENT_PDI_PRE_TYPE) run.pdiShipment = true;
        if (run.pdiDealer) {
          try {
            run.dealerAssignee = await findDispatchPersonnel(run.transferTarget);
          } catch (error) {
            return this.log(`派单对象无法确认：${error.message}`);
          }
          this.log(`经销商 PDI 派单对象：${run.dealerAssignee.name}`);
        }
      }
      if (isRustDispatchMode(run)) {
        run.orderKind = 'rust';
        if (!run.dispatchTarget) return this.log('请填写“派给”');
        try {
          run.dispatchPersonnel = await findDispatchPersonnel(run.dispatchTarget);
        } catch (error) {
          return this.log(`派单对象无法确认：${error.message}`);
        }
        this.log(`派单对象：${run.dispatchPersonnel.name}`);
      }
      if (await rescanRun(run)) this.log('已按当前规则重新扫描照片文件夹');
      reconcileItemValidation(run);
      const valid = run.items.filter((x) => x.stage !== 'invalid');
      if (!valid.length) return this.log('没有可执行的机号');
      const action = isRustDispatchMode(run)
        ? `检查本月防锈运转：已做过的跳过；本月状态为 Created 且没有可操作按键的防锈单，派给“${run.dispatchPersonnel.name}”`
        : isTransferMode(run)
        ? (run.pdiShipment && run.items.some((x) => x.orderNumberInput)
          ? `按单号处理 Shipment PDI：确认是出库预验收单 → ${String(run.shipmentDescription || '').trim() ? '写入 Description' : 'Description 留空不改'} → 服务转移给“${run.transferTarget}”`
          : run.pdiDealer
          ? `${run.forceCreateNew ? '直接新建' : '创建或复用'}经销商 PDI（代理商入库预验收）订单，并用 Assign 派单给“${run.dealerAssignee?.name || run.transferTarget}”（经销商 PDI 没有服务转移）`
          : `${run.forceCreateNew ? '直接新建' : '创建或复用'} PDI 订单，并永久转派给“${run.transferTarget}”`)
        : run.orderKind === 'handover'
          ? `打开或新建交机单（没有 PDI 或 PDI 里没有 Service Ticket 的跳过；已到现场完工/提交审核/已完成的跳过），执行交机日期、接受/出发/到达、Assessment Pass、无需培训、Check Passed、工作小时、四张照片、PDI 的 Service Ticket、现场完工和提交审核${run.handoverFromPdi ? `。交机日期 = ${run.handoverDate || '今天'}；四张照片和工作小时都从这台机的 PDI 里拿（机号后写了工时的用写的）` : ''}`
        : run.chainMode
          ? '按机号依次做：到港 PDI（已有的单，全自动接受/出发/到达/照片/现场完工/Service Ticket/提交审核）→ 防锈（本月做过就跳过，没有就新建）→ 经销商 PDI（只做经销商设备；没有就新建并派给当前账号）。已完成/提交审核的步骤自动跳过，三步共用同一套照片'
        : run.orderKind === 'rust'
          ? '检查本月防锈订单：现场完工/提交审核/已完成 的跳过，其他状态的打开继续完成，没有的新建；然后填写工作小时、上传照片（文件夹有 5 号照片按 5 张：3、4 为工时照，5 为其他；否则按 4 张）、检查 Usable/机型/吨位/保修期、现场完工并提交审核'
          : `打开已有且未取消的${run.pdiDealer ? '经销商 PDI（代理商入库预验收）' : ' PDI '}订单，并全自动执行接受、出发、到达、附件、Usable/机型/吨位、工作小时、现场完工、Service Ticket 和提交审核`;
      if (!confirm(`将为 ${valid.length} 个机号${action}。确认继续？`)) return;
      pauseRequested = false;
      run.status = 'running';
      run.stallReloads = {};
      saveState(run);
      this.log('任务已开始');
      this.refresh();
      resumeRun(this);
    }

    async reauthorize() {
      try {
        const run = getState();
        if (!run) throw new Error('没有可继续的任务');
        if (!isEquipmentChangeMode(run) && !run.handoverFromPdi && !run.items?.some((x) => x.orderNumberInput)) {
          const handle = await loadHandle(run.handleKey);
          if (!handle) throw new Error('找不到原文件夹句柄，请重新选择文件夹');
          const permission = await handle.requestPermission({ mode: 'read' });
          if (permission !== 'granted') throw new Error('未授予读取权限');
          if (await rescanRun(run)) this.log('已按当前规则重新扫描照片文件夹');
        }
        pauseRequested = false;
        run.status = 'running';
        run.stallReloads = {};
        saveState(run);
        this.log('文件夹权限已恢复，继续任务');
        resumeRun(this);
      } catch (error) {
        this.log(`重新授权失败：${error.message}`);
      }
    }

    skipCurrent() {
      const run = getState();
      if (!run || run.status !== 'paused') {
        this.log('请先暂停任务，再跳过当前单');
        return;
      }
      const item = run.items?.[run.currentIndex];
      if (!item) {
        this.log('没有可跳过的当前单');
        return;
      }
      if (!confirm(`跳过机号“${item.machineNo}”？已创建的 D365 订单会保留，不会删除。`)) return;
      item.stage = 'skipped';
      item.error = '';
      item.skippedAt = new Date().toISOString();
      run.currentIndex += 1;
      pauseRequested = false;
      run.status = run.currentIndex >= run.items.length ? 'completed' : 'running';
      saveState(run);
      this.log(`${item.machineNo}：已跳过，D365 中已有订单保持不变`);
      this.refresh();
      if (run.status === 'running') resumeRun(this);
    }

    refresh() {
      const last = loadLastFolder();
      const run = getState();
      this.$('reuseRow').hidden = !last?.handleKey || isEquipmentChangeMode(run || { runMode: this.$('runMode').value })
        || ['handover-pdi', 'pdi-shipment'].includes(this.$('orderKind').value);
      if (last?.name) this.$('reuseFolder').textContent = `沿用上次文件夹：${last.name}`;
      if (!run) {
        this.$('summary').textContent = '尚未选择文件夹';
        this.$('list').innerHTML = '';
        this.$('start').disabled = true;
        this.$('skip').disabled = true;
        this.$('forceNew').checked = isTestEnvironment();
        this.syncModeUi();
        return;
      }
      if (run.forceCreateNew == null) {
        run.forceCreateNew = isTestEnvironment();
        discardReusableOrdersForForceNew(run);
        saveState(run);
      }
      run.runMode ||= RUN_MODE.FULL;
      reconcileItemValidation(run);
      this.$('runMode').value = run.runMode;
      if (isTransferMode(run)) run.orderKind = 'pdi';
      if (isRustDispatchMode(run)) run.orderKind = 'rust';
      this.$('orderKind').value = runUiKind(run);
      this.$('forceNew').checked = Boolean(run.forceCreateNew);
      this.$('transferTarget').value = run.transferTarget || '';
      this.$('dispatchTarget').value = run.dispatchTarget || '';
      this.syncModeUi();
      const valid = run.items.filter((x) => !['invalid', 'skipped'].includes(x.stage)).length;
      const done = run.items.filter((x) => x.stage === 'done').length;
      const skipped = run.items.filter((x) => x.stage === 'skipped').length;
      const modeText = isEquipmentChangeMode(run)
        ? '粘贴机号逐台处理'
        : isRustDispatchMode(run)
        ? '只处理已创建订单'
        : isTransferMode(run)
        ? (run.forceCreateNew ? '始终新建' : '创建或复用')
        : run.orderKind === 'rust' ? '按月检查并按需新建' : run.orderKind === 'handover' ? '没有交机单就新建' : '仅打开已有订单';
      const runModeText = isEquipmentChangeMode(run)
        ? `Service Dealer→${run.ecSettings?.dealer?.name || ''}`
        : isRustDispatchMode(run)
        ? `防锈派单→${run.dispatchPersonnel?.name || run.dispatchTarget || '未填写'}`
        : isTransferMode(run)
        ? `服务转移→${run.transferTarget || '未填写'}`
        : run.orderKind === 'rust' ? '防锈完工并提交审核' : run.orderKind === 'handover' ? '交机并提交审核' : '到达并上传';
      this.$('summary').textContent = `${run.folderName} · ${kindLabel(run)} · ${runModeText} · ${modeText} · 可处理 ${valid} · 已完成 ${done} · 已跳过 ${skipped} · 状态 ${run.status}`;
      this.$('list').innerHTML = run.items.map((item) => {
        const cls = item.stage === 'done' ? 'ok' : item.stage === 'skipped' ? 'skip' : item.stage === 'invalid' || item.stage === 'failed' ? 'bad' : 'run';
        const stageLabels = {
          'pdi-general-info': '正在填写 Usable / 机型 / 吨位',
          'rust-hours': '正在填写工作小时',
          'pdi-hours': '正在填写工作小时',
          'rust-fields': '正在检查并写入订单字段',
          'pdi-fields': '正在检查并写入订单字段',
          'pdi-on-site-completing': '正在自动执行现场完工',
          'pdi-completing': '正在自动现场完工并处理 Service Ticket',
          'pdi-approval-submitting': '正在提交审核',
          'rust-on-site-completing': '正在执行防锈现场完工',
          'rust-completing': '正在执行防锈现场完工',
          'rust-approval-submitting': '正在提交防锈审核',
          'dispatch-checking': '正在检查订单和按键',
          'ec-creating': '正在新建设备变更单',
          'ec-filling': '正在填写设备变更单',
          'ec-submitting': '正在提交审批',
          'handover-preparing': '正在设置设备位置、出发、Assessment Pass、到达',
          'handover-fields': '正在写入交机检查项和工作小时',
          'handover-completing': '正在现场完工并提交审核',
          'dispatch-submitting': '正在提交派单',
        };
        const detail = item.stage === 'skipped'
          ? item.skipReason || '已跳过'
          : item.stage === 'done' && item.ecRequestNo
            ? `${item.ecRequestNo} 已提交${item.ecSubmittedStatus ? `（${item.ecSubmittedStatus}）` : ''}`
          : item.stage === 'done' && item.dispatchedTo
            ? `${item.orderNo || ''} 已派给 ${item.dispatchedTo}`
          : item.missing?.length
            ? `缺少 ${item.missing.join(', ')}`
            : item.error || stageLabels[item.stage] || item.stage;
        const meta = [item.equipmentModel, item.tonnage, Number.isFinite(workingHoursValue(item)) && `${workingHoursValue(item)}h`]
          .filter(Boolean).join(' · ');
        const metaHtml = meta ? ` <span class="meta">${escapeHtml(meta)}</span>` : '';
        const stepHtml = item.chainLabel ? ` <span class="meta">[${escapeHtml(item.chainLabel)}]</span>` : '';
        return `<div class="item"><b>${escapeHtml(item.machineNo)}</b>${stepHtml}${metaHtml} <span class="${cls}">${escapeHtml(detail)}</span></div>`;
      }).join('');
      this.$('start').disabled = run.status !== 'draft' || !valid;
      this.$('skip').disabled = run.status !== 'paused'
        || !run.items?.[run.currentIndex];
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  let resuming = false;
  // ===== 界面语言 =====
  // 脚本是按英文界面写的（按键、弹窗、附件表格的文字）。账号语言被改成中文等其他语言后，
  // 很多地方会认不出来而卡住。所以开始/继续任务时，先通过 D365 接口读取当前账号的界面语言
  // （usersettings.uilanguageid，1033 = English），不是英文就征得同意后用接口改成英文并刷新页面，
  // 刷新后任务会自动接着跑。之后可在 D365 右上角“设置 → 个性化设置 → 语言”改回去。
  const ENGLISH_LCID = 1033;
  async function currentUiLanguage() {
    const { data } = await api(`usersettingscollection(${await currentUserId()})?$select=uilanguageid`);
    return Number(data.uilanguageid);
  }

  // 返回 true 表示已切换语言、页面即将刷新，调用方应停止当前流程。
  async function ensureEnglishUi(run, panel) {
    let lcid;
    try {
      lcid = await currentUiLanguage();
    } catch (error) {
      panel?.log(`读取界面语言失败（${error.message}），按当前界面继续`);
      return false;
    }
    if (lcid === ENGLISH_LCID || run.englishUi === false) return false;
    if (run.englishUi !== true) {
      run.englishUi = confirm(
        `当前账号的 D365 界面语言不是英文（语言代码 ${lcid}）。\n`
        + '脚本是按英文界面识别按键和弹窗的，其他语言下可能卡住。\n\n'
        + '是否把这个账号的界面语言改成英文并刷新页面？刷新后任务会自动继续。\n'
        + '（之后可在 设置 → 个性化设置 → 语言 改回）',
      );
      saveState(run);
      if (!run.englishUi) {
        panel?.log('已选择保持当前界面语言继续（非英文界面下部分步骤可能卡住）');
        return false;
      }
    }
    await api(`usersettingscollection(${await currentUserId()})`, {
      method: 'PATCH',
      body: JSON.stringify({ uilanguageid: ENGLISH_LCID }),
    });
    panel?.log(`已把账号界面语言从 ${lcid} 改为英文（1033），刷新页面后继续任务…`);
    await sleep(1000);
    location.reload();
    return true;
  }

  async function resumeRun(panel) {
    if (resuming) return;
    resuming = true;
    try {
      let run = getState();
      if (!run || run.status !== 'running') return;
      if (await ensureEnglishUi(run, panel)) return;
      run = getState();
      if (discardReusableOrdersForForceNew(run)) saveState(run);
      while (run.currentIndex < run.items.length) {
        run = getState();
        if (!run || run.status !== 'running') break;
        const item = run.items[run.currentIndex];
        if (['invalid', 'done', 'skipped'].includes(item.stage)) {
          run.currentIndex += 1;
          saveState(run);
          continue;
        }
        if (applyChainStep(run, item)) {
          saveState(run);
          panel.log(`${item.machineNo}：全流程进入“${item.chainLabel}”`);
        }
        try {
          if (isRustDispatchMode(run)) {
            const outcome = await processRustDispatchItem(run, item, panel);
            if (outcome === 'navigated') return;
            continue;
          }
          if (isEquipmentChangeMode(run)) {
            const outcome = await processEquipmentChangeItem(run, item, panel);
            if (outcome === 'navigated') return;
            continue;
          }
          let model = null;
          // 0.7.12 之前防锈会缓存任意月份的已有订单。升级后清除这种旧缓存，
          // 重新按“本月 In Approval / Completed，否则新建”的规则判断一次。
          if (run.orderKind === 'rust' && item.orderId && item.existing
            && !item.rustMonthlyRuleApplied) {
            item.orderId = null;
            item.existing = false;
            item.stage = 'pending';
            item.uploaded = [];
            item.error = '';
            saveState(run);
          }
          if (item.orderId && item.existing) {
            model = await resolveModel(TYPE_CONFIG[run.orderKind]);
            if (await existingOrderIsCancelled(item.orderId, model)) {
              panel.log(isTransferMode(run)
                ? `${item.machineNo}：缓存订单已取消，跳过并重新创建`
                : `${item.machineNo}：缓存订单已取消，重新查找其他已有订单`);
              item.orderId = null;
              item.existing = false;
              item.stage = 'pending';
              saveState(run);
            }
          }
          if (!item.orderId) {
            panel.log(isTransferMode(run)
              ? `${item.machineNo}：查询设备并创建或复用 PDI 订单…`
              : run.orderKind === 'rust'
                ? `${item.machineNo}：检查本月防锈订单（现场完工/提交审核/已完成 才跳过）…`
                : run.orderKind === 'handover'
                  ? `${item.machineNo}：查找交机单，并确认 PDI 订单和 Service Ticket…`
                  : `${item.machineNo}：查询设备并查找已有订单…`);
            model ||= await resolveModel(TYPE_CONFIG[run.orderKind]);
            const result = await resolveOrderForItem(item, run, model);
            if (result.skipReason) {
              item.stage = 'skipped';
              item.error = '';
              item.skipReason = result.skipReason;
              item.skippedAt = new Date().toISOString();
              run.currentIndex += 1;
              saveState(run);
              panel.log(`${item.machineNo}：${result.skipReason}，跳过`);
              panel.refresh();
              continue;
            }
            if (result.skipCurrentMonth) {
              item.stage = 'skipped';
              item.error = '';
              item.skipReason = `本月防锈订单已是 ${result.matchedStatus || '现场完工/提交审核/已完成'}`;
              item.skippedAt = new Date().toISOString();
              item.matchedOrderId = result.orderId;
              item.rustMonthlyRuleApplied = true;
              run.currentIndex += 1;
              saveState(run);
              panel.log(`${item.machineNo}：本月防锈订单已是 ${result.matchedStatus || '现场完工/提交审核/已完成'}，直接跳过`);
              panel.refresh();
              continue;
            }
            if (result.skipDuplicateRust) {
              const conflictLabel = result.conflictingOrderNumber
                ? `已有同类型订单 ${result.conflictingOrderNumber}`
                : 'D365 已存在同类型防锈订单';
              item.stage = 'skipped';
              item.error = '';
              item.skipReason = conflictLabel;
              item.skippedAt = new Date().toISOString();
              item.matchedOrderId = result.orderId || null;
              item.rustMonthlyRuleApplied = true;
              run.currentIndex += 1;
              saveState(run);
              panel.log(`${item.machineNo}：${conflictLabel}，不重复创建，直接跳过`);
              panel.refresh();
              continue;
            }
            item.orderId = result.orderId;
            item.existing = result.existing;
            item.orderNumber = result.orderNumber || item.orderNumber || '';
            item.matchedStatus = result.matchedStatus || '';
            if (result.pdiOrderId) {
              item.pdiOrderId = result.pdiOrderId;
              item.pdiOrderNumber = result.pdiOrderNumber;
            }
            item.reusedAfterCreateConflict = Boolean(result.reusedAfterCreateConflict);
            item.resumeAsPdiWorkflow = Boolean(result.openAsPdiWorkflow);
            if (item.resumeAsPdiWorkflow) {
              item.missing = FILE_RULES
                .filter((rule) => !(item.files || []).includes(rule.name))
                .map((rule) => rule.name);
              if (item.missing.length) {
                throw new Error(`已打开已有 PDI，但照片文件夹缺少 ${item.missing.join(', ')}`);
              }
            }
            if (run.orderKind === 'rust') item.rustMonthlyRuleApplied = true;
            item.stage = 'created';
            saveState(run);
            if (item.orderNumberInput) {
              panel.log(`${item.machineNo}：订单设备 ${item.equipmentName || '未知'}${item.descriptionWritten ? '，已写入 Description' : '，Description 没填，不修改'}`);
            }
            panel.log(`${item.machineNo}：${result.reusedAfterCreateConflict
              ? 'D365 提示已有 PDI，改为打开已有'
              : result.existing ? '已找到并打开已有' : '已创建'}订单 ${item.orderNumber || item.orderId}${result.existing && run.orderKind === 'rust' && result.matchedStatus ? `（状态 ${result.matchedStatus}，继续完成）` : ''}${result.pdiOrderNumber ? `（PDI ${result.pdiOrderNumber} 有 Service Ticket）` : ''}`);
          }

          if (isTransferItem(run, item) && run.pdiDealer) {
            await assignDealerPdi(run, item, panel);
            continue;
          }

          // 已有的到港预验收订单：先用 API 看负责人，已经不是自己就说明转移过了，直接跳过。
          if (isTransferItem(run, item) && (item.existing || item.stage === 'transfer-submitting')) {
            const check = await transferPrecheck(item);
            if (!check.ownedByMe) {
              const submitted = item.stage === 'transfer-submitting';
              item.stage = submitted ? 'done' : 'skipped';
              item.error = '';
              if (!submitted) {
                item.skipReason = `已有到港预验收订单 ${item.orderNumber}，负责人已是 ${check.ownerName}（状态 ${check.status}），不需要再服务转移`;
                item.skippedAt = new Date().toISOString();
              }
              run.currentIndex += 1;
              saveState(run);
              panel.log(`${item.machineNo}：${submitted
                ? `服务转移已生效，订单 ${item.orderNumber} 负责人为 ${check.ownerName}`
                : `${item.skipReason}，跳过`}`);
              panel.refresh();
              continue;
            }
            if (item.existing) {
              panel.log(`${item.machineNo}：已有到港预验收订单 ${item.orderNumber}（状态 ${check.status}），负责人还是自己，继续服务转移`);
            }
          }

          // 打开页面前先用 API 判断是否已审批：已审批的单不再打开页面、等待命令栏。
          if (!isTransferItem(run, item) && await orderApprovedViaApi(run, item)) {
            item.stage = 'skipped';
            item.error = '';
            item.skipReason = `Approval Status = Approved，${run.orderKind === 'rust' ? '防锈' : 'PDI'}已完成`;
            item.skippedAt = new Date().toISOString();
            delete item.pdiPhase;
            run.currentIndex += 1;
            saveState(run);
            panel.log(`${item.machineNo}：API 显示 Approval Status 为 Approved，跳过并继续下一单`);
            panel.refresh();
            continue;
          }

          const currentId = normalizeGuid(new URLSearchParams(location.search).get('id'));
          if (currentId !== normalizeGuid(item.orderId)) {
            item.stage = 'opening';
            saveState(run);
            location.href = recordUrl(item.orderId, TYPE_CONFIG[run.orderKind]?.formId);
            return;
          }

          let initialOrderState = null;
          if (!isTransferItem(run, item)) {
            panel.log(`${item.machineNo}：等待${run.orderKind === 'rust' ? '防锈' : ' PDI'}页面和功能键加载，并检查 Approval Status…`);
            initialOrderState = await waitForOrderInitialCommandState();
            if (initialOrderState === 'already-approved' || isPdiApprovedUi()) {
              item.stage = 'skipped';
              item.error = '';
              item.skipReason = `Approval Status = Approved，${run.orderKind === 'rust' ? '防锈' : 'PDI'}已完成`;
              item.skippedAt = new Date().toISOString();
              delete item.pdiPhase;
              run.currentIndex += 1;
              saveState(run);
              panel.log(`${item.machineNo}：Approval Status 为 Approved，跳过并继续下一单`);
              panel.refresh();
              continue;
            }
          }

          if (isTransferItem(run, item)) {
            panel.log(`${item.machineNo}：等待网页功能和命令栏完全加载…`);
            const transferState = await transferOrderCommandState();
            if (['already-handed-over', 'already-received'].includes(transferState)) {
              const completedMarker = transferState === 'already-handed-over' ? '交机' : '接收';
              item.stage = 'skipped';
              item.error = '';
              item.skipReason = `检测到“${completedMarker}”，判定已做过服务转移`;
              item.skippedAt = new Date().toISOString();
              run.currentIndex += 1;
              saveState(run);
              panel.log(`${item.machineNo}：检测到“${completedMarker}”功能，判定已经处理，跳过服务转移`);
              panel.refresh();
              continue;
            }
            if (transferState === 'no-transfer') {
              const status = currentRecordStatusText() || '未知';
              item.stage = 'skipped';
              item.error = '';
              item.skipReason = `订单 ${item.orderNumber || ''} 页面没有“服务转移”按键（状态 ${status}），可能已转移或当前状态不允许`;
              item.skippedAt = new Date().toISOString();
              run.currentIndex += 1;
              saveState(run);
              panel.log(`${item.machineNo}：${item.skipReason}，跳过，请人工核对`);
              panel.refresh();
              continue;
            }
            panel.log(`${item.machineNo}：搜索“${run.transferTarget}”并执行服务转移…`);
            if (item.stage !== 'transfer-submitting') {
              item.stage = 'transferring';
              item.error = '';
              saveState(run);
              panel.refresh();
            }
            await serviceTransfer(run, item, panel);
          } else if (run.orderKind === 'handover') {
            await ensureHandoverHoursFromPdi(run, item, panel);
            const outcome = await processHandoverItem(run, item, panel, initialOrderState);
            if (outcome === 'already-approved') {
              item.stage = 'skipped';
              item.error = '';
              item.skipReason = 'Approval Status = Approved，交机已完成';
              item.skippedAt = new Date().toISOString();
              run.currentIndex += 1;
              saveState(run);
              panel.log(`${item.machineNo}：交机单已审批，跳过`);
              panel.refresh();
              continue;
            }
          } else if (run.orderKind === 'pdi'
            && (item.pdiPhase === 'completion'
              || ['pdi-on-site-completing', 'pdi-completing', 'pdi-approval-submitting'].includes(item.stage))) {
            item.pdiPhase = 'completion';
            if (item.stage !== 'pdi-approval-submitting') item.stage = 'pdi-completing';
            item.error = '';
            saveState(run);
            panel.refresh();
            await finishPdiAndSubmit(run, item, panel);
          } else if (run.orderKind === 'rust'
            && ['rust-on-site-completing', 'rust-completing', 'rust-approval-submitting'].includes(item.stage)) {
            item.error = '';
            saveState(run);
            panel.refresh();
            await finishRustAndSubmit(run, item, panel);
          } else if (run.orderKind === 'rust') {
            if (item.existing) {
              await ensureRustOrderArrived(run, item, panel, initialOrderState);
            }
            panel.log(`${item.machineNo}：检查并写入 Equipment Location、Check Passed、工作小时、Usable/机型/吨位/保修期…`);
            item.stage = 'rust-fields';
            saveState(run);
            await applyRustFields(run, item, panel);
            panel.log(`${item.machineNo}：上传${photoRulesForRun(run, item).length === 5 ? '五' : '四'}张照片并改为英文类型名称…`);
            item.stage = 'uploading';
            saveState(run);
            await uploadAttachments(run, item);
            item.stage = 'rust-completing';
            saveState(run);
            await finishRustAndSubmit(run, item, panel);
          } else {
            const dealerPdi = run.orderKind === 'pdi' && Boolean(run.pdiDealer);
            panel.log(dealerPdi
              ? `${item.machineNo}：经销商 PDI 没有出发/到达，需要时先接受，然后直接上传附件并现场完工…`
              : `${item.machineNo}：等待 PDI 功能键完全加载后执行接受/出发/到达…`);
            item.stage = 'transitioning';
            saveState(run);
            await ensureArrived(run.orderKind, initialOrderState, dealerPdi);
            if (run.orderKind === 'pdi') {
              panel.log(`${item.machineNo}：${dealerPdi ? '页面已就绪' : '到达完成'}，Refresh 并等待 Accessories…`);
              await ensurePdiAccessoriesReady();
            }
            item.stage = 'uploading';
            saveState(run);
            panel.log(`${item.machineNo}：上传四张照片…`);
            await uploadAttachments(run, item);
            if (run.orderKind === 'pdi') {
              panel.log(`${item.machineNo}：附件完成，检查并写入 Usable、机型 ${item.equipmentModel}、吨位 ${item.tonnage}、Check Passed、工作小时 ${workingHoursValue(item)}…`);
              item.stage = 'pdi-fields';
              saveState(run);
              await applyOrderFields(run, item, panel, PDI_FIELD_KEYS, async () => {
                await fillGeneralInfo(run, item, panel);
                await setPdiCheckPassed();
                await fillOperatingHours(run, item, panel);
              });
              // 所需数据均已自动填写，不再暂停等待人工补录，直接进入收尾。
              item.pdiPhase = 'completion';
              item.stage = 'pdi-completing';
              item.error = '';
              saveState(run);
              panel.refresh();
              await finishPdiAndSubmit(run, item, panel);
            }
          }
          item.stage = 'done';
          delete item.pdiPhase;
          item.error = '';
          run.currentIndex += 1;
          saveState(run);
          panel.log(isTransferItem(run, item)
            ? `${item.machineNo}：永久转派完成（${item.transferResolved || run.transferTarget}）`
            : run.orderKind === 'handover'
              ? `${item.machineNo}：交机单 ${item.orderNumber || ''} 已完成：交机日期、出发/到达、检查项、工作小时、四张照片、PDI Service Ticket、现场完工和提交审核`
            : run.orderKind === 'pdi'
              ? `${item.machineNo}：Service Ticket 已上传并改名，提交审核完成`
              : `${item.machineNo}：Check Passed、工作小时、${photoRulesForRun(run, item).length} 张附件、Usable/机型/吨位/保修期、现场完工和提交审核已完成`);
          panel.refresh();
        } catch (error) {
          if (error instanceof RunPausedError || pauseRequested) {
            // 保留当前 stage，继续时从这一步重新检查；各步骤均可重复执行。
            item.error = '';
            run.status = 'paused';
            saveState(run);
            panel.log(`${item.machineNo}：已暂停（停在“${item.stage}”），点击“重新授权并继续”可从这里接着执行`);
            panel.refresh();
            break;
          }
          if (isTransferMode(run) && isHandedOverPdiCreateError(error)) {
            const message = d365ErrorMessage(error);
            item.stage = 'skipped';
            item.error = '';
            item.skipReason = '设备已交机，D365 不允许创建到货预验收';
            item.skippedAt = new Date().toISOString();
            run.currentIndex += 1;
            saveState(run);
            panel.log(`${item.machineNo}：设备已交机，无法创建 PDI，已跳过并继续下一单（${message}）`);
            panel.refresh();
            continue;
          }
          if (!['transfer-submitting', 'dealer-assign-submitting', 'pdi-approval-submitting', 'rust-approval-submitting', 'dispatch-submitting', 'pdi-on-site-completing', 'handover-completing', 'ec-submitting', 'ec-filling'].includes(item.stage)) item.stage = 'failed';
          item.error = error.message;
          run.status = 'paused';
          saveState(run);
          panel.log(`${item.machineNo}：失败并暂停：${error.message}`);
          panel.refresh();
          break;
        }
      }
      run = getState();
      if (run && run.currentIndex >= run.items.length && run.status === 'running') {
        run.status = 'completed';
        saveState(run);
        panel.log('全部可处理机号已完成');
        panel.refresh();
      }
    } finally {
      resuming = false;
    }
  }

  // ---- 自动任务运行时，拦截出发/到达弹出的 Google 地图新标签页 ----
  const GOOGLE_MAPS_URL = /(^|\/\/)([^/]*\.)?google\.[^/]+\/maps|maps\.google\.|goo\.gl\/maps|maps\.app\.goo\.gl/i;
  let mapPopupPanel = null;
  let lastMapPopupLog = 0;

  function runIsActive() {
    return getState()?.status === 'running';
  }

  function noteBlockedMapPopup(url) {
    if (Date.now() - lastMapPopupLog < 5000) return;
    lastMapPopupLog = Date.now();
    mapPopupPanel?.log(`已拦截弹出的 Google 地图页面，不打开新标签，继续工作（${String(url).slice(0, 60)}…）`);
  }

  function fakePopupWindow() {
    const noop = () => {};
    return {
      closed: true, opener: null, focus: noop, blur: noop, close: noop, postMessage: noop,
      location: { href: '', assign: noop, replace: noop },
      document: { write: noop, writeln: noop, open: noop, close: noop },
    };
  }

  function installMapPopupBlocker(win) {
    try {
      if (!win || win.__d365BatchMapBlock) return;
      win.__d365BatchMapBlock = true;
      const originalOpen = win.open;
      win.open = function patchedOpen(url, ...rest) {
        if (runIsActive() && GOOGLE_MAPS_URL.test(String(url || ''))) {
          noteBlockedMapPopup(url);
          return fakePopupWindow();
        }
        return originalOpen.call(this, url, ...rest);
      };
      win.document.addEventListener('click', (event) => {
        const link = event.target?.closest?.('a[href]');
        if (!link || !runIsActive() || !GOOGLE_MAPS_URL.test(link.href || '')) return;
        if (link.target && link.target !== '_self') {
          event.preventDefault();
          event.stopPropagation();
          noteBlockedMapPopup(link.href);
        }
      }, true);
    } catch { /* 跨域 iframe 无法处理，忽略 */ }
  }

  function installMapPopupBlockers(panel) {
    mapPopupPanel = panel;
    installMapPopupBlocker(window);
    const scan = (root) => {
      for (const frame of root.querySelectorAll('iframe')) {
        try {
          const win = frame.contentWindow;
          const doc = frame.contentDocument;
          if (!win || !doc) continue;
          installMapPopupBlocker(win);
          scan(doc);
        } catch { /* 跨域 iframe */ }
      }
    };
    // 地图窗口是动态打开的 iframe，定期给新出现的 iframe 装上拦截。
    setInterval(() => scan(document), 500);
  }

  function boot() {
    if (document.getElementById(APP_ID)) return;
    rememberCurrentAppId();
    const panel = new Panel();
    panelLog = (message) => panel.log(message);
    // 给 D365 工作台程序用：查看执行进度、送入任务。
    window.__d365BatchBridge = {
      version: SCRIPT_VERSION,
      loadJob: (job) => panel.loadJob(job),
      logText: () => panel.$('log')?.textContent?.split('\n').slice(-40).join('\n') || '',
      state: () => {
        const r = getState();
        if (!r) return null;
        return {
          status: r.status,
          runMode: r.runMode,
          orderKind: r.orderKind,
          currentIndex: r.currentIndex,
          items: (r.items || []).map((x) => ({
            machineNo: x.machineNo, stage: x.stage, error: x.error || '', orderNumber: x.orderNumber || '', skipReason: x.skipReason || '',
          })),
        };
      },
    };
    installScriptErrorAutoDismiss(panel);
    installMapPopupBlockers(panel);
    try {
      const last = Number(localStorage.getItem(UPDATE_CHECK_KEY) || 0);
      if (Date.now() - last > 6 * 60 * 60 * 1000) setTimeout(() => panel.checkUpdate(), 5000);
    } catch { /* 忽略 */ }
    const run = getState();
    if (run?.lastAutoReload) {
      panel.log(`已自动刷新并恢复：${run.lastAutoReload.reason}（累计 ${run.autoReloadCount || 1} 次）`);
      delete run.lastAutoReload;
      saveState(run);
    }
    // 0.7.31 之前 PDI 会停在“等待人工补录”，现在全自动，旧进度直接进入收尾。
    if (run?.status === 'awaiting-pdi-user') {
      const item = run.items?.[run.currentIndex];
      if (item?.stage === 'awaiting-pdi-completion') {
        item.pdiPhase = 'completion';
        item.stage = 'pdi-completing';
        item.error = '';
      }
      run.status = 'running';
      run.stallReloads = {};
      saveState(run);
      panel.log(`${item?.machineNo || '当前单'}：PDI 已改为全自动，不再等待人工补录，直接继续收尾`);
      panel.refresh();
    }
    if (run?.status === 'running') {
      panel.log('检测到未完成任务，准备继续');
      setTimeout(() => resumeRun(panel), 1500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
