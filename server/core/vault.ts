import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type { Store } from "./store";
import { assert, id, type Obj } from "./util";
export const VAULT_USAGE = "先 vault_list 查看类型、名称与使用条件，再结合用户任务、当前系统/页面和登录方式选择唯一适用的条目；vault_get 的 purpose 必须说明本次用途及为什么符合 condition。网页填写前先观察实际登录页，取用时自动结合当前页面核对；缺少页面上下文时先观察再重新 vault_get，不要要求用户补网站配置。网站名/URL 只是可选上下文，不是必填配置；没有网站名也可根据明确的使用条件判断。不能因为用户名相同、都属腾讯或发生跳转就复用其他系统凭据；DataBrain 邮箱登录、OA 与合作伙伴认证要分别判断。不取用条件不符的条目，可以重新核对列表选择明确适用者；仍无匹配或无法确定时才询问，不能靠实际登录轮流试账号。历史里的 [credential redacted]、[redacted]、__stored_secret__ 都不是真实凭据，续做或换会话需重新 vault_get，不能填入页面。凭据只用于当前授权操作，不写进回复、记忆或备注。SSH 私钥条目不给原文：vault_get 在当前执行位置写好本轮临时私钥文件并返回 GIT_SSH_COMMAND，直接用它跑 git，不要读取或复制私钥文件。";
/** Entry types: a label for the model and the editor; ssh_key alone changes how vault_get hands the secret out. */
export const VAULT_TYPES: Record<string, string> = { login: "账号密码", token: "API 密钥/令牌", ssh_key: "SSH 私钥", general: "万能" };
export const vaultType = (type: unknown) => (typeof type === "string" && VAULT_TYPES[type] ? type : "general");
/** A private key ssh can use unattended: PEM or OpenSSH format, not passphrase-protected; returned normalised (LF, final newline). */
export function sshPrivateKey(content: string) {
  const text = content.replace(/\r\n?/g, "\n").trim();
  const match = /^-----BEGIN ((?:OPENSSH|RSA|EC|DSA|ENCRYPTED) )?PRIVATE KEY-----\n([\s\S]+?)\n-----END \1PRIVATE KEY-----$/.exec(text);
  assert(match, "SSH 私钥格式不对：需要完整的私钥文本，从 -----BEGIN … PRIVATE KEY----- 到 -----END … PRIVATE KEY-----（不是 .pub 公钥）");
  const encrypted = "带口令的 SSH 私钥无法在无人值守时使用；请先用 ssh-keygen -p -f <私钥文件> 去掉口令再保存（密码本本身已加密存储）";
  assert(match[1] !== "ENCRYPTED " && !/^Proc-Type:\s*4,ENCRYPTED/m.test(match[2]), encrypted);
  if (match[1] === "OPENSSH ") {
    // openssh-key-v1\0, then the cipher name as a length-prefixed string: "none" for an unencrypted key.
    const body = Buffer.from(match[2].replace(/\s+/g, ""), "base64"), magic = "openssh-key-v1\0";
    assert(body.subarray(0, magic.length).toString("latin1") === magic && body.length > magic.length + 4, "SSH 私钥内容已损坏，请重新复制完整的私钥文件");
    const length = body.readUInt32BE(magic.length);
    assert(body.subarray(magic.length + 4, magic.length + 4 + length).toString("latin1") === "none", encrypted);
  }
  return text + "\n";
}
export const encrypt = (key: Buffer, aad: string, plain: Buffer | string) => {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([
    nonce,
    cipher.update(plain),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
};
export const decrypt = (key: Buffer, aad: string, blob: string) => {
  const b = Buffer.from(blob, "base64");
  assert(b.length > 28, "Invalid encrypted payload");
  const decipher = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(b.subarray(-16));
  return Buffer.concat([
    decipher.update(b.subarray(12, -16)),
    decipher.final(),
  ]);
};
/** Each employee keeps its own credential book in this object kind. */
export const vaultKind = (employeeId: string) => "vault:" + employeeId;
export class Vault {
  /** kind "vault" is the key holder; employees use scoped(). */
  constructor(public store: Store, public kind = "vault", private keyLoad?: Promise<Buffer>) {}
  /** The encryption key: VEGA_VAULT_KEY, or one generated once and kept in settings. */
  key(): Promise<Buffer> {
    let key = this.keyLoad || keys.get(this.store);
    if (!key) {
      keys.set(this.store, (key = loadKey(this.store)));
      key.catch(() => {}); // reported to whoever uses the key
    }
    return (this.keyLoad = key);
  }
  /** The credential book of one employee; same key and encryption, separate entries. */
  scoped(employeeId: string) {
    return new Vault(this.store, vaultKind(employeeId), this.key());
  }
  async sealObject(value: any, aad = "subscription") {
    return encrypt(await this.key(), aad, JSON.stringify(value));
  }
  async openObject(raw: string, aad = "subscription") {
    return JSON.parse(decrypt(await this.key(), aad, raw).toString());
  }
  async list() {
    return (await this.store.objects<any>(this.kind)).map(({ secret, ...e }) => ({ ...e, type: vaultType(e.type) }));
  }
  async save(a: Obj) {
    assert(
      typeof a.name === "string" && a.name.trim() && a.name.length <= 100,
      "Vault name required, max 100",
    );
    assert(
      typeof a.condition === "string" &&
        a.condition.trim() &&
        a.condition.length <= 500,
      "Vault usage condition required, max 500",
    );
    assert(
      !a.content ||
        (typeof a.content === "string" && a.content.length <= 16000),
      "Vault content too long",
    );
    assert(a.type === undefined || VAULT_TYPES[a.type], "Unknown vault entry type");
    const old = a.id ? await this.store.object<any>(this.kind, a.id) : undefined;
    if (a.id) assert(old, "Vault entry not found");
    assert(old || a.content, "New entry requires content");
    assert(old || (await this.list()).length < 200, "Vault capacity reached");
    const type = a.type ?? vaultType(old?.type);
    let content: string | undefined = a.content || undefined;
    // An entry becoming an SSH key must hold one, even when its stored content is kept.
    if (type === "ssh_key") content = sshPrivateKey(content ?? decrypt(await this.key(), "vault", old.secret).toString());
    const entry = {
      ...old,
      id: old?.id || id("v"),
      type,
      name: a.name,
      condition: a.condition,
      secret: content ? encrypt(await this.key(), "vault", content) : old.secret,
      createdAt: old?.createdAt || Date.now(),
    };
    await this.store.save(this.kind, entry.id, entry);
    return { id: entry.id };
  }
  async get(key: string, purpose: string, task = "") {
    assert(
      typeof purpose === "string" && purpose.trim(),
      "Vault purpose required",
    );
    const e = await this.store.object<any>(this.kind, key);
    assert(e, "Vault entry not found");
    const content = decrypt(await this.key(), "vault", e.secret).toString();
    e.usedAt = Date.now();
    e.usedFor = purpose.slice(0, 100);
    await this.store.save(this.kind, key, e);
    return {
      id: e.id,
      type: vaultType(e.type),
      name: e.name,
      condition: e.condition,
      content,
      next: VAULT_USAGE,
    };
  }
  async remove(key: string) {
    assert(await this.store.object(this.kind, key), "Vault entry not found");
    await this.store.remove(this.kind, key);
  }
}

/** One key load per store, shared by every Vault on it (the engine loads it at startup). */
const keys = new WeakMap<Store, Promise<Buffer>>();
async function loadKey(store: Store) {
  const env = process.env.VEGA_VAULT_KEY;
  const key = env
    ? Buffer.from(env, /^[a-f0-9]{64}$/i.test(env) ? "hex" : "base64")
    : await store.transaction(async () => {
        const saved = Buffer.from(await store.get("vault:key", ""), "base64");
        if (saved.length) return saved;
        const fresh = randomBytes(32);
        await store.put("vault:key", fresh.toString("base64"));
        return fresh;
      });
  assert(key.length === 32, "VEGA_VAULT_KEY must encode exactly 32 bytes");
  return key;
}
