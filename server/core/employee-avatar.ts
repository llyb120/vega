import sharp from "sharp";
import { isAvatarPreset } from "../../shared/employee-avatars";
import type { Employee } from "./employee";
import type { Store } from "./store";
import { assert, type Obj } from "./util";

export async function updateEmployeeAvatar(employee: Employee, input: Obj) {
  if (input.preset !== undefined) {
    assert(isAvatarPreset(input.preset), "请选择有效的预设头像或默认头像");
    await employee.control({ action: "settings", avatar: input.preset });
  } else {
    const data = await avatarImage(input);
    assert(!employee.deleting && !employee.deleted, "牛马已删除或正在删除");
    const avatar = await employee.store.blob("image/webp", data);
    await employee.update(state => { state.avatar = avatar; });
  }
  return { employeeId: employee.employeeId, avatar: (await employee.state()).avatar || "" };
}

/** An uploaded avatar (PNG/JPEG/WebP/GIF, ≤5MiB) as a 512×512 WebP. */
export async function avatarImage(input: Obj) {
  const types: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp", "image/gif": "gif" };
  assert(typeof input.mime === "string" && Object.hasOwn(types, input.mime) && typeof input.data === "string" && input.data.length <= 7 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(input.data), "请上传 5MiB 以内的 PNG、JPEG、WebP 或 GIF 图片");
  const bytes = Buffer.from(input.data, "base64");
  assert(bytes.length > 0 && bytes.length <= 5 * 1024 * 1024, "头像图片不能超过 5MiB");
  const image = sharp(bytes, { limitInputPixels: 16 * 1024 * 1024 });
  const metadata = await image.metadata();
  assert(metadata.format === types[input.mime], "头像内容与图片类型不符");
  return await image.rotate().resize(512, 512, { fit: "cover" }).webp({ quality: 86 }).toBuffer();
}

/** The user's own avatar (shown in their chat bubbles and group avatars); `clear` goes back to the initial. */
export async function updateUserAvatar(store: Store, userId: string, input: Obj) {
  if (input.clear === true) await store.remove("user-avatar", userId);
  else await store.save("user-avatar", userId, { avatar: await store.blob("image/webp", await avatarImage(input)) });
  return { avatar: (await store.object<{ avatar: string }>("user-avatar", userId))?.avatar || "" };
}
