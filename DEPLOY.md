# 家庭血压本部署手册

## 在本机验收

在 Carrot 目录使用 Node.js 24 和 npm。预览以真实的本地 Worker 和 SQLite Durable Object 运行，GitHub API 使用模拟服务，虚拟记录随进程结束清空。

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run preview
```

打开终端给出的地址，用其中两个演示账号在不同浏览器或无痕窗口登录。一边保存，另一边点「看历史」。

再断网新增或编辑一条虚拟记录，确认页面显示「待同步」。关闭再打开仍能看到本机记录；恢复联网后，它会自动上传。另一台设备重新打开页面或点「刷新」后，应能看到最新数据。

## 添加到主屏幕

- iPhone：在 Safari 打开血压本，点「分享」→「添加到主屏幕」；如果有「打开为网页 App」，请打开它。
- 荣耀或华为：在自带浏览器的菜单中找「安装应用」或「添加到桌面」；是否提供入口取决于机型和浏览器版本。荣耀的 Android 机型也可以用 Chrome 打开同一网址并添加。

从图标打开后，用原账号登录一次。已登录时可以断网保存，已同步过的月份也可以离线查看。联网、重新打开或回到前台时，网页会补传待同步更改，并刷新当前所选月份。登录过期时重新登录原账号即可继续同步。使用同一部手机和浏览器，直到页面提示「已同步」；清除浏览器数据会一并删除本机待同步记录。

## 部署账号和存储

1. 在 GitHub 创建一个只允许本账号安装的 GitHub App。关闭 Webhook，仓库权限只给 `Contents: Read and write`。在 **Install App** 里选 **Only select repositories**，勾选 `Carrot`。记下 App ID、安装设置页 URL 最后的 Installation ID，下载一份 RSA 私钥到本机安全目录。
2. 将网页及 Worker 源码提交到 `main`。独立的 `records` 分支已初始化，首次保存将在 `bp/` 下创建月份密文文件。GitHub **Settings → Branches** 为 `main` 设置 **Require a pull request before merging**，并启用 **Do not allow bypassing the above settings**，确保 GitHub App 直接更新 `main` 会被拒绝。之后通过 PR 更新页面。
3. 在 Cloudflare 账号启用 Workers 免费档和 `workers.dev` 子域名。用下列命令创建口令和密钥，并把 App 配置加进部署文件。将示例账号名、路径及 ID 改成实际值。

```powershell
npm.cmd exec -- wrangler login
npm.cmd run credentials -- baba family
npm.cmd run app-key -- "C:\secure\carrot-app.pem" <AppID> <InstallationID>
npm.cmd run deploy -- --secrets-file carrot-credentials-secrets.json
```

`carrot-credentials.json` 内是发给家人的账号密码，`carrot-credentials-secrets.json` 内是 Worker 所需配置。两者和 PEM 私钥都应在仓库外另行安全备份。保留同一个 `RECORDS_KEY` 才能恢复原来的历史。部署文件名已被 `.gitignore` 排除。

## 发布和复核

1. 用 Cloudflare Pages 提供登录和 API 的 HTTPS 地址。`pages-api/` 通过 Service Binding 将请求转给现有 Worker。项目已创建，更新时在仓库根目录运行下面的部署命令。若在新 Cloudflare 账号重建，先执行项目创建命令，并在 `pages-api/wrangler.jsonc` 中设置实际的项目名和 Worker 名。

   ```powershell
   npm.cmd exec -- wrangler pages project create carrot-blood-pressure-api --production-branch main --force
   npm.cmd exec -- wrangler pages deploy --cwd pages-api --branch main
   ```

2. 将 `docs/config.js` 的 `workerOrigin` 和 `docs/index.html` 的 `connect-src` 设置为 Cloudflare Pages 的生产源地址 `https://carrot-blood-pressure-api.pages.dev`。在 GitHub **Settings → Pages** 选择 **Deploy from a branch**、`main`、`/docs`。如果 GitHub Pages 的网址变了，把根目录 `wrangler.jsonc` 的 `PAGES_URL` 同步改为家人使用的完整页面 URL，再重新部署 Worker。
3. 先在你爸手机的 Wi‑Fi 和移动流量下，用虚拟记录验证登录、保存、回看。另一台手机用独立账号读同一条。测试记录可选一个历史月份，便于上线前从 `records` 当前分支移除相应的演示文件。
4. 无账号时请求 Cloudflare Pages 的 `/api/records` 应得到 `401`。公开 `records` 分支下的记录文件只应出现 `v`、`nonce` 和 `ciphertext`。访问 GitHub Pages 上的 `/Carrot/ReflectiveDLL.dll` 应返回 `404`。

需要撤销访问时，在本地部署配置的 `FAMILY_ACCOUNTS` JSON 字符串中删除该用户名，再重新部署。保留同一份 `RECORDS_KEY`，其余账号的口令和历史继续可用。Worker 每次请求都重新核对名单。
