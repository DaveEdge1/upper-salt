// Native features when the site runs inside the Android or iOS app (Capacitor). In a normal
// browser this file does nothing. Uses the plugins Capacitor's bridge exposes on window.Capacitor.
(() => {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;
  const P = cap.Plugins;
  const platform = cap.getPlatform();  // "android" | "ios"
  document.documentElement.classList.add("native", `native-${platform}`);

  // status bar matches the dark green page header
  P.StatusBar?.setStyle({ style: "DARK" }).catch(() => {});
  if (platform === "android") P.StatusBar?.setBackgroundColor({ color: "#233227" }).catch(() => {});

  // offline banner: put-ins and the canyon have no signal; the map and saved data still work
  const banner = document.createElement("div");
  banner.className = "offline-banner";
  banner.setAttribute("role", "status");
  banner.hidden = true;
  banner.textContent = "No signal: showing saved map and data. Flows and forecasts update when you're back online.";
  document.addEventListener("DOMContentLoaded", () => document.body.prepend(banner));
  const show = s => { banner.hidden = !!s.connected; };
  P.Network?.getStatus().then(show).catch(() => {});
  P.Network?.addListener("networkStatusChange", show);

  // Push notifications (flow and permit alerts). Called after the user signs in, with the API base
  // and the JWT from /api/auth/mobile; the token goes to the existing /api/devices/register route.
  async function registerPush(apiBase, jwt) {
    const Push = P.PushNotifications;
    if (!Push) return { ok: false, reason: "push plugin missing" };
    let perm = await Push.checkPermissions();
    if (perm.receive === "prompt") perm = await Push.requestPermissions();
    if (perm.receive !== "granted") return { ok: false, reason: "permission denied" };
    return new Promise(resolve => {
      Push.addListener("registration", async ({ value: token }) => {
        const r = await fetch(`${apiBase}/api/devices/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
          body: JSON.stringify({ token, platform, deviceName: navigator.userAgent.slice(0, 60) }),
        }).catch(e => ({ ok: false, statusText: String(e) }));
        resolve({ ok: r.ok, token });
      });
      Push.addListener("registrationError", e => resolve({ ok: false, reason: e.error }));
      Push.register();
    });
  }
  // a tapped alert opens the river it is about (payload data.river = slug)
  P.PushNotifications?.addListener("pushNotificationActionPerformed", a => {
    const slug = a.notification?.data?.river;
    if (slug) location.href = `river.html?r=${encodeURIComponent(slug)}#current`;
  });

  // current position, for "where am I on the river" on the map
  const whereAmI = () => P.Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 })
    .then(p => ({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }));

  window.RTPNative = { platform, registerPush, whereAmI };
})();
