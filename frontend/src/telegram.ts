type TelegramWebApp = {
  initData?: string;
  version?: string;
  ready: () => void;
  expand: () => void;
  isExpanded?: boolean;
  colorScheme?: 'light' | 'dark';
  themeParams?: Record<string, string>;
  contentSafeAreaInset?: { top: number; bottom: number; left: number; right: number };
  safeAreaInset?: { top: number; bottom: number; left: number; right: number };
  BackButton?: {
    show: () => void;
    hide: () => void;
    onClick: (callback: () => void) => void;
    offClick: (callback: () => void) => void;
  };

};

export class TelegramAuthenticationError extends Error {
  readonly kind = 'authentication';
  constructor(message = 'Open FD Forex AI inside Telegram to authenticate this request.') {
    super(message);
  }
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

export async function waitForTelegramWebApp(timeoutMs = 3000): Promise<TelegramWebApp | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const webApp = window.Telegram?.WebApp;
    if (webApp) return webApp;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  return window.Telegram?.WebApp ?? null;
}

export async function initializeTelegramWebApp(): Promise<string> {
  const webApp = await waitForTelegramWebApp();
  if (!webApp) throw new TelegramAuthenticationError('Telegram WebApp SDK is unavailable.');
  webApp.ready();
  webApp.expand();
  if (!webApp.initData) throw new TelegramAuthenticationError();
  return webApp.initData;
}

export async function authenticateTelegram(): Promise<string | null> {
  const initData = await initializeTelegramWebApp();

  const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/auth/me`, {
    headers: { Authorization: `tma ${initData}` },
  });

  if (!response.ok) {
    if (response.status === 401) throw new TelegramAuthenticationError('Telegram authentication was rejected. Reopen the Mini App from Telegram.');
    throw new Error(`Telegram authentication service failed (${response.status})`);
  }

  const body = (await response.json()) as { user?: { first_name?: string; username?: string } };
  return body.user?.first_name ?? body.user?.username ?? null;
}

export async function getTelegramInitData(): Promise<string> {
  return initializeTelegramWebApp();
}

export function setupTelegramWebApp(onBack: () => void, showBackButton: boolean): () => void {
  const webApp = window.Telegram?.WebApp;
  if (!webApp) {
    return () => undefined;
  }

  webApp.ready();
  webApp.expand();

  const root = document.documentElement;
  root.dataset.telegramTheme = webApp.colorScheme ?? 'dark';
  if (webApp.themeParams?.bg_color) {
    root.style.setProperty('--telegram-bg-color', webApp.themeParams.bg_color);
  }
  const safeArea = webApp.safeAreaInset;
  const contentSafeArea = webApp.contentSafeAreaInset;
  if (safeArea) {
    root.style.setProperty('--telegram-safe-top', `${safeArea.top}px`);
    root.style.setProperty('--telegram-safe-bottom', `${safeArea.bottom}px`);
  }
  if (contentSafeArea) {
    root.style.setProperty('--telegram-content-safe-top', `${contentSafeArea.top}px`);
    root.style.setProperty('--telegram-content-safe-bottom', `${contentSafeArea.bottom}px`);
  }

  const supportsBackButton = !webApp.version || Number.parseFloat(webApp.version) >= 6.1;
  const backButton = supportsBackButton ? webApp.BackButton : undefined;
  if (!backButton) {
    return () => undefined;
  }
  if (showBackButton) {
    backButton.show();
    backButton.onClick(onBack);
  } else {
    backButton.hide();
  }

  return () => {
    backButton.offClick(onBack);
    backButton.hide();
  };
}
