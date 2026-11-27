<script setup vapor>
import MessageText from "./MessageText.vue";
import UserMessage from "./UserMessage.vue";
import EmployeeAvatar from "./EmployeeAvatar.vue";
import UserAvatar from "./UserAvatar.vue";
import Icon from "./Icon.vue";
import MoodWeather from "./MoodWeather.vue";
import FileCard from "./FileCard.vue";
import PreviewCard from "./PreviewCard.vue";
import StepOutput from "./StepOutput.vue";
import { computed, ref } from "vue";
import { taskLabel, taskTone, shortTime } from "./task-status";
import { cleanTaskTitle, taskDisplayTitle } from "./conversation";
import { chainEdgeLabel } from "../../shared/task-chain";
import PressMention from "./PressMention.vue";
import { exportResult, exportTitleOf } from "./export-result.js";
import { filesArchiveBase } from "./markdown.js";
import { quoteOf } from "../../shared/chat-quote";
const props = defineProps({ message: Object, name: String, avatar: String, employeeId: String, taskStatus: Object, tasks: Array, hiddenTaskIds: Set, hideStepOutput: Boolean, topicContext: Object, loadStepOutput: Function, quotable: Boolean, rememberable: Boolean, continued: Boolean, viewerId: String, openAuthor: Boolean, mentionAuthor: Boolean, selfTint: Object, moodWeather: String });
const emit = defineEmits(["quote", "jump", "task", "retry", "remember", "author", "mention"]);
// In a group, long-pressing an employee's avatar @mentions it in the composer (mentionAuthor); a tap still opens it.
const pressable = computed(() => props.mentionAuthor && sender.value.kind === "employee");
const exportOpen = ref(false), exportError = ref("");
// Task links show the employee's live task status (the copy stored in the message is a snapshot from when it was written).
// In a group every message carries its author (a user or an employee, avatar filled in by the group view); only the
// viewer's own messages sit on the right. A private chat has no authors: user messages are mine, the rest the employee's.
const mine = computed(() => props.message.role === "user" && (!props.message.author || props.message.author.id === props.viewerId));
const source = computed(() => props.quotable && quoteOf(props.message));
const replyLabel = computed(() => props.message.author ? "回复" : "引用");
const quoteName = computed(() => props.message.quote?.author?.name || (props.message.quote?.role === "user" ? "我" : props.name));
// Earlier step outputs were saved inside the chat body; present them as cards without rewriting history.
const legacyOutput = computed(() => {
  const prefix = "**步骤产物（任务未完成）**\n\n", text = String(props.message.text || "");
  if (props.message.stepOutput !== true || !text.startsWith(prefix)) return;
  const rest = text.slice(prefix.length), split = rest.indexOf("\n\n");
  return { label: split < 0 ? "历史步骤产物" : rest.slice(0, split), text: split < 0 ? rest : rest.slice(split + 2) };
});
const loadedStep = ref(null), stepLoading = ref(false), stepError = ref("");
const stepOutput = computed(() => loadedStep.value || (typeof props.message.stepOutput === "object" ? props.message.stepOutput : legacyOutput.value));
const bodyText = computed(() => legacyOutput.value ? "步骤产物已保存。" : props.message.displayText || props.message.text);
const sender = computed(() => props.message.author ? { kind: props.message.author.kind, id: props.message.author.id, name: props.message.author.name, avatar: props.message.author.avatar || "" } : { kind: "employee", id: props.employeeId, name: props.name, avatar: props.avatar });
// My own bubbles take the color of the employee I am talking to (the chat view passes it); their replies stay neutral.
const tint = computed(() => (mine.value && !props.message.error ? props.selfTint : undefined));
const statusOf = (task) => props.taskStatus?.[task.id] ?? (props.tasks ? "deleted" : task.status);
const taskInfoOf = (taskId) => (props.tasks || []).find((task) => task.id === taskId);
const attachedTasks = computed(() => (props.message.tasks || []).filter((task) => !props.hiddenTaskIds?.has(task.id)));
const topicStatus = computed(() => props.topicContext ? (props.taskStatus?.[props.topicContext.id] ?? props.topicContext.status) : "");
const topicDeleted = computed(() => topicStatus.value === "deleted");
const topicTitle = computed(() => cleanTaskTitle(props.topicContext?.title) || (topicDeleted.value ? "已删除的任务" : "关联任务"));
const showTopicHeader = computed(() => !!props.topicContext && !props.continued);
const promotedTopicTask = computed(() => showTopicHeader.value && attachedTasks.value.some((task) => task.id === props.topicContext.id));
const footerTasks = computed(() => promotedTopicTask.value ? attachedTasks.value.filter((task) => task.id !== props.topicContext.id) : attachedTasks.value);
const bubbleStyle = computed(() => {
  const topicColor = props.topicContext?.color && !props.message.error ? { "--topic-color": props.topicContext.color } : undefined;
  if (!tint.value && !topicColor) return undefined;
  return { ...tint.value, ...topicColor };
});
const stepTask = computed(() => typeof props.message.stepOutput === "object" && !props.message.stepOutput?.legacy ? props.message.tasks?.[0] : undefined);
const canOpenStep = computed(() => !!stepTask.value && statusOf(stepTask.value) !== "deleted");
const showStepLink = computed(() => !props.hideStepOutput && !!stepOutput.value && (canOpenStep.value || (stepOutput.value.omitted && !loadedStep.value)));
const hasBubbleLinks = computed(() => showStepLink.value || footerTasks.value.length > 0);
async function openStep() {
  if (canOpenStep.value) { emit("task", stepTask.value.id); return; }
  if (!props.loadStepOutput || stepLoading.value) return;
  stepLoading.value = true; stepError.value = "";
  try { loadedStep.value = await props.loadStepOutput(props.message.seq, props.message); }
  catch (error) {
    if (typeof props.message.stepOutput === "object" && !props.message.stepOutput.omitted) loadedStep.value = props.message.stepOutput;
    else stepError.value = error?.message || String(error);
  }
  finally { stepLoading.value = false; }
}
const linkedTask = computed(() => {
  const id = props.message.tasks?.[0]?.id;
  return id ? (props.tasks || []).find((task) => task.id === id) : undefined;
});
// Delivery bubbles stay brief; export always prefers the live task's full result.
// Bubble text stays brief; export always pulls the live task's full result, never the truncated delivery summary.
const exportMarkdown = computed(() => {
  const task = linkedTask.value;
  if (!task) return "";
  return String(task.result || task.completion || "").trim();
});
const archiveBase = computed(() => filesArchiveBase(props.employeeId, linkedTask.value?.id || props.message.tasks?.[0]?.id));
const canExport = computed(() => props.message.delivery && !!exportMarkdown.value);
const exportTitle = computed(() => exportTitleOf(linkedTask.value?.text || props.message.tasks?.[0]?.title));
async function runExport(format) {
  exportError.value = "";
  try {
    await exportResult(format, { title: exportTitle.value, request: linkedTask.value?.text, markdown: exportMarkdown.value, archiveBase: archiveBase.value });
    exportOpen.value = false;
  } catch (error) {
    exportError.value = error?.message || String(error);
  }
}
</script>
<template>
  <article class="chat-message" :class="[mine ? 'user' : 'assistant', { continued, authored: !!message.author }]" :data-message-seq="message.seq" tabindex="-1">
    <span v-if="!mine && continued" class="chat-avatar spacer" aria-hidden="true"></span>
    <span v-else-if="!mine" class="chat-avatar-wrap">
      <button v-if="openAuthor" type="button" class="chat-avatar author-link" :aria-label="'打开和 ' + sender.name + ' 的聊天'" :title="'打开和 ' + sender.name + ' 的聊天'" @click="emit('author', sender.id)"><PressMention :name="sender.name" :disabled="!pressable" @press="emit('mention', $event)"><EmployeeAvatar :employee-id="sender.id" :name="sender.name" :avatar="sender.avatar" /></PressMention></button>
      <span v-else class="chat-avatar" aria-hidden="true"><UserAvatar v-if="sender.kind === 'user'" :user-id="sender.id" :name="sender.name" :avatar="sender.avatar" /><PressMention v-else :name="sender.name" :disabled="!pressable" @press="emit('mention', $event)"><EmployeeAvatar :employee-id="sender.id" :name="sender.name" :avatar="sender.avatar" /></PressMention></span>
      <MoodWeather v-if="moodWeather && sender.kind === 'employee'" :weather="moodWeather" class="avatar-weather" />
    </span>
    <div class="chat-content">
      <div class="chat-heading">
        <button v-if="!mine && !continued && openAuthor" type="button" class="author-name" @click="emit('author', sender.id)">{{ sender.name }}</button>
        <strong v-else-if="!mine && !continued">{{ sender.name }}</strong>
        <span v-if="!mine && !continued && sender.kind === 'user' && message.author" class="author-tag">用户</span>
        <time v-if="message.at">{{ shortTime(message.at) }}</time>
        <button v-if="source" type="button" class="chat-reply" :aria-label="replyLabel + '这条消息'" :title="replyLabel" @click="emit('quote', source)"><Icon name="reply" :size="13" /><span class="reply-label">{{ replyLabel }}</span></button>
        <button v-if="rememberable && !mine && message.text" type="button" class="chat-reply" aria-label="记住这句" title="记住这句" @click="emit('remember', message)"><Icon name="memory" :size="13" /><span class="reply-label">记住</span></button>
      </div>
      <button v-if="message.quote" type="button" class="chat-quote" :aria-label="'跳转到 ' + quoteName + ' 的消息：' + message.quote.text" @click="emit('jump', message.quote.seq)"><Icon name="reply" :size="12" /><strong>{{ quoteName }}</strong><span>{{ message.quote.text }}</span></button>
      <div v-if="message.taskRefs?.length" class="chat-task-refs">
        <button v-for="ref in message.taskRefs" :key="ref.id" type="button" class="chat-task-ref" @click="emit('task', ref.id)">
          <Icon name="tasks" :size="12" />
          <span v-if="ref.chainSeq" class="ref-seq">#{{ ref.chainSeq }}</span>
          <span class="ref-title">{{ taskDisplayTitle(taskInfoOf(ref.id) || ref) || ref.id }}</span>
        </button>
      </div>
      <div class="chat-bubble" :class="{ failed: message.error, tinted: !!tint, 'has-topic': !!topicContext?.color && !message.error }" :style="bubbleStyle" :role="message.error ? 'alert' : undefined">
        <button v-if="showTopicHeader" type="button" class="chat-topic-header" :class="{ 'chat-task-link': promotedTopicTask }" :data-task-id="promotedTopicTask ? topicContext.id : undefined" :disabled="topicDeleted" :title="topicContext.title || topicTitle" :aria-label="(topicDeleted ? '任务已删除：' : '查看任务话题：') + topicTitle" @click="emit('task', topicContext.id)">
          <i class="topic-dot" :style="{ background: topicContext.color }" aria-hidden="true"></i>
          <span class="chat-link-text">{{ topicTitle }}</span>
          <span v-if="topicStatus" :class="['badge', taskTone(topicStatus)]">{{ taskLabel(topicStatus) }}</span>
          <Icon v-if="!topicDeleted" name="right" :size="13" />
        </button>
        <UserMessage v-if="message.role === 'user' && message.text" :text="message.displayText || message.text" />
        <MessageText v-else-if="message.text" :text="bodyText" :streaming="message.streaming" :archive-base="archiveBase" />
        <img v-for="(image, index) in message.images || []" :key="index" :src="image.url || (image.blobId ? `/api/blobs/${image.blobId}` : `data:${image.mime};base64,${image.data}`)" alt="消息附图" />
        <FileCard v-for="(file, index) in message.files || []" :key="'f' + index" :file="file" />
        <PreviewCard v-if="message.preview" :preview="message.preview" />
        <template v-if="showStepLink && stepOutput">
          <FileCard v-for="(file, index) in stepOutput.files || []" :key="'sf' + (file.blobId || index)" :file="file" />
          <PreviewCard v-if="stepOutput.preview" :preview="stepOutput.preview" />
        </template>
        <div v-if="hasBubbleLinks" class="chat-bubble-links">
          <button v-if="showStepLink" type="button" class="chat-bubble-link chat-step-output" :aria-label="'查看步骤产物：' + (stepOutput.label || '任务详情')" :disabled="!canOpenStep && (!loadStepOutput || stepLoading)" @click="openStep">
            <Icon name="file" :size="13" />
            <span class="chat-link-text">步骤产物<template v-if="stepOutput.step"> · 第 {{ stepOutput.step }} 步</template>：{{ stepOutput.label }}<template v-if="!canOpenStep && stepLoading">（正在读取…）</template></span>
            <Icon name="right" :size="13" />
          </button>
          <button v-for="task in footerTasks" :key="task.id" type="button" class="chat-bubble-link chat-task-link" :data-task-id="task.id" :disabled="statusOf(task) === 'deleted'" :aria-label="(statusOf(task) === 'deleted' ? '任务已删除：' : '查看任务：') + task.title" @click="emit('task', task.id)">
            <Icon name="tasks" :size="13" />
            <span v-if="taskInfoOf(task.id)?.chainSeq" class="chat-chain-tag">#{{ taskInfoOf(task.id).chainSeq }}<template v-if="taskInfoOf(task.id)?.edgeKind"> {{ chainEdgeLabel(taskInfoOf(task.id).edgeKind) }}</template></span>
            <span class="chat-link-text">任务：{{ taskDisplayTitle(taskInfoOf(task.id) || task) }}</span>
            <span v-if="statusOf(task)" :class="['badge', taskTone(statusOf(task))]">{{ taskLabel(statusOf(task)) }}</span>
            <Icon v-if="statusOf(task) !== 'deleted'" name="right" :size="13" />
          </button>
        </div>
      </div>
      <StepOutput v-if="!hideStepOutput && stepOutput && !showStepLink" :output="stepOutput" :archive-base="archiveBase" :initially-open="!!loadedStep" />
      <p v-if="!hideStepOutput && stepError" class="chat-step-error" role="alert">{{ stepError }}</p>
      <div v-if="message.sendStatus" class="chat-send-status" role="status">
        <span v-if="message.sendStatus === 'sending'"><span class="spinner" aria-hidden="true"></span>发送中…</span>
        <button v-else-if="message.sendStatus === 'failed'" type="button" :disabled="!quotable" :title="message.sendError" aria-label="重发这条消息" @click="emit('retry', message)">发送未确认 · 点击重发</button>
        <span v-else>已送达</span>
      </div>
      <div v-if="canExport" class="chat-export">
        <button type="button" class="chat-export-toggle" :aria-expanded="exportOpen" @click="exportOpen = !exportOpen"><Icon name="download" :size="14" />导出完整结果</button>
        <div v-if="exportOpen" class="chat-export-menu" role="menu">
          <button type="button" role="menuitem" @click="runExport('html')">HTML</button>
          <button type="button" role="menuitem" @click="runExport('pdf')">PDF</button>
          <button type="button" role="menuitem" @click="runExport('docx')">DOCX</button>
          <button type="button" role="menuitem" @click="runExport('xlsx')">XLSX</button>
        </div>
        <p v-if="exportError" class="chat-export-error" role="alert">{{ exportError }}</p>
      </div>
    </div>
    <span v-if="mine && message.author && continued" class="chat-avatar spacer" aria-hidden="true"></span>
    <span v-else-if="mine && message.author" class="chat-avatar" aria-hidden="true"><UserAvatar :user-id="message.author.id" :name="message.author.name" :avatar="message.author.avatar" /></span>
  </article>
