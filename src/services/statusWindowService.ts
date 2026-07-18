import { invoke } from '@tauri-apps/api/core';

export async function showStatusWindow(): Promise<void> {
  await invoke('show_status_window');
}

export async function hideStatusWindow(): Promise<void> {
  await invoke('hide_status_window');
}
