<script setup vapor>
import Icon from "./Icon.vue";
import EmployeeAvatarPicker from "./EmployeeAvatarPicker.vue";
defineProps({ employee: Object, api: Function, saving: Boolean, deleting: Boolean, resetting: String });
const emit = defineEmits(["save", "delete", "reset", "avatar", "cancel"]);
</script>
<template>
  <div class="page-scroll settings-page">
    <div class="settings-grid">
      <form class="card profile" @submit.prevent="emit('save')">
        <div class="card-head"><h3>牛马资料</h3><p class="hint">保存后，新任务会使用更新的工作原则。</p></div>
        <div class="form-grid">
          <label>姓名<input v-model="employee.name" maxlength="80" required /></label>
          <label>工作原则<textarea v-model="employee.instruction" rows="6" maxlength="8000" placeholder="例如：负责项目开发，先检查现有实现，完成后验证并汇报结果。"></textarea></label>
        </div>
        <div class="actions end form-actions"><button type="button" class="ghost" @click="emit('cancel')">返回对话</button><button class="primary" :disabled="saving">{{ saving ? '保存中…' : '保存修改' }}</button></div>
      </form>
      <div class="side">
        <EmployeeAvatarPicker :key="employee.id" :api="api" :employee-id="employee.id" :name="employee.name" :avatar="employee.avatar" @change="emit('avatar', $event)" />
        <section class="card danger-zone">
          <div class="card-head"><h3>危险操作</h3><p class="hint">清空聊天只删除对话记录；重置会停止并删除全部会话和任务，保留记忆、职责、设置、密码本和浏览器登录；删除会连同职责、记忆、密码本、任务和浏览器登录一并清除。项目文件不会删除。</p></div>
          <div class="danger-actions">
            <button type="button" class="danger" :disabled="!!resetting || deleting" @click="emit('reset', 'chat')"><Icon name="trash" :size="15" />{{ resetting === 'chat' ? '正在清空…' : '清空聊天记录' }}</button>
            <button type="button" class="danger" :disabled="!!resetting || deleting" @click="emit('reset', 'all')"><Icon name="trash" :size="15" />{{ resetting === 'all' ? '正在重置…' : '重置牛马' }}</button>
            <button type="button" class="danger" :disabled="deleting || !!resetting" @click="emit('delete')"><Icon name="trash" :size="15" />{{ deleting ? '正在删除…' : '永久删除牛马' }}</button>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
<style scoped>
.settings-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(300px, 1fr); gap: 16px; align-items: start; max-width: 1100px; }
.side { display: grid; gap: 16px; }
.side > .card + .card { margin-top: 0; }
.card-head { display: grid; gap: 2px; margin-bottom: 14px; }
.card-head h3 { font-size: 14px; }
.form-actions { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
.danger-zone { border-color: var(--danger-border); }
.danger-zone h3 { color: var(--danger); }
.danger-actions { display: grid; gap: 8px; }
@media (max-width: 1023px) { .settings-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
