import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  diffieHellman,
  createHash,
} from "node:crypto";
import type { Store } from "./store";
import { assert, id, type Obj } from "./util";
export const VAULT_USAGE = "先 vault_list 查看名称与使用条件，再结合用户任务、当前系统/页面和登录方式选择唯一适用的条目；vault_get 的 purpose 必须说明本次用途及为什么符合 condition。网页填写前先观察实际登录页，取用时自动结合当前页面核对；缺少页面上下文时先观察再重新 vault_get，不要要求用户补网站配置。网站名/URL 只是可选上下文，不是必填配置；没有网站名也可根据明确的使用条件判断。不能因为用户名相同、都属腾讯或发生跳转就复用其他系统凭据；DataBrain 邮箱登录、OA 与合作伙伴认证要分别判断。不取用条件不符的条目，可以重新核对列表选择明确适用者；仍无匹配或无法确定时才询问，不能靠实际登录轮流试账号。历史里的 [credential redacted]、[redacted]、__stored_secret__ 都不是真实凭据，续做或换会话需重新 vault_get，不能填入页面。凭据只用于当前授权操作，不写进回复、记忆或备注。";
const SPKI = Buffer.from("302a300506032b656e032100", "hex"),
  PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
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
  key: Buffer;
  /** kind "vault" is the key holder (and the pre-migration global book); employees use scoped(). */
  constructor(public store: Store, public kind = "vault", key?: Buffer) {
    if (key) {
      this.key = key;
      return;
    }
    const env = process.env.VEGA_VAULT_KEY;
    this.key = env
      ? Buffer.from(env, /^[a-f0-9]{64}$/i.test(env) ? "hex" : "base64")
      : Buffer.from(store.get("vault:key", ""), "base64");
    if (!this.key.length) {
      this.key = randomBytes(32);
      store.put("vault:key", this.key.toString("base64"));
    }
    assert(
      this.key.length === 32,
      "VEGA_VAULT_KEY must encode exactly 32 bytes",
    );
  }
  /** The credential book of one employee; same key and encryption, separate entries. */
  scoped(employeeId: string) {
    return new Vault(this.store, vaultKind(employeeId), this.key);
  }
  sealObject(value: any, aad = "subscription") {
    return encrypt(this.key, aad, JSON.stringify(value));
  }
  openObject(raw: string, aad = "subscription") {
    return JSON.parse(decrypt(this.key, aad, raw).toString());
  }
  list() {
    const now = Date.now();
    for (const e of this.store.objects<any>(this.kind))
      if (e.tempFor && now - e.createdAt > 86400000)
        this.store.remove(this.kind, e.id);
    return this.store.objects<any>(this.kind).map(({ secret, ...e }) => e);
  }
  save(a: Obj) {
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
    const old = a.id ? this.store.object<any>(this.kind, a.id) : undefined;
    if (a.id) assert(old, "Vault entry not found");
    assert(old || a.content, "New entry requires content");
    assert(old || this.list().length < 200, "Vault capacity reached");
    const entry = {
      ...old,
      id: old?.id || id("v"),
      name: a.name,
      condition: a.condition,
      secret: a.content ? encrypt(this.key, "vault", a.content) : old.secret,
      share: a.share ?? old?.share ?? false,
      createdAt: old?.createdAt || Date.now(),
    };
    this.store.save(this.kind, entry.id, entry);
    return { id: entry.id };
  }
  get(key: string, purpose: string, task = "") {
    assert(
      typeof purpose === "string" && purpose.trim(),
      "Vault purpose required",
    );
    const e = this.store.object<any>(this.kind, key);
    assert(e, "Vault entry not found");
    assert(
      !e.tempFor || e.tempFor === task,
      "Temporary credential belongs to another task",
    );
    assert(!e.tempFor || Date.now() - e.createdAt <= 86400000, "Temporary credential expired");

    const content = decrypt(this.key, "vault", e.secret).toString();
    e.usedAt = Date.now();
    e.usedFor = purpose.slice(0, 100);
    this.store.save(this.kind, key, e);
    return {
      id: e.id,
      name: e.name,
      condition: e.condition,
      content,
      next: VAULT_USAGE,
    };
  }
  remove(key: string) {
    assert(this.store.object(this.kind, key), "Vault entry not found");
    this.store.remove(this.kind, key);
  }
  request(req: string) {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const rawPrivate = privateKey
        .export({ type: "pkcs8", format: "der" })
        .subarray(-32),
      rawPublic = publicKey
        .export({ type: "spki", format: "der" })
        .subarray(-32);
    this.store.save("vault-request", req, {
      secret: encrypt(this.key, req, rawPrivate),
    });
    return rawPublic.toString("base64");
  }
  shared(rawPrivate: Buffer, rawPublic: Buffer) {
    assert(
      rawPrivate.length === 32 && rawPublic.length === 32,
      "Invalid X25519 key",
    );
    const secret = diffieHellman({
      privateKey: createPrivateKey({
        key: Buffer.concat([PKCS8, rawPrivate]),
        format: "der",
        type: "pkcs8",
      }),
      publicKey: createPublicKey({
        key: Buffer.concat([SPKI, rawPublic]),
        format: "der",
        type: "spki",
      }),
    });
    assert(
      secret.some((v) => v !== 0),
      "Invalid low-order X25519 key",
    );
    return createHash("sha256").update("nova-vault-v1").update(secret).digest();
  }
  sealFor(key: string, req: string, their: string) {
    const e = this.store.object<any>(this.kind, key);
    assert(
      e?.share && !e.tempFor,
      "Credential is not shareable or is temporary",
    );
    const { privateKey, publicKey } = generateKeyPairSync("x25519"),
      shared = this.shared(
        privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32),
        Buffer.from(their, "base64"),
      );
    const content = this.get(key, "加密发给远程牛马").content;
    return {
      name: e.name,
      sealed: {
        epk: publicKey
          .export({ format: "der", type: "spki" })
          .subarray(-32)
          .toString("base64"),
        data: encrypt(
          shared,
          req,
          JSON.stringify({ name: e.name, password: content, condition: e.condition }),
        ),
      },
    };
  }
  receive(req: string, task: string, sealed: Obj) {
    const mine = this.store.object<any>("vault-request", req);
    assert(mine, "No outstanding credential request");
    const shared = this.shared(
      decrypt(this.key, req, mine.secret),
      Buffer.from(sealed.epk, "base64"),
    );
    const data = JSON.parse(decrypt(shared, req, sealed.data).toString());
    assert(typeof data.password === "string" && data.password.length > 0 && data.password.length <= 16000, "Invalid shared credential");
    assert(data.condition === undefined || (typeof data.condition === "string" && data.condition.length <= 500), "Invalid shared credential condition");
    const key = id("v");
    this.store.transaction(() => {
      this.store.remove("vault-request", req);
      this.store.save(this.kind, key, {
        id: key,
        name: (data.name || "凭据") + "（对方传来）",
        condition: `仅限任务「${task}」使用，任务结束即删除` + (data.condition ? `；原使用条件：${data.condition}` : ""),
        secret: encrypt(
          this.key,
          "vault",
          data.username
            ? `账号：${data.username}\n密码：${data.password}`
            : data.password,
        ),
        share: false,
        tempFor: req,
        createdAt: Date.now(),
      });
    });
    return { id: key, name: data.name };
  }
  dropTemp(req: string) {
    this.store.transaction(() => {
      this.store.remove("vault-request", req);
      for (const e of this.store.objects<any>(this.kind))
        if (e.tempFor === req) this.store.remove(this.kind, e.id);
    });
  }
}
/**
 * One-time move of the former global book: every employee used it, so each current employee gets a copy;
 * a temporary entry goes only to the employee owning its task. The global entries are then deleted.
 */
export function migrateGlobalVault(store: Store, current: () => { employeeId: string; taskIds: string[] }[]) {
  if (store.get("vault:migrated", false)) return;
  const employees = current();
  store.transaction(() => {
    for (const entry of store.objects<any>("vault")) {
      const owners = entry.tempFor ? employees.filter((employee) => employee.taskIds.includes(entry.tempFor)) : employees;
      for (const owner of owners) store.save(vaultKind(owner.employeeId), entry.id, entry);
      store.remove("vault", entry.id);
    }
    store.put("vault:migrated", true);
  });
}
