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
    let u;
    try {
      u = manual ? await call('update_check') : await call('update_status');
    } catch (e) {
      if (manual) toast(`检查更新失败：${errText(e)}`, true);
      return;
    }
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
          : `<div><button class="btn ${excel.sent.has(i) ? '' : 'btn-primary'}" data-job="${i}">${excel.sent.has(i) ? '已开始（再执行一次）' : '开始执行'}</button></div>`}
      </div>`).join('');
  }

  async function sendJob(index) {
    const job = excel.jobs[index];
    if (!confirm(`后台开始执行：${job.title}\n共 ${job.lines.length} ${job.func === 'transfer|pdi-shipment' ? '张单' : '台机'}。\n\n确定开始？`)) return;
    const btn = document.querySelector(`[data-job="${index}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '正在送到后台…'; }
    try {
      const res = await call('engine_load_job', {
        func: job.func, title: job.title, build: job.build || '', fields: job.fields,
      });
      if (!res?.ok) { toast(res?.error || '后台没有接收', true); renderJobs(); return; }
      excel.sent.add(index);
      renderJobs();
      toast('已在后台开始执行，进度在“执行进度”里看');
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
    try {
      const res = await fetch('/download/results', { method: 'POST', body: JSON.stringify({ headers, rows }) });
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = '检查结果.xlsx';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('已下载到“下载”文件夹');
    } catch (e) { toast(`保存失败：${errText(e)}`, true); }
  }

  // ---------- 执行进度 ----------
  const STAGE = {
    pending: '等待', done: '完成', skipped: '跳过', failed: '出错', created: '已建单', opening: '打开订单',
    uploading: '上传照片', transferring: '服务转移', 'transfer-submitting': '提交转移', 'ec-creating': '新建变更单',
    'ec-filling': '填写变更单', 'ec-submitting': '提交审批', 'pdi-fields': '填写 PDI', 'pdi-completing': 'PDI 收尾',
    'rust-fields': '填写防锈', 'rust-completing': '防锈收尾', 'handover-preparing': '准备交机', 'handover-fields': '填写交机',
    'handover-completing': '交机收尾', 'dispatch-checking': '检查派单', 'dispatch-submitting': '提交派单',
    'dealer-assign-submitting': 'Assign 派单', transitioning: '切换状态',
  };
  const RUN = { running: ['pill-ok', '运行中'], paused: ['pill-warn', '已暂停'], completed: ['pill-muted', '已完成'], draft: ['pill-muted', '已准备，等你点开始'] };

  async function refreshProgress() {
    if (currentView !== 'progress') return;
    const pill = $('progressStatus');
    const body = $('progressBody');
    try {
      const res = await call('engine_state');
      const s = res.state;
      $('progressLog').textContent = res.log || '';
      $('progressLogWrap').hidden = !res.log;
      $('progressDialogs').innerHTML = (res.dialogs || []).slice(-8).reverse()
        .map((d) => `<li><span class="muted">${h(d.time)}</span> ${h(d.message)}</li>`).join('');
      $('progressDialogsWrap').hidden = !(res.dialogs || []).length;
      $('btnWake').hidden = !(s && s.status === 'running' && !res.workerRunning);
      if (!s) {
        pill.textContent = '没有任务'; pill.className = 'pill pill-muted';
        body.className = 'empty'; body.textContent = '后台现在没有任务。在“Excel 导入”里检查完，点批次上的“开始执行”。';
        return;
      }
      const [cls, text] = RUN[s.status] || ['pill-muted', s.status];
      const done = s.items.filter((x) => ['done', 'skipped', 'failed'].includes(x.stage)).length;
      pill.textContent = `${text}：${done} / ${s.items.length}`;
      pill.className = `pill ${cls}`;
      body.className = 'tablewrap';
      body.innerHTML = `<table class="grid"><thead><tr><th>#</th><th>机号 / 单号</th><th>订单</th><th>进度</th><th>说明</th></tr></thead><tbody>
        ${s.items.map((x, i) => {
          const badge = x.stage === 'done' ? 'b-ok' : x.stage === 'failed' ? 'b-err' : x.stage === 'skipped' ? 'b-warn' : 'b-muted';
          const current = i === s.currentIndex && s.status === 'running' ? ' ◀' : '';
          return `<tr><td>${i + 1}</td><td class="mono">${h(x.machineNo)}${current}</td><td class="mono">${h(x.orderNumber)}</td>
            <td><span class="badge ${badge}">${h(STAGE[x.stage] || x.stage)}</span></td><td>${h(x.error || x.skipReason)}</td></tr>`;
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
    $('excelFile').onchange = onExcelChosen;
    for (const [id, action] of [['btnPause', 'pause'], ['btnResume', 'resume']]) {
      $(id).onclick = () => call('engine_control', action).then(() => setTimeout(refreshProgress, 800)).catch((e) => toast(errText(e), true));
    }
    $('btnWake').onclick = () => call('engine_wake').then(refreshProgress).catch((e) => toast(errText(e), true));
    $('chkShowWorker').onchange = async (ev) => {
      ev.target.disabled = true;
      try { await call('set_show_worker', ev.target.checked); } catch (e) { toast(errText(e), true); }
      ev.target.disabled = false;
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
    $('jobs').addEventListener('click', (ev) => { const b = ev.target.closest('[data-job]'); if (b) sendJob(Number(b.dataset.job)); });
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
      $('chkShowWorker').checked = info.showWorker;
      schema = await call('schema');
    } catch (e) { toast(errText(e), true); }
    refreshStatus();
    setInterval(refreshStatus, 60000);
    setInterval(refreshProgress, 3000);
    setTimeout(refreshUpdate, 8000);
    setInterval(refreshUpdate, 60000);
    // 报平安：窗口关掉后程序据此退出
    setInterval(() => fetch('/__ping').catch(() => {}), 5000);
    // 关窗口时告诉程序（刷新页面也会发，但刷新后马上又有请求，程序就知道没关）
    window.addEventListener('pagehide', () => { try { navigator.sendBeacon('/__bye', '1'); } catch { /* 忽略 */ } });
  }

  start();
})();