</template>
<style scoped>
.chat-message { display: flex; align-items: flex-start; gap: var(--chat-gap); margin: 0 0 18px; min-width: 0; outline: none; }
.chat-message.user { justify-content: flex-end; }
/* Consecutive messages from the same sender and task pack tightly into one visual block while staying individual bubbles. */
.chat-message.continued { margin-top: -14px; }
.chat-avatar.spacer { height: 0; background: none; }
.chat-avatar-wrap { position: relative; flex: none; width: var(--chat-avatar); height: var(--chat-avatar); }
.chat-avatar { display: grid; place-items: center; flex: none; width: var(--chat-avatar); height: var(--chat-avatar); overflow: hidden; border-radius: 12px; background: var(--accent-soft); color: var(--accent-text); font-size: 16px; font-weight: 600; }
.avatar-weather { position: absolute; right: -5px; bottom: -5px; z-index: 2; }
/* One shrinkable column: grid items default to an automatic minimum of their min-content width, so a single
   nowrap child (a long task title, URL or code line) would otherwise widen the track past the screen. */
.chat-content { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; min-width: 0; max-width: min(100% - var(--chat-avatar) - var(--chat-gap), 680px); }
.chat-content > * { min-width: 0; }
.user .chat-content { justify-items: end; max-width: min(85%, 620px); }
.user .chat-content > * { max-width: 100%; }
.chat-heading { display: flex; align-items: center; gap: 8px; min-height: 20px; color: var(--muted); font-size: 11px; }
.chat-message.continued .chat-heading { position: absolute; top: -13px; left: 8px; z-index: 2; min-height: 0; padding: 0 6px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); box-shadow: var(--sh-sm); line-height: 18px; white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity .12s; }
.chat-message.user.continued .chat-heading { left: auto; right: 8px; }
.chat-message.continued:hover .chat-heading, .chat-message.continued:focus-within .chat-heading { opacity: 1; pointer-events: auto; }
.chat-message.continued .chat-heading:empty { display: none; }
.chat-heading strong { color: var(--text-2); font-size: 12px; font-weight: 600; }
.author-tag { padding: 0 6px; border-radius: 999px; background: var(--surface-3); color: var(--muted); font-size: 11px; }
.chat-send-status { color: var(--muted); font-size: 11px; }
.chat-send-status > span { display: flex; align-items: center; gap: 5px; }
.chat-send-status .spinner { width: 11px; height: 11px; }
.chat-send-status button { min-height: 28px; padding: 2px 4px; border: 0; background: transparent; color: var(--danger); font-size: 12px; }
.chat-reply { gap: 3px; min-height: 20px; padding: 0 4px; border: 0; background: transparent; color: var(--muted); font-size: 11px; font-weight: 400; opacity: 0; }
.chat-message:hover .chat-reply, .chat-message:focus-within .chat-reply, .chat-reply:focus-visible { opacity: 1; }
.chat-reply:hover:not(:disabled) { background: var(--surface-2); color: var(--accent); }
.chat-bubble { justify-self: start; min-width: 0; max-width: 100%; padding: 9px 13px; border-radius: 4px 14px 14px 14px; background: var(--surface-2); line-height: 1.65; overflow-wrap: anywhere; }
.chat-bubble.has-topic { border-radius: 6px 14px 14px 6px; box-shadow: inset 3px 0 var(--topic-color); }
/* Stacked bubbles keep large rounding only on the group's outer corners so the inner edge reads as one straight column. */
.chat-message:not(.continued):has(+ .chat-message.continued) .chat-bubble { border-radius: 4px 14px 6px 2px; }
.chat-message.continued:has(+ .chat-message.continued) .chat-bubble { border-radius: 2px 6px 6px 2px; }
.chat-message.continued:not(:has(+ .chat-message.continued)) .chat-bubble { border-radius: 2px 6px 14px 14px; }
.chat-message:not(.continued):has(+ .chat-message.continued) .chat-bubble.has-topic { border-radius: 6px 14px 6px 0; }
.chat-message.continued:has(+ .chat-message.continued) .chat-bubble.has-topic { border-radius: 0 6px 6px 0; }
.chat-message.continued:not(:has(+ .chat-message.continued)) .chat-bubble.has-topic { border-radius: 0 6px 14px 6px; }
.user .chat-bubble { justify-self: end; border-radius: 14px 4px 14px 14px; background: var(--accent-soft); color: #13254f; }
.user .chat-bubble.has-topic { border-radius: 14px 6px 6px 14px; box-shadow: inset -3px 0 var(--topic-color); }
.chat-message.user:not(.continued):has(+ .chat-message.user.continued) .chat-bubble { border-radius: 14px 4px 2px 6px; }
.chat-message.user.continued:has(+ .chat-message.user.continued) .chat-bubble { border-radius: 6px 2px 2px 6px; }
.chat-message.user.continued:not(:has(+ .chat-message.user.continued)) .chat-bubble { border-radius: 6px 2px 14px 14px; }
.chat-message.user:not(.continued):has(+ .chat-message.user.continued) .chat-bubble.has-topic { border-radius: 14px 6px 0 6px; }
.chat-message.user.continued:has(+ .chat-message.user.continued) .chat-bubble.has-topic { border-radius: 6px 0 0 6px; }
.chat-message.user.continued:not(:has(+ .chat-message.user.continued)) .chat-bubble.has-topic { border-radius: 6px 0 6px 14px; }
/* A colored bubble keeps its links and mentions readable instead of accent-blue on the same color. */
.chat-bubble.tinted :deep(a), .chat-bubble.tinted :deep(.mention) { color: inherit; text-decoration: underline; }
.chat-bubble.failed { background: var(--danger-soft); box-shadow: inset 3px 0 var(--danger); }
.chat-topic-header { display: flex; align-items: center; justify-content: flex-start; gap: 6px; width: calc(100% + 10px); min-width: 0; height: auto; min-height: 24px; margin: -2px -5px 0; padding: 2px 5px; border: 0; border-radius: 6px; background: transparent; color: var(--text-2); font-size: 12px; font-weight: 500; line-height: 1.4; text-align: left; }
.chat-topic-header:not(:last-child) { margin-bottom: 7px; padding-bottom: 6px; border-bottom: 1px solid color-mix(in srgb, var(--border) 85%, transparent); border-radius: 6px 6px 0 0; }
.chat-topic-header:hover:not(:disabled) { background: var(--accent-softer); color: var(--accent); }
.chat-topic-header:hover:not(:disabled) .chat-link-text { text-decoration: underline; text-underline-offset: 2px; }
.chat-topic-header:disabled { color: var(--muted); opacity: .75; }
.chat-topic-header > .badge, .chat-topic-header > .icon-svg { flex: none; }
.chat-topic-header > .icon-svg:last-child { color: var(--faint); }
.topic-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; }
.user .chat-topic-header { color: inherit; }
.user .chat-topic-header:not(:last-child) { border-bottom-color: rgb(19 37 79 / 12%); }
.user .chat-topic-header:hover:not(:disabled) { background: rgb(19 37 79 / 6%); color: inherit; }
.chat-message:focus .chat-bubble { outline: 2px solid var(--accent); outline-offset: 2px; }
.chat-bubble :deep(.message-text) { font-size: 14px; }
.chat-bubble :deep(.code-block) { margin-left: -4px; margin-right: -4px; }
.author-link { padding: 0; border: 0; cursor: pointer; }
.author-link:hover:not(:disabled) { background: var(--accent-soft); filter: brightness(1.05); }
.author-name { height: auto; min-height: 0; padding: 0; border: 0; background: transparent; color: var(--text-2); font-size: 12px; font-weight: 600; }
.author-name:hover:not(:disabled) { background: transparent; color: var(--accent-text); text-decoration: underline; }
.chat-bubble img { display: block; max-width: 100%; max-height: 360px; margin-top: 6px; border-radius: var(--r-md); }
.chat-quote { display: flex; justify-content: start; justify-self: start; gap: 5px; max-width: min(100%, 28rem); height: auto; min-height: 24px; padding: 2px 6px; border: 0; border-radius: 6px; background: transparent; color: var(--text-2); font-size: 12px; font-weight: 400; line-height: 18px; text-align: left; white-space: nowrap; }
.user .chat-quote { justify-self: end; }
.chat-quote:hover:not(:disabled) { background: var(--surface-2); color: var(--text-2); }
.chat-quote strong { max-width: 40%; }
.chat-quote strong, .chat-quote span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.chat-task-refs { display: flex; flex-wrap: wrap; gap: 4px; max-width: 100%; }
.user .chat-task-refs { justify-content: flex-end; }
.chat-task-ref { display: inline-flex; align-items: center; gap: 4px; max-width: min(100%, 22rem); height: auto; min-height: 22px; padding: 2px 7px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text-2); font-size: 11.5px; font-weight: 400; }
.chat-task-ref:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-text); }
.chat-task-ref .ref-seq { flex: none; color: var(--muted); font-weight: 600; font-variant-numeric: tabular-nums; }
.chat-task-ref .ref-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-chain-tag { flex: none; padding: 0 4px; border-radius: 4px; background: var(--surface-3); color: var(--text-2); font-size: 10.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.chat-bubble-links { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; min-width: 0; }
.chat-bubble-links:not(:first-child) { margin-top: 7px; padding-top: 6px; border-top: 1px solid var(--border); }
.chat-bubble-link { display: flex; align-items: center; justify-content: flex-start; gap: 5px; width: calc(100% + 8px); min-width: 0; height: auto; min-height: 24px; margin: 0 -4px; padding: 2px 4px; border: 0; border-radius: 6px; background: transparent; color: var(--accent-text); font-size: 12px; font-weight: 500; line-height: 1.45; text-align: left; }
.chat-bubble-link:hover:not(:disabled) { background: var(--accent-softer); color: var(--accent); }
.chat-bubble-link:hover:not(:disabled) .chat-link-text { text-decoration: underline; text-underline-offset: 2px; }
.chat-bubble-link:disabled { color: var(--muted); opacity: .75; }
.chat-bubble-link > .icon-svg { flex: none; opacity: .85; }
.chat-bubble-link > .icon-svg:last-child { color: var(--faint); }
.chat-bubble-link > .badge { flex: none; }
.chat-link-text { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-step-error { margin: 0; color: var(--danger); font-size: 12px; }
.chat-export { display: grid; justify-items: start; gap: 4px; width: 100%; }
.chat-export-toggle { gap: 6px; min-height: 30px; padding: 0 8px; border-color: var(--border); background: var(--surface); color: var(--text-2); font-size: 12px; font-weight: 500; }
.chat-export-toggle:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-softer); color: var(--accent); }
.chat-export-menu { display: flex; flex-wrap: wrap; gap: 4px; }
.chat-export-menu button { min-height: 28px; padding: 0 10px; border-color: var(--border); background: var(--surface); font-size: 12px; }
.chat-export-error { margin: 0; color: var(--danger); font-size: 12px; }
.chat-bubble :deep(.markdown-table) { max-width: 100%; }
.chat-bubble :deep(.markdown-body img) { max-width: 100%; max-height: 360px; height: auto; }
@media (hover: none) { .chat-reply { opacity: .7; } .reply-label { display: none; } }
@media (max-width: 767px) {
  .chat-message { margin-bottom: 16px; }
  .chat-message.continued { margin-top: -12px; }
  .user .chat-content { max-width: 88%; }
  .chat-reply { min-height: 28px; padding: 0 6px; }
}
</style>
