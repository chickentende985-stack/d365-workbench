// D365 工作台界面
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let logic = null;
  let schema = { columns: [], funcs: [] };
  let me = { userId: '', user: '' };

  // ---------- 小工具 ----------
  let toastTimer = 0;
  function toast(text, isError = false) {
    const el = $('toast');
    el.textContent = text;
    el.className = `toast${isError ? ' err' : ''}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 8000 : 3500);
  }
  const errText = (e) => (e && (e.message || e.toString())) || '出错了';
  // 调后台：POST /api/<方法名>，参数是 JSON 数组
  async function call(name, ...args) {
    let res;
    try {
      res = await fetch(`/api/${name}`, { method: 'POST', body: JSON.stringify(args) });
    } catch (e) {
      throw new Error('连不上工作台程序（它可能已经关了），请重新打开 D365 工作台');
    }
    const j = await res.json();
    if (!j.ok) {
      const err = new Error(j.error || '出错了');
      err.needLogin = !!j.needLogin;
      if (j.needLogin) markLoggedOut(j.error);
      throw err;
    }
    return j.value;
  }
  function markLoggedOut(message) {
    const pill = $('d365Pill');
    pill.textContent = 'D365 未登录';
    pill.title = message || '';
    pill.className = 'pill pill-warn';
    $('btnLogin').hidden = false;
  }
  const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 忽略 */ } },
  };

  // ---------- 顶部状态 ----------
  async function refreshStatus() {
    const pill = $('d365Pill');
    try {
      const s = await call('d365_status');
      if (!s.loggedIn) { markLoggedOut(s.error); return; }
      me = { userId: s.userId, user: s.user };
      pill.textContent = `D365 已登录：${s.user}`;
      pill.title = '';
      pill.className = 'pill pill-ok';
      $('btnLogin').hidden = true;
    } catch (e) {
      pill.textContent = 'D365：连不上';
      pill.title = errText(e);
      pill.className = 'pill pill-err';
    }
  }

  // ---------- 自动更新 ----------
  let updateApplying = false;
  async function refreshUpdate(manual = false) {
    if (updateApplying) return;
    const bar = $('updateBar');
    const btn = $('btnCheckUpdate');
    let u;
    if (manual) { btn.disabled = true; btn.textContent = '检查中…'; }
    try {
      u = manual ? await call('update_check') : await call('update_status');
    } catch (e) {
      if (manual) toast(`检查更新失败：${errText(e)}`, true);
      return;
    } finally {
      if (manual) { btn.disabled = false; btn.textContent = '检查更新'; }
    }
    const ready = u.status === 'ready' && u.canApply;
    $('btnApplyUpdateTop').hidden = !ready;
    if (ready) $('btnApplyUpdateTop').textContent = `立即更新到 v${u.latest}`;
    if (u.status === 'downloading') {
      bar.hidden = false;
      bar.innerHTML = `正在后台下载新版本 v${h(u.latest)}…（${u.progress}%）你可以继续正常使用。`;
    } else if (u.status === 'ready') {
      bar.hidden = false;
      bar.innerHTML = `<b>新版本 v${h(u.latest)} 已准备好。</b><span class="grow"></span>
        ${u.canApply ? '<button class="btn btn-primary btn-small" id="btnApplyUpdate">重启并更新</button>' : '<span>（开发模式不能自动更新）</span>'}`;
      const btn = $('btnApplyUpdate');
      if (btn) btn.onclick = applyUpdate;
    } else {
      bar.hidden = true;
      if (manual) toast(u.status === 'latest' ? `已经是最新版 v${u.current}` : (u.error ? `检查更新失败：${u.error}` : '检查完了'), !!u.error && u.status === 'error');
    }
  }
  async function applyUpdate() {
    if (!confirm('现在重启并更新？\n程序会关掉，大约 10～20 秒后自动打开新版本（会出现一个新窗口，这个旧窗口可以关掉）。')) return;
    try {
      await call('update_apply');
      updateApplying = true;
      $('updateBar').innerHTML = '正在更新…新版本打开后，这个窗口可以关掉。';
      setTimeout(() => window.close(), 3000);
    } catch (e) { toast(errText(e), true); }
  }

  // ---------- 页签 ----------
  let currentView = 'machine';
  function showView(view) {
    currentView = view;
    for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.view === view);
    for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${view}`;
    if (view === 'progress') refreshProgress();
    if (view === 'records') refreshRecords();
  }

  // ---------- 机器查询 ----------
  function renderHistory() {
    const list = store.get('machineHistory', []);
    $('machineHistory').innerHTML = list.map((s) => `<button class="chip" data-serial="${h(s)}">${h(s)}</button>`).join('');
  }
  function remember(serial) {
    const list = store.get('machineHistory', []).filter((s) => s !== serial);
    list.unshift(serial);
    store.set('machineHistory', list.slice(0, 12));
    renderHistory();
  }

  const statusBadge = (text) => {
    const t = String(text || '').toLowerCase();
    const cls = /complet|approv|完成/.test(t) ? 'b-ok' : /reject|cancel|驳回|取消/.test(t) ? 'b-err' : 'b-muted';
    return `<span class="badge ${cls}">${h(text || '—')}</span>`;
  };

  async function queryMachine(serial) {
    serial = String(serial || '').trim().toUpperCase();
    if (!serial) return;
    $('machineInput').value = serial;
    const box = $('machineResult');
    box.className = 'empty';
    box.textContent = `正在查询 ${serial}…`;
    try {
      const r = await logic.machineReport(serial);
      if (!r.found) {
        box.innerHTML = `D365 里找不到机号 <b>${h(serial)}</b>。${r.similar.length ? `<br>相近的：${r.similar.map((s) => `<span class="link" data-serial="${h(s)}">${h(s)}</span>`).join('、')}` : ''}`;
        return;
      }
      remember(serial);
      const e = r.equipment;
      const kv = [
        ['机号', e.serial], ['机型', e.model], ['吨位', e.tonnage], ['设备状态', e.status], ['Equipment Type', e.type],
        ['销售方式', e.directSale ? '直销' : '经销商'], ['Dealer', e.dealer], ['Service Dealer', e.serviceDealer],
        ['客户', e.customer], ['实际客户', e.actualCustomer], ['当前工时', e.hours], ['交机日期', e.handoverDate],
        ['质保状态', e.warrantyStatus], ['主机质保到期', e.warrantyEnd], ['质保月数 / 数值', [e.warrantyMonth, e.warrantyValue].filter((x) => x !== '').join(' / ')],
        ['设备联系人', e.contact], ['设备地址', e.address],
      ];
      const orders = r.orders.map((o) => `
        <tr>
          <td class="mono"><span class="link" data-open="mcs_consultationorder" data-id="${o.id}">${h(o.name)}</span></td>
          <td>${h(o.type)}${o.preType ? `<br><small class="muted">${h(o.preType)}</small>` : ''}</td>
          <td>${o.active ? statusBadge(o.status) : '<span class="badge b-muted">已停用</span>'}</td>
          <td>${h(o.owner)}</td>
          <td class="mono">${h(o.created)}</td>
          <td>${o.files ? `<div class="files">${o.files.map((f) => `<span class="badge ${f.ok ? 'b-ok' : 'b-err'}">${f.ok ? '✓' : '✗'} ${h(f.label)}</span>`).join('')}</div>` : '<span class="muted">—</span>'}</td>
        </tr>`).join('');
      const changes = r.changes.map((c) => `
        <tr>
          <td class="mono"><span class="link" data-open="mcs_equipmentchangerequest" data-id="${c.id}">${h(c.name)}</span></td>
          <td>${statusBadge(c.status)}</td><td>${h(c.remark)}</td><td>${h(c.owner)}</td><td class="mono">${h(c.created)}</td>
        </tr>`).join('');
      box.className = '';
      box.innerHTML = `
        <div class="card">
          <h3>${h(e.serial)} <span class="badge ${e.directSale ? 'b-ok' : 'b-muted'}">${e.directSale ? '直销' : '经销商设备'}</span>
            <span class="link" data-open="mcs_equipment" data-id="${e.id}" style="font-size:12px;font-weight:normal">在 D365 打开</span></h3>
          ${r.duplicates > 1 ? '<div class="notice">D365 里这个机号有多条设备记录，下面显示的是第一条。</div>' : ''}
          <div class="kv">${kv.map(([k, v]) => `<div><span>${h(k)}</span><b>${h(v === '' || v == null ? '—' : v)}</b></div>`).join('')}</div>
        </div>
        <div class="card">
          <h3>订单 <span class="muted">${r.orders.length} 张（照片只查最近 6 张 PDI/交机/防锈）</span></h3>
          ${r.orders.length ? `<div class="tablewrap" style="max-height:none"><table class="grid"><thead><tr><th>单号</th><th>类型</th><th>状态</th><th>负责人</th><th>创建</th><th>照片 / Service Ticket</th></tr></thead><tbody>${orders}</tbody></table></div>` : '<div class="muted">没有订单</div>'}
        </div>
        <div class="card">
          <h3>设备变更 <span class="muted">${r.changes.length} 张</span></h3>
          ${r.changes.length ? `<div class="tablewrap" style="max-height:none"><table class="grid"><thead><tr><th>单号</th><th>状态</th><th>Change Remarks</th><th>负责人</th><th>创建</th></tr></thead><tbody>${changes}</tbody></table></div>` : '<div class="muted">没有设备变更单</div>'}
        </div>`;
    } catch (e) {
      box.className = 'empty';
      box.textContent = `查询失败：${errText(e)}`;
    }
  }

  // ---------- Excel 导入 ----------
  let excel = null; // { table, records, results, jobs, filter }

  async function login() {
    const btn = $('btnLogin');
    btn.disabled = true;
    btn.textContent = '请在弹出的 Edge 窗口里登录…';
    try {
      await call('d365_login');
      toast('D365 登录成功，之后在后台运行');
      await refreshStatus();
    } catch (e) {
      toast(`登录没有完成：${errText(e)}`, true);
    }
    btn.disabled = false;
    btn.textContent = '登录 D365';
  }

  function pickExcel() { $('excelFile').value = ''; $('excelFile').click(); }

  async function onExcelChosen() {
    const file = $('excelFile').files[0];
    if (!file) return;
    let table;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      table = await call('parse_excel', file.name, btoa(bin));
    } catch (e) { toast(`读取 Excel 失败：${errText(e)}`, true); return; }
    if (!table) return;
    const { records, unknown, missingColumns } = logic.rowsToRecords(table, schema.columns);
    excel = { table, records, results: [], jobs: [], filter: 'all', sent: new Set() };
    $('excelName').textContent = `${table.name}（工作表：${table.sheet}，${records.length} 行）`;
    const notes = [];
    if (missingColumns.length) {
      const names = missingColumns.map((k) => schema.columns.find((c) => c.key === k)?.header);
      notes.push(`<div class="notice err">表格里没有这些列：${h(names.join('、'))}。请用模板的列名（第一行是表头）。</div>`);
    }
    if (unknown.length) notes.push(`<div class="notice">这些列工作台不认识，已忽略：${h(unknown.join('、'))}</div>`);
    $('excelNotice').innerHTML = notes.join('');
    $('excelEmpty').hidden = true;
    if (missingColumns.length || !records.length) {
      $('excelTable').innerHTML = '';
      $('jobs').innerHTML = '';
      $('jobsTitle').hidden = true;
      if (!records.length) $('excelNotice').innerHTML += '<div class="notice">表格里没有数据行。</div>';
      return;
    }
    await runCheck();
  }

  async function runCheck() {
    if (!excel) return;
    logic._cache.clear();
    excel.sent = new Set();
    $('btnRecheck').disabled = true;
    $('btnExport').disabled = true;
    const bar = $('excelProgress');
    bar.hidden = false;
    bar.firstElementChild.style.width = '0%';
    // 每次重新检查都从原始表格重新取值（检查过程会规范化日期等）
    excel.records = logic.rowsToRecords(excel.table, schema.columns).records;
    excel.results = excel.records.map(() => ({ level: 'pending', messages: [], info: '' }));
    renderExcel();
    try {
      excel.results = await logic.checkAll(excel.records, schema.funcs, {
        userId: me.userId,
        onProgress: (done, total) => { bar.firstElementChild.style.width = `${Math.round((done / total) * 100)}%`; },
      });
    } catch (e) {
      toast(`检查失败：${errText(e)}`, true);
    }
    bar.hidden = true;
    excel.jobs = logic.buildJobs(excel.records, excel.results);
    $('btnRecheck').disabled = false;
    $('btnExport').disabled = false;
    renderExcel();
    renderJobs();
  }

  const LEVEL = { ok: ['b-ok', '没问题'], warn: ['b-warn', '有提醒'], error: ['b-err', '有错'], pending: ['b-muted', '检查中'] };

  function keyInfo(r) {
    const bits = [];
    if (r.hours) bits.push(`工时 ${r.hours}`);
    if (r.handoverDate) bits.push(`交机 ${r.handoverDate}`);
    if (r.orderNo) bits.push(`单号 ${r.orderNo}`);
    if (r.transferTo) bits.push(`转给 ${r.transferTo}`);
    return bits.join('｜');
  }

  function renderExcel() {
    const counts = { ok: 0, warn: 0, error: 0 };
    excel.results.forEach((x) => { if (counts[x.level] !== undefined) counts[x.level] += 1; });
    $('excelSummary').hidden = false;
    $('excelSummary').innerHTML = `
      <span class="badge b-muted">共 ${excel.records.length} 行</span>
      <span class="badge b-ok">没问题 ${counts.ok}</span>
      <span class="badge b-warn">有提醒 ${counts.warn}</span>
      <span class="badge b-err">有错 ${counts.error}（不会送去执行）</span>`;
    $('excelFilters').hidden = false;
    for (const b of $('excelFilters').querySelectorAll('.chip')) b.classList.toggle('active', b.dataset.filter === excel.filter);
    const rows = excel.records.map((r, i) => ({ r, x: excel.results[i] }))
      .filter(({ x }) => excel.filter === 'all' || x.level === excel.filter);
    $('excelTable').innerHTML = `
      <thead><tr><th>行</th><th>机号</th><th>要做的事</th><th>填写的信息</th><th>D365 里的情况</th><th>状态</th><th>问题</th></tr></thead>
      <tbody>${rows.map(({ r, x }) => `
        <tr class="r-${x.level}">
          <td>${r.rowNo}</td>
          <td class="mono">${r.machine ? `<span class="link" data-serial="${h(r.machine)}">${h(r.machine)}</span>` : '—'}</td>
          <td>${h(r.func || '—')}</td>
          <td>${h(keyInfo(r))}</td>
          <td>${h(x.info)}</td>
          <td><span class="badge ${LEVEL[x.level][0]}">${LEVEL[x.level][1]}</span></td>
          <td>${x.messages.length ? `<ul class="msg">${x.messages.map((m) => `<li>${h(m)}</li>`).join('')}</ul>` : ''}</td>
        </tr>`).join('')}</tbody>`;
  }

  function renderJobs() {
    $('jobsTitle').hidden = !excel.jobs.length;
    $('jobs').innerHTML = excel.jobs.map((job, i) => `
      <div class="job ${excel.sent.has(i) ? 'sent' : ''}">
        <div class="title">${h(job.title)}</div>
        <div class="muted">${job.lines.length} ${job.func === 'transfer|pdi-shipment' ? '张单' : '台机'}（Excel 第 ${h(job.rows.join('、'))} 行）</div>
        <pre>${h(job.lines.join('\n'))}</pre>
        ${job.needsFolder
          ? '<div class="hint">这个功能要读照片文件夹，后台执行下一版支持；现在请继续用浏览器里的油猴脚本做这几台。</div>'
          : `<div><button class="btn ${excel.sent.has(i) ? '' : 'btn-primary'}" data-job="${i}">${excel.sent.has(i) ? '已开始（再执行一次）' : '开始执行'}</button>
             ${NATIVE.has(job.func) ? `<button class="btn" data-job="${i}" data-dry="1" title="只读数据，把每一步要写什么列在日志里，不改 D365">先演练一遍（不改 D365）</button>
             <span class="muted">工作台内置操作，直接调 D365 接口</span>` : ''}</div>`}
      </div>`).join('');
  }

  async function sendJob(index, dryRun = false) {
    const job = excel.jobs[index];
    const unit = job.func === 'transfer|pdi-shipment' ? '张单' : '台机';
    if (!dryRun && !confirm(`后台开始执行：${job.title}\n共 ${job.lines.length} ${unit}。\n\n确定开始？`)) return;
    const btn = document.querySelector(`[data-job="${index}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '正在送到后台…'; }
    try {
      const res = await call('engine_load_job', {
        func: job.func, title: job.title, build: job.build || '', fields: job.fields,
      }, dryRun);
      if (!res?.ok) { toast(res?.error || '后台没有接收', true); renderJobs(); return; }
      if (!dryRun) excel.sent.add(index);
      renderJobs();
      toast(dryRun ? '开始演练：只读数据，看“执行日志”里每一步会写什么' : '已在后台开始执行，进度在“执行进度”里看');
      showView('progress');
    } catch (e) {
      toast(`送到后台失败：${errText(e)}`, true);
      renderJobs();
    }
  }

  async function exportResults() {
    const headers = ['行', '机号', '要做的事', '填写的信息', 'D365 里的情况', '状态', '问题'];
    const rows = excel.records.map((r, i) => {
      const x = excel.results[i];
      return [r.rowNo, r.machine, r.func, keyInfo(r), x.info, LEVEL[x.level][1], x.messages.join('；')];
    });
    await downloadXlsx('检查结果.xlsx', headers, rows);
  }

  async function downloadXlsx(filename, headers, rows) {
    try {
      const res = await fetch('/download/results', { method: 'POST', body: JSON.stringify({ filename, headers, rows }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(`已导出 ${filename}，在“下载”文件夹里`);
    } catch (e) { toast(`导出失败：${errText(e)}`, true); }
  }
  const STATUS_TEXT = { done: '完成', notdone: '没完成', '': '进行中' };
  const fileStamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-');

  // ---------- 执行进度 ----------
  const STAGE = {
    pending: '等待', done: '完成', skipped: '跳过', failed: '出错', created: '已建单', opening: '打开订单',
    uploading: '上传照片', transferring: '服务转移', 'transfer-submitting': '提交转移', 'ec-creating': '新建变更单',
    'ec-filling': '填写变更单', 'ec-submitting': '提交审批', 'pdi-fields': '填写 PDI', 'pdi-completing': 'PDI 收尾',
    'rust-fields': '填写防锈', 'rust-completing': '防锈收尾', 'handover-preparing': '准备交机', 'handover-fields': '填写交机',
    'handover-completing': '交机收尾', 'dispatch-checking': '检查派单', 'dispatch-submitting': '提交派单',
    'dealer-assign-submitting': 'Assign 派单', transitioning: '切换状态',
    accepting: '接单', 'setting-off': '出发', arriving: '到达', ticket: '上传 Service Ticket', submitting: '提交审核', retry: '重做',
  };
  const NATIVE = new Set(['full|handover-pdi', 'transfer|pdi-shipment']);
  const RUN = { running: ['pill-ok', '运行中'], paused: ['pill-warn', '已暂停'], completed: ['pill-muted', '已完成'], draft: ['pill-muted', '已准备，等你点开始'] };

  // 后台画面：截一张执行页面的图（不用打开窗口、不会打断执行）
  let shotLive = false;
  let shotBusy = false;
  async function refreshShot() {
    if (shotBusy) return;
    shotBusy = true;
    try {
      const s = await call('engine_screenshot');
      if (!s) { $('shotInfo').textContent = '后台执行页面还没打开'; $('shotImg').removeAttribute('src'); return; }
      $('shotImg').src = `data:image/jpeg;base64,${s.image}`;
      $('shotInfo').textContent = `${s.time} · ${s.url.slice(0, 120)}`;
    } catch (e) {
      $('shotInfo').textContent = `截图失败：${errText(e)}`;
    } finally { shotBusy = false; }
  }

  // ---------- 完成情况 / 备注 ----------
  let remarkCache = {};
  let remarkFilter = 'all';
  let lastProgress = null;
  let recordsList = [];

  // 导出当前任务：每台机的进度 + 你记的完成情况和备注
  async function exportProgress() {
    if (!lastProgress) return toast('现在没有任务可以导出', true);
    const { s, taskKey } = lastProgress;
    const headers = ['#', '机号 / 单号', '订单', '执行进度', '执行说明', '完成情况', '备注', '记录时间'];
    const rows = s.items.map((x, i) => {
      const rec = remarkCache[`${taskKey}|${x.machineNo}`] || {};
      return [i + 1, x.machineNo, x.orderNumber || '', STAGE[x.stage] || x.stage, x.error || x.skipReason || '',
        STATUS_TEXT[rec.status || autoStatus(x.stage)], rec.remark || '', rec.updatedAt || ''];
    });
    await downloadXlsx(`${s.dryRun ? '演练-' : ''}${s.title || '任务'}-结果-${fileStamp()}.xlsx`, headers, rows);
  }
  // 导出“完成记录”里当前筛选的全部记录
  async function exportRecords() {
    if (!recordsList.length) return toast('没有记录可以导出', true);
    const headers = ['记录时间', '任务', '机号 / 单号', '订单', '执行进度', '完成情况', '备注'];
    const rows = recordsList.map((r) => [r.updatedAt, r.title, r.machineNo, r.orderNumber, STAGE[r.stage] || r.stage || '',
      STATUS_TEXT[r.status || autoStatus(r.stage)], r.remark]);
    const tag = { all: '全部', notdone: '没完成', done: '完成' }[remarkFilter];
    await downloadXlsx(`完成记录-${tag}-${fileStamp()}.xlsx`, headers, rows);
  }
  function orderLink(id, no) {
    return id && !/^0{8}/.test(id) ? `<span class="link" data-open="mcs_consultationorder" data-id="${h(id)}">${h(no)}</span>` : h(no || '');
  }
  // 自己没选时跟着执行结果走：做完 = 完成；出错 / 跳过 = 没完成；还在做 = 空
  function autoStatus(stage) {
    if (stage === 'done') return 'done';
    if (stage === 'failed' || stage === 'skipped') return 'notdone';
    return '';
  }
  function remarkCells(key, info, rec) {
    const chosen = rec?.status || '';
    const status = chosen || autoStatus(info.stage);
    const data = `data-key="${h(key)}" data-info="${h(JSON.stringify(info))}"`;
    const btn = (value, text) => `<button class="mini ${status === value ? (value === 'done' ? 'on-ok' : 'on-err') : ''}" data-remark-status="${value}" ${data}
      title="${chosen === value ? '再点一次：改回跟着执行结果自动判断' : ''}">${text}</button>`;
    return `<td class="nowrap">${btn('done', '✓ 完成')} ${btn('notdone', '✗ 没完成')}
        ${status === 'notdone' ? '<div><span class="badge b-err">没完成</span></div>' : ''}
        ${chosen ? '' : status ? '<div class="muted small">自动</div>' : ''}</td>
      <td><textarea class="remark" rows="${rec?.remark ? 2 : 1}" ${data}
        placeholder="${status === 'notdone' ? '没完成的原因 / 遇到的问题' : '完成情况、遇到的问题…'}">${h(rec?.remark || '')}</textarea>
        ${rec?.updatedAt ? `<div class="muted small">${h(rec.updatedAt)} 已保存</div>` : ''}</td>`;
  }
  const remarkTimers = new Map();
  async function saveRemark(el, patch) {
    const key = el.dataset.key;
    const info = JSON.parse(el.dataset.info || '{}');
    const old = remarkCache[key] || {};
    const record = { ...info, status: old.status || '', remark: old.remark || '', ...patch };
    try {
      const saved = await call('remark_set', key, record);
      if (saved) remarkCache[key] = saved; else delete remarkCache[key];
    } catch (e) {
      toast(`备注没保存上：${errText(e)}`, true);
    }
  }
  function onRemarkClick(ev) {
    const b = ev.target.closest('[data-remark-status]');
    if (!b) return;
    const key = b.dataset.key;
    const value = b.dataset.remarkStatus;
    const status = (remarkCache[key]?.status || '') === value ? '' : value;
    saveRemark(b, { status }).then(() => {
      if (status === 'notdone') {
        const box = b.closest('tr').querySelector('textarea.remark');
        refreshRemarkViews().then(() => {
          const again = document.querySelector(`textarea.remark[data-key="${CSS.escape(key)}"]`) || box;
          if (again && !again.value) again.focus();
        });
      } else {
        refreshRemarkViews();
      }
    });
  }
  function onRemarkInput(ev) {
    const el = ev.target;
    if (!el.matches('textarea.remark')) return;
    clearTimeout(remarkTimers.get(el.dataset.key));
    remarkTimers.set(el.dataset.key, setTimeout(() => saveRemark(el, { remark: el.value }), 600));
  }
  function onRemarkBlur(ev) {
    const el = ev.target;
    if (!el.matches('textarea.remark')) return;
    clearTimeout(remarkTimers.get(el.dataset.key));
    saveRemark(el, { remark: el.value }); // 不马上重画：用户可能正要点同一行的“完成 / 没完成”
  }
  async function refreshRemarkViews() {
    if (currentView === 'progress') await refreshProgress();
    if (currentView === 'records') await refreshRecords();
  }

  // “完成记录”：所有任务里记过的情况，按时间倒序
  async function refreshRecords() {
    const body = $('recordsBody');
    if (body.contains(document.activeElement) && document.activeElement.matches('textarea')) return;
    try {
      remarkCache = await call('remarks_get');
    } catch (e) {
      body.className = 'empty'; body.textContent = errText(e); return;
    }
    const rows = Object.entries(remarkCache).map(([key, r]) => ({ key, ...r }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const list = rows.filter((r) => {
      const st = r.status || autoStatus(r.stage);
      return remarkFilter === 'all' || st === remarkFilter;
    });
    recordsList = list;
    $('recordsCount').textContent = `共 ${rows.length} 条，没完成 ${rows.filter((r) => (r.status || autoStatus(r.stage)) === 'notdone').length} 条`;
    if (!list.length) {
      body.className = 'empty';
      body.textContent = rows.length ? '这个筛选下没有记录。' : '还没有记录。在“执行进度”里每台机后面点“完成 / 没完成”或写备注，就会记在这里。';
      return;
    }
    body.className = 'tablewrap';
    body.innerHTML = `<table class="grid"><thead><tr><th>时间</th><th>任务</th><th>机号 / 单号</th><th>订单</th><th>完成情况</th><th style="min-width:260px">备注</th></tr></thead><tbody>
      ${list.map((r) => {
        const info = { machineNo: r.machineNo, orderNumber: r.orderNumber, orderId: r.orderId, title: r.title, stage: r.stage };
        return `<tr><td class="nowrap">${h(r.updatedAt)}</td><td>${h(r.title)}</td><td class="mono">${h(r.machineNo)}</td>
          <td class="mono">${orderLink(r.orderId, r.orderNumber)}</td>${remarkCells(r.key, info, r)}</tr>`;
      }).join('')}</tbody></table>`;
  }

  async function refreshProgress() {
    if (currentView !== 'progress') return;
    const pill = $('progressStatus');
    const body = $('progressBody');
    try {
      const res = await call('engine_state');
      const s = res.state;
      $('progressLog').textContent = res.log || '';
      $('progressLogWrap').hidden = !res.log;
      const notes = [...(res.dialogs || []), ...(res.events || [])].sort((a, b) => String(a.time).localeCompare(String(b.time)));
      $('progressDialogs').innerHTML = notes.slice(-10).reverse()
        .map((d) => `<li><span class="muted">${h(d.time)}</span> ${h(d.message)}</li>`).join('');
      $('progressDialogsWrap').hidden = !notes.length;
      if (shotLive) refreshShot();
      $('btnWake').hidden = !(s && s.status === 'running' && !res.workerRunning);
      const native = Boolean(res.native);
      $('btnShot').hidden = native;
      if (native && shotLive) $('btnShot').click();
      $('btnSkip').hidden = !(native && s && s.status !== 'completed');
      $('btnClear').hidden = !(native && s && s.status !== 'running');
      $('btnExportProgress').hidden = !s;
      if (!s) lastProgress = null;
      $('pauseReason').hidden = !(s && s.status === 'paused' && s.pauseReason);
      $('pauseReason').textContent = s && s.pauseReason ? `暂停原因：${s.pauseReason}` : '';
      if (!s) {
        pill.textContent = '没有任务'; pill.className = 'pill pill-muted';
        body.className = 'empty'; body.textContent = '后台现在没有任务。在“Excel 导入”里检查完，点批次上的“开始执行”。';
        return;
      }
      const [cls, text] = RUN[s.status] || ['pill-muted', s.status];
      const done = s.items.filter((x) => ['done', 'skipped', 'failed'].includes(x.stage)).length;
      pill.textContent = `${s.dryRun ? '演练 · ' : ''}${text}：${done} / ${s.items.length}`;
      pill.className = `pill ${cls}`;
      // 正在写备注时不要重画表格，不然输入框会被刷掉
      if (body.contains(document.activeElement) && document.activeElement.matches('textarea, input')) return;
      remarkCache = await call('remarks_get').catch(() => remarkCache);
      const taskKey = s.createdAt || s.title || '';
      lastProgress = { s, taskKey };
      body.className = 'tablewrap';
      body.innerHTML = `<table class="grid"><thead><tr><th>#</th><th>机号 / 单号</th><th>订单</th><th>进度</th><th>说明</th><th>完成情况</th><th style="min-width:220px">备注</th></tr></thead><tbody>
        ${s.items.map((x, i) => {
          const badge = x.stage === 'done' ? 'b-ok' : x.stage === 'failed' ? 'b-err' : x.stage === 'skipped' ? 'b-warn' : 'b-muted';
          const current = i === s.currentIndex && s.status === 'running' ? ' ◀' : '';
          const key = `${taskKey}|${x.machineNo}`;
          const info = { machineNo: x.machineNo, orderNumber: x.orderNumber, orderId: x.orderId, title: s.title || '', stage: x.stage };
          return `<tr><td>${i + 1}</td><td class="mono">${h(x.machineNo)}${current}</td><td class="mono">${orderLink(x.orderId, x.orderNumber)}</td>
            <td><span class="badge ${badge}">${h(STAGE[x.stage] || x.stage)}</span></td><td>${h(x.error || x.skipReason)}</td>
            ${remarkCells(key, info, remarkCache[key])}</tr>`;
        }).join('')}</tbody></table>`;
    } catch (e) {
      pill.textContent = e.needLogin ? 'D365 未登录' : '读不到后台进度'; pill.className = 'pill pill-err';
      body.className = 'empty'; body.textContent = errText(e);
    }
  }

  // ---------- 事件 ----------
  function bind() {
    $('tabs').addEventListener('click', (ev) => { const b = ev.target.closest('.tab'); if (b) showView(b.dataset.view); });
    $('btnLogin').onclick = login;
    $('appVersion').title = '点这里检查更新';
    $('appVersion').onclick = () => refreshUpdate(true);
    $('btnCheckUpdate').onclick = () => refreshUpdate(true);
    $('btnApplyUpdateTop').onclick = applyUpdate;
    $('excelFile').onchange = onExcelChosen;
    $('btnClear').onclick = () => {
      if (!confirm('清除这个任务的进度记录？（不会改 D365 里的任何东西）')) return;
      call('engine_control', 'clear').then(() => setTimeout(refreshProgress, 300)).catch((e) => toast(errText(e), true));
    };
    for (const [id, action] of [['btnPause', 'pause'], ['btnResume', 'resume'], ['btnSkip', 'skip']]) {
      $(id).onclick = () => call('engine_control', action).then(() => setTimeout(refreshProgress, 800)).catch((e) => toast(errText(e), true));
    }
    for (const id of ['progressBody', 'recordsBody']) {
      $(id).addEventListener('click', onRemarkClick);
      $(id).addEventListener('input', onRemarkInput);
      $(id).addEventListener('focusout', onRemarkBlur);
    }
    $('btnExportProgress').onclick = exportProgress;
    $('btnExportRecords').onclick = exportRecords;
    $('recordsFilter').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-filter]');
      if (!b) return;
      remarkFilter = b.dataset.filter;
      for (const x of $('recordsFilter').querySelectorAll('[data-filter]')) x.classList.toggle('btn-primary', x === b);
      refreshRecords();
    });
    $('btnWake').onclick = () => call('engine_wake').then(refreshProgress).catch((e) => toast(errText(e), true));
    $('btnShot').onclick = () => {
      shotLive = !shotLive;
      $('btnShot').textContent = shotLive ? '收起后台画面' : '看后台画面';
      $('shotWrap').hidden = !shotLive;
      if (shotLive) refreshShot();
    };
    $('machineForm').onsubmit = (ev) => { ev.preventDefault(); queryMachine($('machineInput').value); };
    $('btnPickExcel').onclick = pickExcel;
    $('btnRecheck').onclick = runCheck;
    $('btnExport').onclick = exportResults;
    $('btnTemplate').onclick = () => { location.href = '/download/template'; toast('模板已下载到“下载”文件夹'); };
    $('excelFilters').addEventListener('click', (ev) => {
      const b = ev.target.closest('.chip');
      if (b && excel) { excel.filter = b.dataset.filter; renderExcel(); }
    });
    $('jobs').addEventListener('click', (ev) => { const b = ev.target.closest('[data-job]'); if (b) sendJob(Number(b.dataset.job), b.dataset.dry === '1'); });
    // 点机号 → 跳到机器查询；点单号 → 在 D365 窗口打开
    document.addEventListener('click', (ev) => {
      const s = ev.target.closest('[data-serial]');
      if (s) { showView('machine'); queryMachine(s.dataset.serial); return; }
      const o = ev.target.closest('[data-open]');
      if (o) call('open_record', o.dataset.open, o.dataset.id).then(() => toast('已在你的浏览器里打开')).catch((e) => toast(`打开失败：${errText(e)}`, true));
    });
  }

  async function start() {
    logic = createLogic((path, method, body, headers) => call('d365_request', path, method, body, headers));
    bind();
    renderHistory();
    try {
      const info = await call('app_info');
      $('appVersion').textContent = `v${info.version} · 执行引擎 v${info.engineVersion}（${info.engineOrigin}）`;
      schema = await call('schema');
    } catch (e) { toast(errText(e), true); }
    refreshStatus();
    setInterval(refreshStatus, 60000);
    setInterval(refreshProgress, 3000);
    // 打开窗口时查一次（程序可能已经在后台开了很久）
    setTimeout(() => call('update_check').then(() => refreshUpdate()).catch(() => {}), 3000);
    setInterval(refreshUpdate, 60000);
    // 报平安：窗口关掉后程序据此退出
    setInterval(() => fetch('/__ping').catch(() => {}), 5000);
    // 关窗口时告诉程序（刷新页面也会发，但刷新后马上又有请求，程序就知道没关）
    window.addEventListener('pagehide', () => { try { navigator.sendBeacon('/__bye', '1'); } catch { /* 忽略 */ } });
  }

  start();
})();
