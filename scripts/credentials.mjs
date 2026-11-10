import { createHmac, randomBytes } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";

const credentialsFile = "carrot-credentials.json";
const secretsFile = "carrot-credentials-secrets.json";
const usernames = process.argv.slice(2).map((value) => value.toLowerCase());

if (!usernames.length || new Set(usernames).size !== usernames.length ||
    !usernames.every((name) => /^[a-z0-9_-]{1,32}$/.test(name))) {
  console.error("用法：npm run credentials -- baba family。账号只能包含 1–32 个英文字母、数字、下划线或连字符。");
  process.exit(1);
}
if (existsSync(credentialsFile) || existsSync(secretsFile)) {
  console.error("凭据文件已存在。保留现有加密密钥和口令配置。");
  process.exit(1);
}

const pepper = randomBytes(32);
const credentials = Object.fromEntries(usernames.map((name) => [name, randomBytes(16).toString("base64url")]));
const accounts = Object.fromEntries(Object.entries(credentials).map(([name, password]) => [
  name, createHmac("sha256", pepper).update(`${name}\0${password}`).digest("base64url"),
]));
const secrets = {
  FAMILY_ACCOUNTS: JSON.stringify(accounts),
  PASSWORD_PEPPER: pepper.toString("base64url"),
  RECORDS_KEY: randomBytes(32).toString("base64url"),
};

const options = { flag: "wx", mode: 0o600 };
writeFileSync(credentialsFile, JSON.stringify(credentials, null, 2), options);
writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), options);
console.log(`已生成 ${credentialsFile} 和 ${secretsFile}。请在本机保管。`);
