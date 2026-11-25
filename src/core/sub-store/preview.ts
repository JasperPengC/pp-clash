import { invoke } from '@tauri-apps/api/core';

export const PREVIEW_CANCELLED = 'SUB_STORE_PREVIEW_CANCELLED';
/** 两阶段原生任务：标识尚未返回时的取消也会在准备完成后送达。 */
export class SubStorePreview {
  cancelled = false;
  private id?: Promise<string>;
  private cancellation?: Promise<boolean>;

  async invoke(request: unknown): Promise<string> {
    this.id = invoke<string>('sub_store_preview_prepare');
    const id = await this.id;
    if (this.cancelled) {
      const confirmed = await this.cancel().then(() => true, () => false);
      if (confirmed) throw PREVIEW_CANCELLED;
      // 取消通道失败时保留执行句柄，让界面维持锁定并重试取消。
    }
    return invoke<string>('sub_store_preview', { id, request });
  }

  cancel(): Promise<boolean> {
    this.cancelled = true;
    if (!this.id) return Promise.resolve(false);
    if (!this.cancellation) {
      this.cancellation = this.id.then(id => invoke<boolean>('sub_store_preview_cancel', { id }));
      void this.cancellation.catch(() => { this.cancellation = undefined; });
    }
    return this.cancellation;
  }
}
