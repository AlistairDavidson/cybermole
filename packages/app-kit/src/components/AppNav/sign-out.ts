// Sign-out, shared by the bar's account menu and SideNavFooter.

type WaToast = HTMLElement & {
  create(message: string, options?: Record<string, unknown>): Promise<unknown>;
};

/** A 401 means already signed out: /login either way. */
export async function signOut(base: string): Promise<void> {
  try {
    await fetch(`${base}/logout`, { method: 'POST' });
  } catch {
    void (document.querySelector('wa-toast') as WaToast | null)?.create(
      'network error — try again',
      {
        variant: 'danger',
        icon: 'triangle-exclamation',
        duration: 6000,
      },
    );
    return;
  }
  location.href = `${base}/login`;
}
