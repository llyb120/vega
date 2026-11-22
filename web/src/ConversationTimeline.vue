<script setup vapor>
import { computed, ref, watch } from "vue";
import MessageText from "./MessageText.vue";
import UserMessage from "./UserMessage.vue";
import TurnProcess from "./TurnProcess.vue";
import ToolSteps from "./ToolSteps.vue";
import { agentPhases } from './agent-phases.js';
import AgentPhaseDetails from './AgentPhaseDetails.vue';
import FileCard from "./FileCard.vue";
import { conversationTurns, toolCaption } from "./conversation";
const props = defineProps({
  messages: { type: Array, default: () => [] },
  running: Boolean,
  live: { type: String, default: "" },
  thinking: { type: String, default: "" },
  activeTools: { type: Array, default: () => [] },
  name: { type: String, default: "Vega" },
  model: String,
  newFrom: { type: Number, default: 0 },
});
const emit = defineEmits(["open"]);
const turns = computed((previous) => conversationTurns(props.messages, { running: props.running, live: props.live, thinking: props.thinking, model: props.model }, previous));
// Attach each phase to the turn containing its first loaded row, including pages starting mid-phase and concurrent phases on the same seq.
const phasesByTurn = computed(() => {
  const bySeq = new Map();
  for (const p of agentPhases(props.messages)) {
    const seq = p.rows[0].seq;
    const list = bySeq.get(seq) || [];
    list.push(p);
    bySeq.set(seq, list);
  }
  return turns.value.map(turn => turn.body.flatMap(m => bySeq.get(m.seq) || []));
});
// 「新」分界：进来时上次看到的位置之后的第一轮（内容可能是旧用户消息加新回复）；来了新消息就收起。
const markGone = ref(false);
const newAt = computed(() => props.newFrom > 0
  ? turns.value.findIndex((turn) => [turn.user, ...turn.body].some((message) => (message?.seq ?? 0) > props.newFrom))
  : -1);
let baseSeq = 0;
watch(() => props.messages.at(-1)?.seq || 0, (seq) => {
  if (!baseSeq) baseSeq = seq;
  else if (seq > baseSeq) markGone.value = true;
}, { immediate: true });
</script>
<template>
  <section v-for="(turn, index) in turns" :key="turn.key" class="conversation-turn">
    <p v-if="newAt > 0 && index === newAt" :class="markGone ? 'chat-new gone' : 'chat-new'" role="separator" aria-label="新消息"><span>新</span></p>
    <article v-if="turn.user" class="message user">
      <UserMessage v-if="turn.user.text" :text="turn.user.displayText || turn.user.text" />
      <img v-for="(image, n) in turn.user.images || []" :key="n" :src="image.url || (image.blobId ? `/api/blobs/${image.blobId}` : `data:${image.mime};base64,${image.data}`)" alt="用户附图" />
      <FileCard v-for="(file, n) in turn.user.files || []" :key="'f' + n" :file="file" />
    </article>
    <div v-if="turn.body.length || turn.running" class="message-meta"><span>{{ name }}</span></div>
    <AgentPhaseDetails v-for="phase in phasesByTurn[index]" :key="phase.callId ? `${phase.seq}:${phase.callId}` : phase.seq" :phase="phase" @open="emit('open', $event)" />
    <TurnProcess v-if="turn.process.length" :messages="turn.body" :started-at="turn.user?.at" :running="turn.running">
      <template v-for="(entry, i) in turn.process" :key="entry.key">
        <p v-if="entry.kind === 'model'" class="turn-model">当前模型 · <code>{{ entry.model }}</code></p>
        <ToolSteps v-else-if="entry.kind === 'process'" :items="entry.items" :active="turn.running && i === turn.lastProcessIndex ? activeTools : []" :live="turn.running && (i === turn.process.length - 1 || (activeTools.length && i === turn.lastProcessIndex))" />
        <article v-else :class="['message', entry.message.role, { continuation: entry.continuation }]">
          <MessageText v-if="entry.message.text" :text="entry.message.displayText || entry.message.text" :streaming="entry.message.streaming" />
          <img v-for="(image, n) in entry.message.images || []" :key="n" :src="image.url || (image.blobId ? `/api/blobs/${image.blobId}` : `data:${image.mime};base64,${image.data}`)" alt="助手附图" />
          <div v-if="entry.message.calls?.length && turn.process[i + 1]?.kind !== 'process'" class="calls"><span v-for="call in entry.message.calls" :key="call.id" :title="toolCaption(call)">↳ {{ toolCaption(call) }}</span></div>
        </article>
      </template>
    </TurnProcess>
    <template v-for="entry in turn.conclusion" :key="entry.key">
      <p v-if="entry.kind === 'model'" class="turn-model">当前模型 · <code>{{ entry.model }}</code></p>
      <article v-else :class="['message', entry.message.role, { continuation: entry.continuation, error: !!entry.message.error }]" :role="entry.message.error ? 'alert' : undefined">
        <MessageText v-if="entry.message.text" :text="entry.message.displayText || entry.message.text" />
        <img v-for="(image, n) in entry.message.images || []" :key="n" :src="image.url || (image.blobId ? `/api/blobs/${image.blobId}` : `data:${image.mime};base64,${image.data}`)" alt="助手附图" />
      </article>
    </template>
    <ToolSteps v-if="turn.running && activeTools.length && turn.lastProcessIndex < 0" :active="activeTools" live />
  </section>
</template>
<style scoped>
.turn-model { margin: 4px 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.message img { max-width: 100%; max-height: 360px; object-fit: contain; }
</style>
