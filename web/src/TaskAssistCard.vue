<script setup vapor>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import MessageText from "./MessageText.vue";
import {
  defaultAssistHint,
  defaultAssistTitle,
  defaultQuickActions,
  defaultSettingsLabel,
  formatAssistAnswer,
  safeExternalUrl,
} from "../../shared/task-assist";

const props = defineProps({
  task: Object,
  archiveBase: String,
  readonly: Boolean,
  busy: Boolean,
  canOpenBrowser: Boolean,
});

const emit = defineEmits(["submit", "open-browser", "open-settings"]);

const selectedOptions = ref([]);
const fieldValues = ref({});
const verificationCode = ref("");
const customText = ref("");
const validationError = ref("");
const lightboxUrl = ref("");
const copiedUrl = ref(false);
let copyTimer = 0;

const assist = computed(() => props.task?.waitingAssist || null);
const kind = computed(() => assist.value?.kind || "general");
const title = computed(() => assist.value?.title || defaultAssistTitle(kind.value));
const hint = computed(() => assist.value?.hint || defaultAssistHint(assist.value || undefined));
const options = computed(() => assist.value?.options || []);
const fields = computed(() => assist.value?.fields || []);
const images = computed(() => assist.value?.images || []);
const browser = computed(() => assist.value?.browser || null);
const quickActions = computed(() => defaultQuickActions(assist.value || undefined));
const externalLink = computed(() => {
  const url = safeExternalUrl(assist.value?.externalUrl?.url);
  return url ? { url, label: assist.value?.externalUrl?.label || "打开相关链接" } : null;
});
const settingsAction = computed(() => {
  const route = assist.value?.settingsRoute;
  if (!route) return null;
  return { route, label: assist.value?.settingsLabel || defaultSettingsLabel(route) };
});

const headerIcon = computed(() => {
  switch (kind.value) {
    case "qr_login": return "qrcode";
    case "browser_action": return "globe";
    case "verification": return "key";
    case "settings": return "settings";
    default: return "alert";
  }
});

const needsDetail = computed(() =>
  selectedOptions.value.some((idx) => options.value[idx]?.needsDetail),
);

const hasStructuredInput = computed(() => options.value.length > 0 || fields.value.length > 0);
const isVerificationOnly = computed(() => kind.value === "verification" && !hasStructuredInput.value);
const isQuickOnly = computed(() =>
  !hasStructuredInput.value && !isVerificationOnly.value && quickActions.value.length > 0,
);
const showCustomSupplement = computed(() =>
  hasStructuredInput.value && (assist.value?.allowCustom !== false || needsDetail.value),
);
const safeBrowserUrl = computed(() => safeExternalUrl(browser.value?.url));
const localBrowserName = computed(() =>
  props.task?.execution?.browserClientName || props.task?.execution?.clientName || "本机设备",
);

function resetState() {
  selectedOptions.value = [];
  const nextFields = {};
  for (const field of fields.value) {
    if (field.defaultValue !== undefined) nextFields[field.key] = field.defaultValue;
    else if (field.type === "checkbox") nextFields[field.key] = false;
    else nextFields[field.key] = "";
  }
  fieldValues.value = nextFields;
  verificationCode.value = "";
  customText.value = "";
  validationError.value = "";
  lightboxUrl.value = "";
  copiedUrl.value = false;
}

watch(
  () => [props.task?.id, props.task?.waiting, props.task?.waitingAssist],
  () => resetState(),
  { immediate: true },
);

