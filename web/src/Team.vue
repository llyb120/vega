<script setup vapor>
import { ref, onMounted } from "vue";
const props = defineProps({ api: Function });
const emit = defineEmits(["error", "notice"]);
const peers = ref([]),
  connected = ref(false),
  selected = ref(""),
  snapshot = ref(null),
  text = ref(""),
  transcript = ref(null),
  busy = ref(false),
  publicFlag = ref(false),
  relay = ref({ server: "", token: "", groups: "" });
async function run(fn) {
  busy.value = true;
  try {
    await fn();
  } catch (e) {
    emit("error", e.message);
  } finally {
    busy.value = false;
  }
}
async function refresh() {
  await run(async () => {
    const status = await props.api("/team");
    peers.value = status.peers || [];
    connected.value = status.connected;
    publicFlag.value = (await props.api("/employee")).public;
  });
}
async function load(peer) {
  await run(async () => {
    selected.value = peer.token;
    const response = await props.api("/team/call", "POST", {
      peer: peer.token,
      command: "employee_get",
      args: {},
    });
    snapshot.value = response.employee || response;
  });
}
async function assign() {
  await run(async () => {
    await props.api("/team/call", "POST", {
      peer: selected.value,
      command: "employee_say",
      args: { text: text.value },
    });
    text.value = "";
    emit("notice", "已交给对方员工；缺信息和审批将找交代人，不会换任务重做");
  });
}
async function action(task, kind) {
  await run(async () => {
    const args = { action: kind, id: task.id };
    if (kind === "answer") {
      const value = prompt(task.waiting);
      if (!value) return;
      args.text = value;
    }
    if (kind === "approve") args.approved = confirm(task.approval || task.text);
    if (kind === "redispatch") {
      args.confirmed = confirm("确定重新派发为新任务？已有外部操作不会回滚。");
      if (!args.confirmed) return;
    }
    await props.api("/team/call", "POST", {
      peer: selected.value,
      command: "employee_do",
      args,
    });
    await load({ token: selected.value });
  });
}
async function timeline(task) {
  await run(async () => {
    transcript.value = await props.api("/team/call", "POST", {
      peer: selected.value,
      command: "transcript",
      args: { threadId: task.workSession || task.workThread || task.threadId },
    });
  });
}
async function saveRelay() {
  await run(async () => {
    const b = await props.api("/bootstrap");
    b.config.relay = relay.value;
    await props.api("/config", "PUT", b.config);
    emit("notice", "团队中转设置已保存，正在连接");
    await refresh();
  });
}
onMounted(() => void refresh());
</script>
<template>
  <section class="card">
    <div class="section-heading">
      <h3>StarLink · 团队数字员工</h3>
      <button @click="refresh" :disabled="busy">刷新团队</button>
    </div>
    <p>
      <span :class="['pill', connected ? 'green' : '']">{{
        connected ? "中转站已连接" : "未连接中转站"
      }}</span>
    </p>
    <label
      ><input
        v-model="publicFlag"
        type="checkbox"
        @change="
          run(() =>
            api('/employee/control', 'POST', {
              action: 'settings',
              public: publicFlag,
            }),
          )
        "
      />
      公开本机员工到团队</label
    >
    <details>
      <summary>团队中转设置（HTTP + SSE v2）</summary>
      <div class="form-grid">
        <input
          v-model="relay.server"
          placeholder="团队中转站 HTTPS 地址"
        /><input
          v-model="relay.token"
          type="password"
          autocomplete="off"
          placeholder="成员 token"
        /><input v-model="relay.groups" placeholder="群组，逗号分隔" /><button
          @click="saveRelay"
        >
          保存团队设置
        </button>
      </div>
    </details>
    <div class="inline-form">
      <button v-for="peer in peers" :key="peer.token" @click="load(peer)">
        {{ peer.name || peer.token?.split("/")[0] }} ↗
      </button>
    </div>
    <p v-if="!peers.length" class="hint">
      仅同群组在线成员可见，远端员工必须公开后才能下达指令。
    </p>
    <template v-if="selected && snapshot"
      ><h3>成员：{{ selected.split("/")[0] }}</h3>
      <form class="inline-form" @submit.prevent="assign">
        <input
          v-model="text"
          required
          placeholder="交给这位成员的员工"
        /><button class="primary" :disabled="busy">派发独立任务</button>
      </form>
      <article
        v-for="task in snapshot.tasks || snapshot.inbox || []"
        :key="task.id"
        class="task-card"
      >
        <span class="pill">{{ task.status || "待处理" }}</span>
        <h3>{{ task.text }}</h3>
        <p v-if="task.waiting || task.approval">
          {{ task.waiting || task.approval }}
        </p>
        <div class="card-actions">
          <button v-if="task.waiting" @click="action(task, 'answer')">
            补充信息</button
          ><button
            v-if="task.approval || task.confirm"
            @click="action(task, 'approve')"
          >
            审批</button
          ><button @click="timeline(task)">任务时间线</button
          ><button
            v-if="['failed', 'stopped', 'cancelled'].includes(task.status)"
            @click="action(task, 'resume')"
          >
            原任务续做
          </button>
        </div>
      </article>
      <details v-if="transcript" open>
        <summary>{{ transcript.title }}</summary>
        <pre>{{ JSON.stringify(transcript.entries, null, 2) }}</pre>
      </details></template
    >
  </section>
</template>
