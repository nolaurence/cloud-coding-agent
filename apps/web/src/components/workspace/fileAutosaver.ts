export type FileSaveState =
  | { status: "saved" }
  | { status: "dirty" }
  | { status: "saving" }
  | { status: "error"; message: string };

export interface FileAutosaverOptions<Result> {
  initialContent?: string;
  persist: (content: string) => Promise<Result>;
  onState: (state: FileSaveState) => void;
  onSaved?: (result: Result, content: string) => void;
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 500;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "文件保存失败";
}

export class FileAutosaver<Result = unknown> {
  private readonly debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContent: string;
  private confirmedContent: string;
  private latestRevision = 0;
  private confirmedRevision = 0;
  private failedRevision: number | null = null;
  private pendingSave = false;
  private forceDrain = false;
  private pumpPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;
  private cancelled = false;
  private stateValue: FileSaveState = { status: "saved" };

  constructor(private readonly options: FileAutosaverOptions<Result>) {
    this.latestContent = options.initialContent ?? "";
    this.confirmedContent = this.latestContent;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    if (!Number.isFinite(this.debounceMs) || this.debounceMs < 0) {
      throw new RangeError("debounceMs must be a finite non-negative number");
    }
  }

  get state(): FileSaveState {
    return this.stateValue;
  }

  get content(): string {
    return this.latestContent;
  }

  get dirty(): boolean {
    return this.latestRevision !== this.confirmedRevision;
  }

  activate(): void {
    if (this.cancelled) return;
    this.disposed = false;
    this.disposePromise = null;
  }

  change(content: string): void {
    if (this.disposed || this.cancelled) return;

    this.latestContent = content;
    this.latestRevision += 1;
    this.failedRevision = null;

    if (this.pumpPromise === null && content === this.confirmedContent) {
      this.confirmedRevision = this.latestRevision;
      this.clearTimer();
      this.pendingSave = false;
      this.forceDrain = false;
      this.setState({ status: "saved" });
      return;
    }

    this.setState({ status: "dirty" });
    this.schedule();
  }

  flush(): Promise<void> {
    if (this.cancelled) return Promise.resolve();
    if (this.disposed) return this.disposePromise ?? Promise.resolve();
    this.clearTimer();
    this.failedRevision = null;
    return this.requestSave(true);
  }

  retry(): Promise<void> {
    return this.flush();
  }

  dispose(): Promise<void> {
    if (this.cancelled) return Promise.resolve();
    if (this.disposePromise) return this.disposePromise;

    this.disposed = true;
    this.clearTimer();
    this.failedRevision = null;
    this.disposePromise = this.requestSave(true);
    return this.disposePromise;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.disposed = true;
    this.pendingSave = false;
    this.forceDrain = false;
    this.clearTimer();
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.requestSave(false);
    }, this.debounceMs);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private requestSave(force: boolean): Promise<void> {
    if (this.cancelled) return Promise.resolve();

    this.pendingSave = true;
    if (force) this.forceDrain = true;

    if (this.pumpPromise === null) {
      this.pumpPromise = Promise.resolve()
        .then(() => this.pump())
        .finally(() => {
          this.pumpPromise = null;
        });
    }
    return this.pumpPromise;
  }

  private async pump(): Promise<void> {
    while (!this.cancelled && (this.pendingSave || this.forceDrain)) {
      const forced = this.forceDrain;
      this.pendingSave = false;
      this.forceDrain = false;

      if (!this.dirty) {
        this.failedRevision = null;
        this.setState({ status: "saved" });
        continue;
      }
      if (!forced && this.failedRevision === this.latestRevision) break;

      const content = this.latestContent;
      const revision = this.latestRevision;
      this.setState({ status: "saving" });

      let result: Result;
      try {
        result = await this.options.persist(content);
      } catch (error) {
        if (this.cancelled) break;
        this.failedRevision = revision;
        if (revision === this.latestRevision) {
          this.setState({ status: "error", message: errorMessage(error) });
          if (!this.forceDrain) break;
        } else {
          this.setState({ status: "dirty" });
          if (forced) this.forceDrain = true;
        }
        continue;
      }

      if (this.cancelled) break;
      this.confirmedContent = content;
      this.confirmedRevision = revision;
      this.failedRevision = null;
      this.options.onSaved?.(result, content);

      if (this.latestContent === content) {
        this.confirmedRevision = this.latestRevision;
        this.clearTimer();
        this.pendingSave = false;
        this.forceDrain = false;
        this.setState({ status: "saved" });
      } else {
        this.setState({ status: "dirty" });
        if (forced) this.forceDrain = true;
      }
    }
  }

  private setState(state: FileSaveState): void {
    if (this.cancelled) return;
    if (
      state.status === this.stateValue.status
      && (state.status !== "error"
        || (this.stateValue.status === "error" && state.message === this.stateValue.message))
    ) {
      return;
    }
    this.stateValue = state;
    this.options.onState(state);
  }
}
