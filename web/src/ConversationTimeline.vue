<script setup vapor>
import { computed } from "vue";
import MessageText from "./MessageText.vue";
import UserMessage from "./UserMessage.vue";
import TurnProcess from "./TurnProcess.vue";
import ToolSteps from "./ToolSteps.vue";
import { conversationTurns } from "./conversation";
const props = defineProps({
  messages: { type: Array, default: () => [] },
  running: Boolean,
  live: { type: String, default: "" },
  thinking: { type: String, default: "" },
  activeTools: { type: Array, default: () => [] },
  name: { type: String, default: "Vega" },
  model: String,
});
const turns = computed((previous) => conversationTurns(props.messages, { running: props.running, live: props.live, thinking: props.thinking }, previous));
</script>
<template>
  <section v-for="turn in turns" :key="turn.key" class="conversation-turn">
    <article v-if="turn.user" class="message user">
      <UserMessage v-if="turn.user.text" :text="turn.user.displayText || turn.user.text" />
      <img v-for="(image, n) in turn.user.images || []" :key="n" :src="image.blobId ? `/api/blobs/${image.blobId}` : `data:${image.mime};base64,${image.data}`" alt="用户附图" />
    </article>
    <div v-if="turn.body.length || turn.running" class="message-meta"><span>{{ name }}</span><span>{{ turn.body.findLast((message) => message.model)?.model || (turn.running ? model : '') || '' }}</span></div>
    <TurnProcess v-if="turn.process.length" :messages="turn.body" :started-at="turn.user?.at" :running="turn.running">
      <template v-for="(entry, i) in turn.process" :key="entry.key">
        <ToolSteps v-if="entry.kind === 'process'" :items="entry.items" :active="turn.running && i === turn.lastProcessIndex ? activeTools : []" :live="turn.running && (i === turn.process.length - 1 || (activeTools.length && i === turn.lastProcessIndex))" />
        <article v-else :class="['message', entry.message.role, { continuation: entry.continuation }]">
          <MessageText v-if="entry.message.text" :text="entry.message.displayText || entry.message.text" :streaming="entry.message.streaming" />
          <img v-for="(image, n) in entry.message.images || []" :key="n" :src="image.blobId ? `/api/blobs/${image.blobId}` : `data:${image.mime};base64,${image.data}`" alt="助手附图" />
          <div v-if="entry.message.calls?.length && turn.process[i + 1]?.kind !== 'process'" class="calls"><span v-for="call in entry.message.calls" :key="call.id">↳ {{ call.name }}</span></div>
        </article>
      </template>
    </TurnProcess>
    <article v-for="entry in turn.conclusion" :key="entry.key" :class="['message', entry.message.role, { continuation: entry.continuation, error: !!entry.message.error }]" :role="entry.message.error ? 'alert' : undefined">
      <MessageText v-if="entry.message.text" :text="entry.message.displayText || entry.message.text" />
      <img v-for="(image, n) in entry.message.images || []" :key="n" :src="image.blobId ? `/api/blobs/${image.blobId}` : `data:${image.mime};base64,${image.data}`" alt="助手附图" />
    </article>
    <ToolSteps v-if="turn.running && activeTools.length && turn.lastProcessIndex < 0" :active="activeTools" live />
  </section>
</template>
<style scoped>
.message img { max-width: 100%; max-height: 360px; object-fit: contain; }
</style>