function formatShotTime(at) {
  if (!at) return "";
  try {
    return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

function toggleOption(index) {
  if (props.readonly || props.busy) return;
  validationError.value = "";
  if (assist.value?.multiSelect) {
    selectedOptions.value = selectedOptions.value.includes(index)
      ? selectedOptions.value.filter((i) => i !== index)
      : [...selectedOptions.value, index];
  } else {
    selectedOptions.value = selectedOptions.value[0] === index ? [] : [index];
  }
}

function updateField(key, value) {
  validationError.value = "";
  fieldValues.value = { ...fieldValues.value, [key]: value };
}

function submitQuick(reply) {
  if (props.readonly || props.busy) return;
  validationError.value = "";
  emit("submit", reply);
}

function submitStructured() {
  if (props.readonly || props.busy) return;
  const result = formatAssistAnswer(assist.value || undefined, {
    selectedOptions: selectedOptions.value,
    fieldValues: fieldValues.value,
    verificationCode: verificationCode.value,
    customText: customText.value,
  });
  if (!result.ok) {
    validationError.value = result.error;
    return;
  }
  validationError.value = "";
  emit("submit", result.text);
}

function submitManual() {
  if (props.readonly || props.busy) return;
  const text = customText.value.trim();
  if (!text) {
    validationError.value = "请输入补充说明";
    return;
  }
  validationError.value = "";
  emit("submit", text);
}

function openBrowserTab() {
  if (!browser.value) return;
  emit("open-browser", {
    taskId: props.task.id,
    taskTitle: props.task.text,
    tabTag: browser.value.tabTag || "",
    url: browser.value.url || "",
    title: browser.value.title || "",
    kind: kind.value,
  });
}

async function copyBrowserUrl() {
  if (!browser.value?.url || !navigator.clipboard?.writeText) return;
  try {
    await navigator.clipboard.writeText(browser.value.url);
    copiedUrl.value = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copiedUrl.value = false; }, 1800);
  } catch {}
}

function onWindowKey(event) {
  if (event.key === "Escape" && lightboxUrl.value) {
    lightboxUrl.value = "";
  }
}

onMounted(() => window.addEventListener("keydown", onWindowKey));
onBeforeUnmount(() => {
  clearTimeout(copyTimer);
  window.removeEventListener("keydown", onWindowKey);
});
</script>

