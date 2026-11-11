// 「新」分界：记住每个会话在本机看到的位置，切进来时把它之后的消息标成新的。
// 只记在本机（换设备或换客户端各算各的），清掉站点数据就从头开始。
const PREFIX = "vega:seen:";
const key = (user, id) => PREFIX + user + ":" + id;
const storage = () => { try { return globalThis.localStorage; } catch { return undefined; } };
export function seenSeq(user, id) {
  try { return Number(storage()?.getItem(key(user, id))) || 0; } catch { return 0; }
}
/** 把「看到这里」推到现在；历史被清空、序号重排时也跟着退回去。 */
export function markSeen(user, id, seq) {
  if (!seq) return;
  try { storage()?.setItem(key(user, id), String(seq)); } catch {}
}
