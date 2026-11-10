# 家庭血压本部署手册

## 在本机验收

在 Carrot 目录使用 Node.js 24 和 npm。预览以真实的本地 Worker 和 SQLite Durable Object 运行，GitHub API 使用模拟服务，虚拟记录随进程结束清空。

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run preview
```

打开终端给出的地址，用其中两个演示账号在不同浏览器或无痕窗口登录。一边保存，另一边点「看历史」。

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

1. 把 `docs/config.js` 里的 `workerOrigin` 设为 Wrangler 输出的 `https://…workers.dev` 源地址，末尾省去 `/`。发布到 `main` 后，在 **Settings → Pages** 选 **Deploy from a branch**、`main`、`/docs`。若本账号已经自定义 Pages 域名，需要把 `wrangler.jsonc` 中的 `PAGES_URL` 同步改成最终页面 URL，再重新部署 Worker。
2. 先在你爸手机的 Wi‑Fi 和移动流量下，用虚拟记录验证登录、保存、回看。另一台手机用独立账号读同一条。测试记录可选一个历史月份，便于上线前从 `records` 当前分支移除相应的演示文件。
3. 无账号时请求 Worker 的 `/api/records` 应得到 `401`。公开 `records` 分支下的记录文件只应出现 `v`、`nonce` 和 `ciphertext`。访问 Pages 上的 `/Carrot/ReflectiveDLL.dll` 应返回 `404`。

需要撤销访问时，在本地部署配置的 `FAMILY_ACCOUNTS` JSON 字符串中删除该用户名，再重新部署。保留同一份 `RECORDS_KEY`，其余账号的口令和历史继续可用。Worker 每次请求都重新核对名单。