<template>
  <section class="attention-block assist-card" :class="'kind-' + kind">
    <header class="assist-head">
      <h3><Icon :name="headerIcon" :size="16" /><span>{{ title }}</span></h3>
      <div class="assist-badges">
        <span v-if="options.length" class="badge">{{ assist?.multiSelect ? '可多选' : '单选' }}</span>
        <span v-if="kind === 'qr_login' || images.some((i) => i.volatile)" class="badge warn-pill">有时效</span>
        <span v-if="browser" class="badge">关联网页</span>
      </div>
    </header>

    <div class="assist-question">
      <slot><MessageText :text="task.waiting" :archive-base="archiveBase" /></slot>
    </div>

    <p v-if="hint" class="assist-hint" role="note">
      <Icon :name="kind === 'qr_login' || images.some((i) => i.volatile) ? 'clock' : 'alert'" :size="14" />
      <span>{{ hint }}</span>
    </p>

    <div v-if="images.length" class="assist-media" :class="{ 'is-qr': kind === 'qr_login' }">
      <figure v-for="(img, idx) in images" :key="img.url + ':' + idx" class="assist-figure">
        <button type="button" class="assist-img-btn" :title="'点击放大查看' + (img.caption ? '：' + img.caption : '')" @click="lightboxUrl = img.url">
          <img :src="img.url" :alt="img.caption || '协助截图'" loading="lazy" />
        </button>
        <figcaption class="assist-caption">
          <span>{{ img.caption || (kind === 'qr_login' ? '请使用对应 App 扫描二维码' : '当前页面截图') }}</span>
          <span v-if="img.capturedAt" class="assist-time">截图于 {{ formatShotTime(img.capturedAt) }}</span>
          <a :href="img.url" target="_blank" rel="noopener noreferrer" class="assist-ext-link">原图</a>
        </figcaption>
      </figure>
    </div>

    <div v-if="browser || settingsAction || externalLink" class="assist-shortcuts">
      <div v-if="browser" class="assist-browser-box">
        <div class="assist-browser-meta">
          <Icon name="globe" :size="14" />
          <div class="assist-browser-text">
            <strong class="truncate">{{ browser.title || '浏览器标签页' }}</strong>
            <span v-if="browser.url" class="truncate" :title="browser.url">{{ browser.url }}</span>
          </div>
        </div>
        <div class="assist-browser-actions">
          <button
            v-if="!task.execution?.localBrowser && canOpenBrowser"
            type="button"
            class="primary sm"
            :disabled="busy"
            @click="openBrowserTab"
          >
            <Icon name="external" :size="14" />前往浏览器标签页
          </button>
          <span v-else-if="task.execution?.localBrowser" class="assist-local-tip">
            页面位于本机浏览器（{{ localBrowserName }}），请切换至本机 Chrome 对应标签页操作
          </span>
          <span v-else class="assist-local-tip">
            请由热心市民归属用户在浏览器标签页中完成操作
          </span>
          <button v-if="browser.url" type="button" class="sm" @click="copyBrowserUrl">
            {{ copiedUrl ? '已复制地址' : '复制网址' }}
          </button>
          <a v-if="safeBrowserUrl && task.execution?.localBrowser" :href="safeBrowserUrl" target="_blank" rel="noopener noreferrer" class="button-link sm">新标签打开</a>
        </div>
      </div>

      <div v-if="(settingsAction && !readonly) || externalLink" class="assist-link-row">
        <button v-if="settingsAction && !readonly" type="button" class="sm" :disabled="busy" @click="emit('open-settings', settingsAction.route)">
          <Icon name="settings" :size="14" />{{ settingsAction.label }}
        </button>
        <a v-if="externalLink" :href="externalLink.url" target="_blank" rel="noopener noreferrer" class="button-link sm">
          <Icon name="external" :size="14" />{{ externalLink.label }}
        </a>
      </div>
    </div>

    <template v-if="!readonly">
      <div v-if="options.length" class="assist-options" :role="assist?.multiSelect ? 'group' : 'radiogroup'" aria-label="可选方案">
        <button
          v-for="(opt, idx) in options"
          :key="idx"
          type="button"
          class="assist-option"
          :class="[opt.tone || 'default', { selected: selectedOptions.includes(idx) }]"
          :role="assist?.multiSelect ? 'checkbox' : 'radio'"
          :aria-checked="selectedOptions.includes(idx)"
          :disabled="busy"
          @click="toggleOption(idx)"
        >
          <span class="option-indicator" :class="{ multi: assist?.multiSelect }" aria-hidden="true">
            <Icon v-if="selectedOptions.includes(idx)" name="check" :size="12" />
          </span>
          <span class="option-body">
            <span class="option-title">
              <strong>{{ opt.label }}</strong>
              <span v-if="opt.recommended" class="badge ok">推荐</span>
              <span v-if="opt.needsDetail" class="badge">需补充说明</span>
            </span>
            <span v-if="opt.description" class="option-desc">{{ opt.description }}</span>
          </span>
        </button>
      </div>

      <div v-if="fields.length" class="assist-fields">
        <div v-for="field in fields" :key="field.key" class="assist-field">
          <label v-if="field.type === 'checkbox'" class="check">
            <input
              type="checkbox"
              :checked="fieldValues[field.key] === true"
              :disabled="busy"
              @change="updateField(field.key, $event.target.checked)"
            />
            <span>{{ field.label }}<em v-if="field.required" class="req">*</em></span>
          </label>
          <label v-else>
            <span>{{ field.label }}<em v-if="field.required" class="req">*</em></span>
            <select
              v-if="field.type === 'select' && field.options?.length"
              :value="fieldValues[field.key] ?? ''"
              :disabled="busy"
              @change="updateField(field.key, $event.target.value)"
            >
              <option value="">{{ field.placeholder || '请选择…' }}</option>
              <option v-for="item in field.options" :key="item" :value="item">{{ item }}</option>
            </select>
            <textarea
              v-else-if="field.type === 'textarea'"
              :value="fieldValues[field.key] ?? ''"
              rows="3"
              maxlength="4000"
              :disabled="busy"
              :placeholder="field.placeholder || ''"
              @input="updateField(field.key, $event.target.value)"
            ></textarea>
            <input
              v-else
              type="text"
              :class="{ mono: field.type === 'code' }"
              :value="fieldValues[field.key] ?? ''"
              :disabled="busy"
              :placeholder="field.placeholder || ''"
              :autocomplete="field.type === 'code' ? 'one-time-code' : 'off'"
              @input="updateField(field.key, $event.target.value)"
            />
          </label>
          <small v-if="field.description" class="hint">{{ field.description }}</small>
        </div>
      </div>

      <form v-if="isVerificationOnly" class="assist-code-form" @submit.prevent="submitStructured">
        <label :for="'code-' + task.id" class="sr-only">验证码</label>
        <input
          :id="'code-' + task.id"
          v-model="verificationCode"
          type="text"
          class="code-input mono"
          maxlength="128"
          autocomplete="one-time-code"
          :disabled="busy"
          placeholder="输入短信 / 邮箱 / 2FA 验证码或访问码"
        />
        <button class="primary" :disabled="busy || !verificationCode.trim()">提交验证码并继续</button>
      </form>

      <div v-if="quickActions.length" class="assist-quick-actions">
        <button
          v-for="(act, idx) in quickActions"
          :key="idx"
          type="button"
          :class="act.tone === 'primary' ? 'primary' : act.tone === 'danger' ? 'danger' : ''"
          :disabled="busy"
          @click="submitQuick(act.reply)"
        >
          <Icon v-if="act.tone === 'primary'" name="check" :size="15" />
          {{ act.label }}
        </button>
      </div>

      <form v-if="hasStructuredInput" class="assist-submit-form" @submit.prevent="submitStructured">
        <template v-if="showCustomSupplement">
          <label :for="'answer-' + task.id" class="sr-only">补充说明</label>
          <textarea
            :id="'answer-' + task.id"
            v-model="customText"
            rows="2"
            maxlength="8000"
            :disabled="busy"
            :placeholder="needsDetail ? '请补充具体说明（必填）…' : '可选：补充其他说明或备注'"
          ></textarea>
        </template>
        <p v-if="validationError" class="error" role="alert">{{ validationError }}</p>
        <div class="actions end">
          <button class="primary" :disabled="busy">
            <Icon name="check" :size="15" />{{ options.length && !fields.length ? '确认选择并继续' : '提交并继续' }}
          </button>
        </div>
      </form>

      <details v-else-if="isQuickOnly || isVerificationOnly" class="assist-manual-fold">
        <summary>手动输入回复内容</summary>
        <form class="assist-manual-form" @submit.prevent="submitManual">
          <textarea
            :id="'answer-' + task.id"
            v-model="customText"
            rows="2"
            maxlength="8000"
            :disabled="busy"
            placeholder="如果快捷操作不适用，可在此输入具体情况…"
          ></textarea>
          <p v-if="validationError" class="error" role="alert">{{ validationError }}</p>
          <div class="actions end">
            <button type="submit" :disabled="busy || !customText.trim()">回复并继续</button>
          </div>
        </form>
      </details>

      <form v-else class="assist-manual-form" @submit.prevent="submitManual">
        <label class="sr-only" :for="'answer-' + task.id">你的回复</label>
        <textarea
          :id="'answer-' + task.id"
          v-model="customText"
          rows="3"
          maxlength="8000"
          required
          :disabled="busy"
          placeholder="补充信息后，热心市民会继续处理原任务"
        ></textarea>
        <p v-if="validationError" class="error" role="alert">{{ validationError }}</p>
        <div class="actions end">
          <button class="primary" :disabled="busy || !customText.trim()">回复并继续</button>
        </div>
      </form>
    </template>

    <div v-if="lightboxUrl" class="assist-lightbox" role="dialog" aria-modal="true" aria-label="图片放大预览" @click.self="lightboxUrl = ''">
      <div class="assist-lightbox-card">
        <button type="button" class="icon assist-lightbox-close" aria-label="关闭放大预览" @click="lightboxUrl = ''">
          <Icon name="close" :size="18" />
        </button>
        <img :src="lightboxUrl" alt="放大后的协助图片" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.assist-card { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; padding: 14px 16px; border: 1px solid var(--warn-border); border-radius: var(--r-lg); background: var(--warn-soft); }
