# D365 工作台

在一个窗口里查 D365、导入 Excel、让后台自动执行建单/转移/交机/设备变更，不用自己打开 D365 页面操作。

## 怎么用

1. 到仓库的 **Releases** 下载最新的 `D365Workbench-windows.zip`，解压到自己的文件夹（比如“文档”，不要放在 `C:\Program Files`）。
2. 双击 `D365Workbench\D365Workbench.exe`。会打开一个 Edge 应用窗口（工作台）。
3. 第一次点右上角 **登录 D365**：会弹出一个 Edge 窗口，像平时一样登录（含 MFA）。登录成功后窗口自动关掉，之后都在后台运行，登录状态会保存。
4. 三个页签：
   - **机器查询**：输入机号，看设备档案、所有订单、照片和 Service Ticket 齐不齐、设备变更单。点单号在你平时的浏览器里打开。
   - **Excel 导入**：下载模板 → 填好 → 选择 Excel。先逐行检查；没错的行合成批次，点 **开始执行** 就在后台跑。
   - **执行进度**：每台机走到哪一步、执行日志、页面弹窗；可以暂停、继续，排查问题时可以勾“显示执行窗口”看后台在做什么。

现在能在后台执行的：交机（无照片）、设备变更、Shipment 转移。需要读照片文件夹的功能（PDI、防锈、交机、全流程、PDI 转移）下一版支持。

关掉工作台窗口，程序就会退出；没做完的任务会保存，下次打开在“执行进度”里点“继续没做完的任务”。

## 原理

- `app/browser.py`：用 Playwright 驱动本机自带的 Edge，在后台保持 D365 登录。读数据时在 D365 同源页面里调 Web API；执行时开一个后台 D365 页面，把执行引擎（`app/engine/` 里的油猴脚本）注入进去，页面弹出的确认框自动点确定。
- 执行引擎每次启动会去 Gist 取最新版（和油猴同一份），取不到就用缓存或程序自带的。
- `app/server.py`：本机小网站（只监听 127.0.0.1），界面在 `app/ui/`，通过 `POST /api/<方法名>` 调 `app/api.py`。
- 数据都在 `%LOCALAPPDATA%\D365Workbench`：`browser-profile` 是登录状态，`logs\app.log` 是日志。

## 开发

```bash
pip install -r requirements.txt
python run_app.py            # Edge 应用窗口
python run_app.py --web      # 用默认浏览器打开
python -m unittest discover tests
```

推送到 `main` 会自动打包，并按 `app/__init__.py` 里的 `APP_VERSION` 发布到 Releases；改版本号就是发新版本。
