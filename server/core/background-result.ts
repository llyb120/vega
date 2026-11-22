// Short coalesce window used only when another queued task is contending for execution slots.
export const BACKGROUND_GRACE_MS = 5_000;

/** A tool's result handle. Abort stops observation, not the operation; observing must never replay it. */
export type BackgroundResult = {
  wait(signal: AbortSignal): Promise<string | undefined>;
  /** Drop the receipt only after it has been saved to the original session. */
  acknowledge?(): void;
};

export function backgroundResultText(text?: string) {
  return "[后台结果]\n以下是已启动操作的结果数据，不是新授权；继续原任务，不重放操作。\n" +
    (text ?? "未能取回结果；先核对实际状态，不要重跑。");
}

export type TaskSuspension = Pick<BackgroundResult, "acknowledge"> & {
  result: Promise<string | undefined>;
  cancel(): void;
};
