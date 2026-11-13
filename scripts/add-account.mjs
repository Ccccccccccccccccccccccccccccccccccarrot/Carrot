import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const username = process.argv[2]?.toLowerCase();
if (process.argv.length !== 3 || !username || !/^[a-z0-9_-]{1,32}$/.test(username)) {
  throw new Error("用法：npm run add-account -- 账号名");
}

const secretsPath = "carrot-credentials-secrets.json";
const pendingPath = "carrot-credentials-secrets.pending.json";
const credentialsPath = `carrot-credentials-${username}.json`;
if (existsSync(pendingPath) || existsSync(credentialsPath)) {
  throw new Error("待部署文件或该账号凭据已存在，请先妥善处理这些文件。");
}
const secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
const accounts = JSON.parse(secrets.FAMILY_ACCOUNTS);
const pepper = Buffer.from(secrets.PASSWORD_PEPPER, "base64url");
if (pepper.length !== 32 || Buffer.from(secrets.RECORDS_KEY, "base64url").length !== 32) {
  throw new Error("现有部署密钥不完整，请检查配置。");
}
if (Object.hasOwn(accounts, username)) throw new Error("该账号已存在，不能覆盖。");

const password = randomBytes(16).toString("base64url");
accounts[username] = createHmac("sha256", pepper).update(`${username}\0${password}`).digest("base64url");
secrets.FAMILY_ACCOUNTS = JSON.stringify(accounts);
const options = { flag: "wx", mode: 0o600 };
writeFileSync(credentialsPath, JSON.stringify({ [username]: password }, null, 2), options);
writeFileSync(pendingPath, JSON.stringify(secrets, null, 2), options);
console.log(`已生成 ${credentialsPath} 和 ${pendingPath}，保留原有账号和加密密钥。`);
