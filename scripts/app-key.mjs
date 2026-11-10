import { createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [file, appId, installationId] = process.argv.slice(2);
if (!file || !/^\d+$/.test(appId ?? "") || !/^\d+$/.test(installationId ?? "")) {
  console.error("用法：npm run app-key -- <PEM 文件路径> <App ID> <Installation ID>");
  process.exit(1);
}

const secretsFile = "carrot-credentials-secrets.json";
const secrets = JSON.parse(readFileSync(secretsFile, "utf8"));
const key = createPrivateKey(readFileSync(file));
if (key.asymmetricKeyType !== "rsa") throw new Error("GitHub App 私钥须为 RSA 格式");
secrets.GITHUB_APP_ID = appId;
secrets.GITHUB_INSTALLATION_ID = installationId;
secrets.GITHUB_APP_KEY_PKCS8 = key.export({ format: "der", type: "pkcs8" }).toString("base64");
writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), { mode: 0o600 });
console.log(`已将 GitHub App 配置写入 ${secretsFile}。`);
