import { Capacitor } from '@capacitor/core';
import { useEffect, useState } from 'react';

/** Honest mobile setup guidance; installation availability is controlled by the browser. */
export function MobileReadiness() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  return <div className="mobile-readiness">
    {!online && <p role="status" className="mobile-readiness__offline">You appear to be offline. Reconnect before starting camera tracking or an online fight.</p>}
    <details>
      <summary>Playing on your phone</summary>
      <p>Prop up your phone so its front camera can see your whole body. Leave room to take a small step in every direction, and keep the phone still while playing.</p>
      {!Capacitor.isNativePlatform() && <p>On a supported browser, use its menu to add SPAR to your home screen. On iPhone, use Safari’s Share menu, then Add to Home Screen.</p>}
      <p>Camera tracking needs your permission and a connection to load its model. Online fights need a connection throughout.</p>
      {!Capacitor.isNativePlatform() && <p>Browser camera access requires HTTPS or localhost. Adding SPAR to your home screen saves an offline reconnect screen, not the game for offline play.</p>}
    </details>
  </div>;
}
