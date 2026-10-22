/* ============================================================
   Thorfinn shared front-end helpers.
   Loaded before each page script; exposed as window.T.

   Keeping these in one place avoids the copies that used to
   drift between the public and admin scripts.
   ============================================================ */

(function () {
  "use strict";

  // Build a DOM node from a tag, attributes and children - never innerHTML,
  // so names typed by admins or the public can't inject markup.
  //   - key "class"  -> className
  //   - key "value"  -> the .value property (correct for inputs)
  //   - key "hidden" -> the boolean hidden property
  //   - keys starting "on" + a function -> addEventListener
  //   - anything else -> setAttribute
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (key === "class") node.className = value;
      else if (key === "value") node.value = value;
      else if (key === "hidden") node.hidden = !!value;
      else if (key.indexOf("on") === 0 && typeof value === "function")
        node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value);
    });
    (children || []).forEach(function (child) {
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  function naira(n) { return "\u20A6" + n; }

  // Great-circle distance in metres between two {lat, lng} points.
  function haversineM(a, b) {
    var R = 6371000;
    var toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad;
    var dLng = (b.lng - a.lng) * toRad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // "850 m" or "1.2 km" for a distance in metres.
  function distText(metres) {
    return metres >= 1000
      ? (metres / 1000).toFixed(metres >= 10000 ? 0 : 1) + " km"
      : Math.round(metres) + " m";
  }

  // Anonymous device id kept only in this browser. Used to count DISTINCT
  // devices, with no personal data stored.
  function deviceId() {
    var key = "thorfinn_device_id";
    var id = null;
    try { id = localStorage.getItem(key); } catch (e) { /* private mode */ }
    if (!id) {
      id = (window.crypto && crypto.randomUUID && typeof crypto.randomUUID === "function")
        ? crypto.randomUUID().replace(/-/g, "")
        : ("d" + Date.now().toString(36) + Math.random().toString(36).slice(2));
      try { localStorage.setItem(key, id); } catch (e) { /* private mode */ }
    }
    return id;
  }

  // Leaflet fires the map's own "click" when a marker, line or popup is
  // clicked too. Detect those so map-click handlers can ignore them.
  function isLayerClick(e) {
    var t = e.originalEvent && e.originalEvent.target;
    if (!t || !t.closest) return false;
    return !!t.closest(".leaflet-marker-icon, .leaflet-interactive, .leaflet-popup");
  }

  // Compass bearing from a to b, for rotating a direction arrow.
  function bearingDeg(a, b) {
    var toRad = Math.PI / 180;
    var toDeg = 180 / Math.PI;
    var lat1 = a.lat * toRad;
    var lat2 = b.lat * toRad;
    var dLon = (b.lng - a.lng) * toRad;
    var y = Math.sin(dLon) * Math.cos(lat2);
    var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (Math.atan2(y, x) * toDeg + 360) % 360;
  }

  function midpoint(a, b) {
    return new L.LatLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
  }

  // Rotated arrowhead divIcon. `angleDeg` is a compass bearing (subtract 90
  // at the call site to point north-up); `extraClass` styles the colour.
  function arrowIcon(angleDeg, extraClass) {
    return L.divIcon({
      className: "arrow-wrap",
      html: '<div class="link-arrow ' + (extraClass || "") +
        '" style="transform:rotate(' + angleDeg + 'deg)"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
  }

  // Transient toast bound to an element (auto-hides after a few seconds).
  function toast(toastEl, message, isError) {
    toastEl.textContent = message;
    toastEl.classList.toggle("toast-error", !!isError);
    toastEl.hidden = false;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.hidden = true; }, 4500);
  }

  // JSON fetch bound to a CSRF token, with server error messages surfaced.
  function apiWith(csrfToken) {
    return function (path, method, body) {
      var opts = { method: method || "GET", headers: { "X-CSRF-Token": csrfToken } };
      if (body) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
      }
      return fetch(path, opts).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) {
            var msg = data && (data.detail || data.error);
            if (typeof msg !== "string") msg = "Request failed (" + res.status + ").";
            throw new Error(msg);
          }
          return data;
        });
      });
    };
  }

  window.T = {
    el: el,
    naira: naira,
    haversineM: haversineM,
    distText: distText,
    deviceId: deviceId,
    isLayerClick: isLayerClick,
    bearingDeg: bearingDeg,
    midpoint: midpoint,
    arrowIcon: arrowIcon,
    toast: toast,
    apiWith: apiWith,
  };
})();
