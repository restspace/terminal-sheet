export type RuntimePlatform = 'windows' | 'unix';

export function getDefaultShell(
  platform: RuntimePlatform = getRuntimePlatform(),
): string {
  return platform === 'windows' ? 'powershell.exe' : 'bash';
}

export function getRuntimePlatform(): RuntimePlatform {
  if (typeof navigator !== 'undefined' && /\bWin/i.test(navigator.userAgent)) {
    return 'windows';
  }

  if (typeof process !== 'undefined' && process.platform === 'win32') {
    return 'windows';
  }

  return 'unix';
}
