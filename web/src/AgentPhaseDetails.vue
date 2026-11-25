<script setup vapor>
import { computed, ref } from 'vue';
import MessageText from './MessageText.vue';
const props = defineProps({ phase: { type: Object, required: true }, archiveBase: String });
const emit = defineEmits(['open']);
const open = ref(false);
const cliResult = computed(() => {
  const receipt = props.phase.rows.find(m => m.seq === props.phase.resultSeq);
  return receipt ? JSON.parse(receipt.text).result : '';
});
const statuses = { returned: '已交回', blocked: '受阻交回', interrupted: '插话中断', error: '调用失败', queued: '等待工作区', unconfirmed: '尚无返回记录' };
</script>
<template>
  <details class="agent-phase" @toggle="open = $event.target.open">
    <summary><strong>{{ phase.name === 'code_agent' ? '编码阶段' : '浏览器阶段' }}</strong> · {{ phase.task || '查看执行详情' }} <small>{{ statuses[phase.status] || phase.status }}</small></summary>
    <section v-if="open">
      <p class="hint">
        {{ phase.name }} · 委托 #{{ phase.seq }}<template v-if="phase.executor"> · {{ phase.executor }}</template>
        <button v-if="phase.phaseSession" type="button" class="sm ghost phase-open" @click="emit('open', phase.phaseSession)">查看完整子阶段</button>
      </p>
      <p v-if="!phase.callId" class="hint">当前页不含委托起点，可向上加载更早记录。</p>
      <div v-if="phase.evidence" class="phase-evidence">
        <p v-if="phase.evidence.filesChanged?.length" class="hint"><strong>改动文件：</strong><code>{{ phase.evidence.filesChanged.join('、') }}</code></p>
        <p v-if="phase.evidence.visitedUrls?.length" class="hint"><strong>访问页面：</strong>{{ phase.evidence.visitedUrls.map(u => u.url).join('、') }}</p>
        <p v-if="phase.evidence.errors?.length" class="hint phase-err"><strong>阻塞/错误：</strong>{{ phase.evidence.errors.join('；') }}</p>
        <div v-if="phase.evidence.screenshots?.length" class="phase-shots">
          <img v-for="(s, n) in phase.evidence.screenshots" :key="n" :src="s.url" alt="阶段截图证据" />
        </div>
      </div>
      <template v-for="m in phase.rows" :key="m.seq">
        <template v-if="!m.phaseReturned && m.seq !== phase.seq">
          <MessageText v-if="m.role === 'assistant' && m.text" :text="m.displayText || m.text" :archive-base="archiveBase" />
          <details v-for="c in m.calls || []" :key="c.id"><summary>#{{ m.seq }} · 调用 {{ c.name }}</summary><pre>{{ JSON.stringify(c.arguments, null, 2) }}</pre></details>
          <template v-if="m.role === 'tool'">
            <MessageText v-if="m.seq === phase.resultSeq" :text="cliResult" :archive-base="archiveBase" />
            <details><summary>#{{ m.seq }} · {{ m.name }} · {{ m.error ? '错误回执' : (m.name === phase.name && !phase.executor ? '委托回执' : '回执') }}</summary><pre>{{ m.text }}</pre>
              <img v-for="(im, n) in m.images || []" :key="n" :src="im.url || (im.blobId ? `/api/blobs/${im.blobId}` : `data:${im.mime};base64,${im.data}`)" alt="工具回执附图" />
            </details>
            <ol v-if="m.cliActivity?.steps.length"><li v-for="(s, n) in m.cliActivity.steps" :key="n">{{ s.action }} · <code>{{ s.detail }}</code><template v-if="s.exitCode != null">（退出码 {{ s.exitCode }}）</template></li></ol>
            <p v-if="m.cliActivity?.omitted" class="hint">另有 {{ m.cliActivity.omitted }} 项未记录。</p>
          </template>
        </template>
      </template>
      <p v-if="phase.executor === 'antigravity'" class="hint">此 CLI 只返回最终文本，不提供逐步操作。</p>
    </section>
  </details>
</template>
<style scoped>
.agent-phase { margin: .45rem 0; padding: .55rem .8rem; border-left: 3px solid var(--muted); overflow-wrap: anywhere; }
summary { cursor: pointer; } small { color: var(--muted); } section { margin-top: .5rem; } pre { white-space: pre-wrap; } img { max-width: 100%; max-height: 360px; }
.phase-open { margin-left: .5rem; } .phase-evidence { margin: .4rem 0; } .phase-err { color: var(--danger, #c93b6b); } .phase-shots { display: flex; flex-wrap: wrap; gap: 6px; margin-top: .3rem; }
</style>
