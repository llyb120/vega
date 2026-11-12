import { onBeforeUnmount, onMounted, ref, watch } from "vue";
// Unread badges for 牛马 chats and groups. The server keeps one read marker per user and conversation
// (POST …/read); a conversation on screen is marked read, other new messages refresh the counts.
// `app()` returns the App state lazily, so this can be set up before that state is declared.
export function useUnread(app) {
  const visible = ref(typeof document === "undefined" || !document.hidden);
  const viewing = (id) => {
    const a = app();
    return visible.value && a.view.value === "employee" && !a.creatingEmployee.value && !a.employeeSession.value && a.employeeTab.value === "chat" && a.selectedEmployee.value === id;
  };
  const entry = (id) => app().employees.value.find((e) => e.id === id);
  let refreshing = null, again = false;
  async function refresh() {
    if (refreshing) { again = true; return refreshing; }
    refreshing = (async () => {
      try {
        do {
          again = false;
          for (const row of await app().api("/employees")) {
            const e = entry(row.id);
            if (e) Object.assign(e, { unread: viewing(row.id) ? 0 : row.unread, chatSession: row.chatSession, lastText: row.lastText ?? e.lastText });
          }
        } while (again);
      } finally { refreshing = null; }
    })();
    return refreshing;
  }
  let marking = false;
  async function markEmployee() {
    const id = app().selectedEmployee.value;
    if (marking || !viewing(id)) return;
    marking = true;
    try { await app().api(`/employees/${id}/chat/read`, "POST", {}); const e = entry(id); if (e) e.unread = 0; }
    finally { marking = false; }
  }
  /** A new message: mark the 牛马 chat on screen read, else refresh the counts. */
  function onEvent(event) {
    if (event.type !== "message_end" || !event.session) return;
    const a = app();
    if (event.session === a.employee.value.chatSession && viewing(a.selectedEmployee.value)) a.background(markEmployee());
    else if (a.employees.value.some((e) => e.chatSession === event.session)) a.background(refresh());
  }
  function groupRead(id) {
    const g = app().groups.value.find((g) => g.id === id);
    if (g) g.unread = 0;
  }
  // Opening a 牛马 chat (or coming back to the tab) marks it read.
  watch(() => { const a = app(); return [a.selectedEmployee.value, a.view.value, a.employeeTab.value, a.employeeSession.value, visible.value, entry(a.selectedEmployee.value)?.unread]; }, () => {
    const a = app();
    if (viewing(a.selectedEmployee.value) && entry(a.selectedEmployee.value)?.unread) a.background(markEmployee());
  });
  const track = () => { visible.value = !document.hidden; };
  onMounted(() => document.addEventListener("visibilitychange", track));
  onBeforeUnmount(() => document.removeEventListener("visibilitychange", track));
  return { onEvent, groupRead };
}
