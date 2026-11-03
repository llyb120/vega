import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { computed, reactive, ref, watch } from "vue";
import { BOT_AVATAR_COLORS, botAvatarPreset, defaultBotAvatar, parseBotAvatar } from "../shared/employee-avatars";

const picker = readFileSync("web/src/EmployeeAvatarPicker.vue", "utf8");
const app = readFileSync("web/src/App.vue", "utf8");
function mount(employeeId?: string) {
  const requests: any[] = [], events: any[] = [], readers: any[] = [];
  const props: any = reactive({ employeeId, avatar: "", name: "New bot", image: undefined, disabled: false,
    api: async (...args: any[]) => { requests.push(args); return { employeeId, avatar: args[2].preset }; } });
  let dispose!: () => void;
  const script = picker.match(/<script setup vapor>([^]*?)<\/script>/)![1].replace(/^import .*;\r?\n/gm, "");
  const state = vm.runInNewContext(script + "\n({save, choose, upload, busy, error})", {
    computed, ref, watch, BOT_AVATAR_COLORS, botAvatarPreset, defaultBotAvatar, parseBotAvatar,
    defineProps: () => props, onBeforeUnmount: (fn: any) => dispose = fn,
    defineEmits: () => (event: string, value: any) => { events.push({ event, value }); if (event === "change") { props.avatar = value.avatar; props.image = value.image; } },
    FileReader: class {
      result = "data:image/png;base64,YQ==";
      onload!: () => void;
      readAsDataURL() { readers.push(this); }
    },
  });
  return { ...state, props, requests, events, readers, dispose: () => dispose() };
}

test("creation picker previews presets and image drafts without calling an undefined employee API", async () => {
  const state = mount();
  await state.choose("bot:cloud:teal");
  assert.equal(state.props.avatar, "bot:cloud:teal");
  const reading = state.upload({ target: { files: [{ type: "image/png", size: 1 }], value: "picture.png" } });
  assert.equal(state.busy.value, true);
  assert(state.events.some((event: any) => event.event === "busy" && event.value));
  state.readers[0].onload(); await reading;
  assert.equal(state.props.avatar, "");
  assert.equal(state.props.image.data, "YQ==");
  assert.equal(state.busy.value, false);
  await state.choose("");
  assert.equal(state.props.image, undefined, "restoring default also clears an uploaded draft");
  assert.equal(state.requests.length, 0);
  assert(picker.includes('v-if="image"') && picker.includes("创建时一起保存"));
});

test("existing employee avatar selection still saves immediately, while disabled or disposed pickers cannot save", async () => {
  const state = mount("existing");
  await state.choose("bot:cloud:teal");
  assert.equal(state.requests[0][0], "/employees/existing/avatar");
  state.props.disabled = true;
  await state.choose("bot:cloud:red");
  assert.equal(state.requests.length, 1);
  state.props.disabled = false;
  const reading = state.upload({ target: { files: [{ type: "image/png", size: 1 }], value: "picture.png" } });
  state.dispose(); state.readers[0].onload(); await reading;
  assert.equal(state.requests.length, 1, "a late file read cannot save into another view or account");
  assert.equal(state.props.avatar, "bot:cloud:teal");
});

test("invalid uploads preserve the selected creation avatar", async () => {
  const state = mount();
  await state.choose("bot:cloud:teal");
  await state.upload({ target: { files: [{ type: "image/svg+xml", size: 1 }], value: "bad.svg" } });
  assert.match(state.error.value, /5MiB/);
  assert.equal(state.props.avatar, "bot:cloud:teal");
  assert.equal(state.readers.length, 0);
});

test("creation submits avatar once with the form, preserves it on failure and waits for image reads", async () => {
  const calls: any[] = [], selected: string[] = [];
  let fail = true;
  const scope: any = {
    employeeSaving: ref(false), newEmployeeAvatarBusy: ref(false), newEmployeeName: ref("New bot"), newEmployeeInstruction: ref("work"), project: ref("project"),
    newEmployeeAvatar: ref({ avatar: "bot:cloud:teal", image: undefined }),
    api: async (...args: any[]) => { calls.push(args); if (fail) throw Error("offline"); return { id: "created" }; },
    attempt: async (fn: any) => { try { await fn(); } catch {} }, chooseEmployee: async (id: string) => selected.push(id),
  };
  const source = app.slice(app.indexOf("async function createEmployee()"), app.indexOf("async function deleteEmployee()"));
  const create = vm.runInNewContext(source + "\ncreateEmployee", scope);
  scope.newEmployeeAvatarBusy.value = true;
  await create(); assert.equal(calls.length, 0);
  scope.newEmployeeAvatarBusy.value = false;
  await create();
  assert.equal(calls[0][2].avatar, "bot:cloud:teal");
  assert.equal(scope.newEmployeeAvatar.value.avatar, "bot:cloud:teal");
  assert.equal(scope.newEmployeeName.value, "New bot");
  fail = false;
  scope.newEmployeeAvatar.value = { avatar: "", image: { mime: "image/png", data: "YQ==" } };
  await create();
  assert.equal(calls[1][0], "/employees");
  assert.equal(calls[1][2].avatarImage.data, "YQ==");
  assert.equal(calls.length, 2, "there is no second avatar-upload mutation after employee creation");
  assert.equal(scope.newEmployeeAvatar.value.image, undefined);
  assert.deepEqual(selected, ["created"]);
  assert(app.includes('<EmployeeAvatarPicker :name="newEmployeeName"'));
});
