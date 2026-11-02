import sharp from "sharp";
import { isAvatarPreset } from "../../shared/employee-avatars";
import type { Employee } from "./employee";
import { assert, type Obj } from "./util";

export async function updateEmployeeAvatar(employee: Employee, input: Obj) {
  if (input.preset !== undefined) {
    assert(isAvatarPreset(input.preset), "请选择有效的星座头像或默认首字头像");
    await employee.control({ action: "settings", avatar: input.preset });
  } else {
    const types: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp", "image/gif": "gif" };
    assert(typeof input.mime === "string" && Object.hasOwn(types, input.mime) && typeof input.data === "string" && input.data.length <= 7 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(input.data), "请上传 5MiB 以内的 PNG、JPEG、WebP 或 GIF 图片");
    const bytes = Buffer.from(input.data, "base64");
    assert(bytes.length > 0 && bytes.length <= 5 * 1024 * 1024, "头像图片不能超过 5MiB");
    const image = sharp(bytes, { limitInputPixels: 16 * 1024 * 1024 });
    const metadata = await image.metadata();
    assert(metadata.format === types[input.mime], "头像内容与图片类型不符");
    const data = await image.rotate().resize(512, 512, { fit: "cover" }).webp({ quality: 86 }).toBuffer();
    assert(!employee.deleting && !employee.deleted, "员工已删除或正在删除");
    const avatar = employee.store.blob("image/webp", data);
    employee.update(state => { state.avatar = avatar; });
  }
  return { employeeId: employee.employeeId, avatar: employee.state().avatar || "" };
}
