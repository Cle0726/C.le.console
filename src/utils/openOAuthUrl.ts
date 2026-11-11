import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

/** Use an isolated external browser when the workbench subscription is active. */
export async function openOAuthUrl(url: string): Promise<void> {
  const opened = await invoke<boolean>('subscription_proxy_open_auth_url', { url });
  if (!opened) await openUrl(url);
}