.assist-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.assist-head h3 { display: flex; align-items: center; gap: 6px; color: var(--warn); font-size: 13.5px; }
.assist-badges { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.warn-pill { background: color-mix(in srgb, var(--warn) 14%, transparent); color: var(--warn); }
.assist-question :deep(.markdown-body) { font-size: 13px; line-height: 1.6; }
.assist-hint { display: flex; align-items: flex-start; gap: 6px; padding: 8px 10px; border: 1px solid var(--warn-border); border-radius: var(--r-md); background: color-mix(in srgb, var(--surface) 78%, transparent); color: var(--text-2); font-size: 12px; line-height: 1.5; }
.assist-hint .icon-svg { margin-top: 2px; color: var(--warn); }

.assist-media { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.assist-media.is-qr { grid-template-columns: minmax(0, 260px); }
.assist-figure { display: grid; gap: 6px; margin: 0; padding: 10px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); }
.assist-media.is-qr .assist-figure { justify-items: center; padding: 14px; }
.assist-img-btn { display: grid; place-items: center; width: 100%; height: auto; padding: 0; border: 0; border-radius: var(--r-sm); background: #fff; overflow: hidden; cursor: zoom-in; }
.assist-img-btn:hover:not(:disabled) { background: #fff; opacity: .95; }
.assist-img-btn img { display: block; max-width: 100%; max-height: 260px; width: auto; height: auto; object-fit: contain; }
.assist-media.is-qr .assist-img-btn img { max-height: 220px; }
.assist-caption { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; width: 100%; color: var(--text-2); font-size: 11.5px; }
.assist-time { color: var(--muted); }
.assist-ext-link { margin-left: auto; font-size: 11.5px; }

.assist-shortcuts { display: grid; gap: 8px; }
.assist-browser-box { display: grid; gap: 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); }
.assist-browser-meta { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.assist-browser-meta .icon-svg { margin-top: 2px; color: var(--accent); }
.assist-browser-text { display: grid; min-width: 0; flex: 1; }
.assist-browser-text strong { font-size: 12.5px; font-weight: 600; color: var(--text); }
.assist-browser-text span { color: var(--muted); font-size: 11.5px; }
.assist-browser-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.assist-local-tip { color: var(--text-2); font-size: 12px; line-height: 1.45; }
.assist-link-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.assist-options { display: grid; gap: 6px; }
.assist-option { display: flex; align-items: flex-start; justify-content: flex-start; gap: 10px; width: 100%; height: auto; padding: 10px 12px; border: 1px solid var(--border-strong); border-radius: var(--r-md); background: var(--surface); color: var(--text); font-weight: 400; text-align: left; white-space: normal; }
.assist-option:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-softer); }
.assist-option.selected { border-color: var(--accent); background: var(--accent-softer); box-shadow: 0 0 0 2px var(--accent-ring); }
.assist-option.danger.selected { border-color: var(--danger); background: var(--danger-soft); box-shadow: none; }
.option-indicator { display: grid; place-items: center; flex: none; width: 18px; height: 18px; margin-top: 1px; border: 1.5px solid var(--border-strong); border-radius: 50%; background: var(--surface); color: #fff; }
.option-indicator.multi { border-radius: 5px; }
.assist-option.selected .option-indicator { border-color: var(--accent); background: var(--accent); }
.assist-option.danger.selected .option-indicator { border-color: var(--danger); background: var(--danger); }
.option-body { display: grid; gap: 3px; flex: 1; min-width: 0; }
.option-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.option-title strong { font-size: 13px; font-weight: 500; }
.option-desc { color: var(--text-2); font-size: 12px; line-height: 1.45; }

.assist-fields { display: grid; gap: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); }
.assist-field { display: grid; gap: 4px; }
.assist-field > label:not(.check) { display: grid; gap: 4px; }
.req { margin-left: 2px; color: var(--danger); font-style: normal; }

.assist-code-form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.code-input { flex: 1 1 200px; background: var(--surface); font-size: 14px; letter-spacing: .06em; }

.assist-quick-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.assist-submit-form, .assist-manual-form { display: grid; gap: 8px; }
.assist-submit-form textarea, .assist-manual-form textarea { width: 100%; background: var(--surface); }
.assist-manual-fold summary { color: var(--text-2); font-size: 12px; font-weight: 500; }
.assist-manual-fold[open] summary { margin-bottom: 8px; }

.assist-lightbox { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 20px; background: rgb(15 20 30 / 68%); }
.assist-lightbox-card { position: relative; max-width: min(92vw, 720px); max-height: 90vh; padding: 12px; border-radius: var(--r-lg); background: #fff; box-shadow: var(--sh-lg); }
.assist-lightbox-card img { display: block; max-width: 100%; max-height: calc(90vh - 24px); object-fit: contain; }
.assist-lightbox-close { position: absolute; top: 8px; right: 8px; background: var(--surface); box-shadow: var(--sh-sm); }
</style>
