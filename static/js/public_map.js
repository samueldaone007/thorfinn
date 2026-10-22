/* ============================================================
   Public map of stops (/map).
   - every stop as a blue dot
   - the whole route network drawn as faint lines
   - tap a stop -> a card appears with its details and an
     auto-generated "goes to" list derived from the links,
     plus "Show routes here" which highlights the routes
     leaving (red) and arriving (blue) at that stop.

   All text is inserted via textContent / DOM build helpers,
   never innerHTML, so stop names can't inject markup.
   ============================================================ */

(function () {
  "use strict";

  var el = T.el;
  var naira = T.naira;
  var deviceId = T.deviceId;
  var isLayerClick = T.isLayerClick;
  var bearingDeg = T.bearingDeg;
  var midpoint = T.midpoint;
  var arrowIcon = T.arrowIcon;

  var mapEl = document.getElementById("map");
  var csrfToken = mapEl.dataset.csrf;
  var map = L.map("map").setView(
    [parseFloat(mapEl.dataset.centerLat), parseFloat(mapEl.dataset.centerLng)], 12
  );
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  var stops = [];   // {id, name, area, lat, lng}
  var links = [];   // {id, from_stop_id, to_stop_id, from_name, to_name, vehicle, fare_min, fare_max}
  var byId = {};

  var dotLayer = L.layerGroup().addTo(map);
  var netLayer = L.layerGroup().addTo(map);
  var hlLayer = L.layerGroup().addTo(map);
  var myPin = L.layerGroup().addTo(map);

  var cardEl = document.getElementById("stop-card");
  var legendEl = document.getElementById("legend");
  var selectedId = null;

  /* ---------- tiny helpers ---------- */

  function stopById(id) { return byId[id] || null; }

  function fitAllStops(padding, maxZoom) {
    if (!stops.length) return;
    map.fitBounds(L.latLngBounds(stops.map(function (s) { return [s.lat, s.lng]; })),
      { padding: padding || [40, 40], maxZoom: maxZoom || 14 });
  }

  /* ---------- base layers ---------- */

  function renderStops() {
    dotLayer.clearLayers();
    stops.forEach(function (s) {
      var dot = L.circleMarker([s.lat, s.lng], {
        radius: 7,
        color: "#0b5394",
        weight: 1,
        fillColor: "#0b5394",
        fillOpacity: 0.9,
      });
      dot.on("click", function () { openStopCard(s); });
      var tip = document.createElement("strong");
      tip.textContent = s.name;
      dot.bindTooltip(tip, { direction: "top", offset: [0, -4], opacity: 0.9 });
      dotLayer.addLayer(dot);
    });
  }

  // The whole network, drawn faintly so it reads but keeps stops prominent.
  // Outdated (not re-confirmed within freshness_days) segments are dashed.
  function renderNetwork() {
    netLayer.clearLayers();
    links.forEach(function (link) {
      var a = stopById(link.from_stop_id);
      var b = stopById(link.to_stop_id);
      if (!a || !b) return;
      var style = { color: "#8a8a8a", weight: 2, opacity: 0.5, interactive: false };
      if (link.outdated) {
        style.color = "#b3a97f";
        style.dashArray = "4 5";
      }
      L.polyline([[a.lat, a.lng], [b.lat, b.lng]], style).addTo(netLayer);
    });
  }

  /* ---------- highlight "routes here" ---------- */

  function highlightRoutes(stop) {
    hlLayer.clearLayers();
    var touching = links.filter(function (l) {
      return l.from_stop_id === stop.id || l.to_stop_id === stop.id;
    });
    if (!touching.length) return;

    var pts = [[stop.lat, stop.lng]];
    touching.forEach(function (l) {
      var a = stopById(l.from_stop_id);
      var b = stopById(l.to_stop_id);
      if (!a || !b) return;
      pts.push([a.lat, a.lng], [b.lat, b.lng]);
      var outbound = l.from_stop_id === stop.id;
      var cls = outbound ? "out" : "in";
      var color = outbound ? "#c1121f" : "#0b5394";
      L.polyline([[a.lat, a.lng], [b.lat, b.lng]], {
        color: color, weight: 5, opacity: 0.85, interactive: false,
      }).addTo(hlLayer);
      L.marker(midpoint(a, b), {
        icon: arrowIcon(bearingDeg(a, b) - 90, cls),
        interactive: false,
      }).addTo(hlLayer);
    });

    legendEl.hidden = false;
    map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 14 });
  }

  /* ---------- stop card ---------- */

  function goesRow(kind, destName, link) {
    var arrow = el("span", { class: "arrow arrow-" + kind });
    return el("div", { class: "goes-row" }, [
      arrow,
      el("span", { class: "badge" }, [link.vehicle]),
      el("span", {}, [kind === "out" ? "to " + destName : "from " + destName]),
      el("span", { class: "muted" },
        [naira(link.fare_min) + " \u2013 " + naira(link.fare_max)]),
    ]);
  }

  function openStopCard(stop) {
    selectedId = stop.id;
    highlightRoutesClear();
    cardEl.textContent = "";

    var children = [
      el("div", { class: "card-head" }, [
        el("div", { class: "pop-title" }, [stop.name]),
        el("button", { class: "close-x", type: "button", onclick: closeStopCard }, ["\u00d7"]),
      ]),
    ];

    var details = [];
    if (stop.area) details.push("Area: " + stop.area);
    if (details.length) children.push(el("div", { class: "muted small" }, details));

    // Freshness badge: is this stop's info still within the confirmation window?
    if (stop.outdated) {
      children.push(el("span", { class: "conf-chip warn" }, ["May be outdated"]));
    } else if (stop.last_confirmed) {
      children.push(el("span", { class: "conf-chip ok" },
        ["Confirmed " + stop.last_confirmed.slice(0, 10)]));
    }

    var out = links.filter(function (l) { return l.from_stop_id === stop.id; });
    var inn = links.filter(function (l) { return l.to_stop_id === stop.id; });

    if (out.length || inn.length) {
      var goesTitle = el("div", { class: "goes-title" }, ["Routes:"]);
      var goesList = el("div", { class: "goes" }, []);
      out.forEach(function (l) { goesList.appendChild(goesRow("out", l.to_name, l)); });
      inn.forEach(function (l) { goesList.appendChild(goesRow("in", l.from_name, l)); });
      children.push(el("div", {}, [goesTitle, goesList]));
    } else {
      children.push(el("div", { class: "muted small" },
        ["No routes verified here yet."]));
    }

    children.push(el("button", {
      class: "btn btn-primary btn-block-sm",
      type: "button",
      onclick: function () { highlightRoutes(stop); },
    }, ["Show routes here"]));

    cardEl.appendChild(el("div", { class: "pop" }, children));
    cardEl.hidden = false;
    map.panTo([stop.lat, stop.lng], { animate: true });
  }

  function closeStopCard() {
    selectedId = null;
    cardEl.hidden = true;
    cardEl.textContent = "";
    highlightRoutesClear();
    fitAllStops([40, 40], 13);
  }

  /* ---------- suggest a new stop ---------- */

  function openSuggestCard(latlng) {
    selectedId = null;
    highlightRoutesClear();
    cardEl.textContent = "";

    var name = el("input", {
      class: "tf", type: "text", maxlength: 200, autocomplete: "off",
      placeholder: "Name (optional) - e.g. Gwarinpa Gate",
    });
    var msg = el("div", { class: "form-err", hidden: true });

    var coordNote = el("div", { class: "muted small" },
      ["You tapped: " + latlng.lat.toFixed(5) + ", " + latlng.lng.toFixed(5)]);

    var saveBtn = el("button", {
      class: "btn btn-primary btn-block-sm", type: "button",
      onclick: function () { submitSuggestion(latlng, name, msg, saveBtn); },
    }, ["Suggest this stop"]);

    cardEl.appendChild(el("div", { class: "pop" }, [
      el("div", { class: "card-head" }, [
        el("div", { class: "pop-title" }, ["Suggest a new stop"]),
        el("button", { class: "close-x", type: "button", onclick: closeStopCard }, ["\u00d7"]),
      ]),
      el("div", { class: "muted small" },
        ["No account needed. Tell us where a stop is missing and we will review it."]),
      coordNote,
      el("label", { class: "lab" }, ["Name"]), name,
      msg,
      saveBtn,
    ]));
    cardEl.hidden = false;
    window.setTimeout(function () { name.focus(); }, 50);
  }

  function submitSuggestion(latlng, nameInput, msg, saveBtn) {
    var cleaned = (nameInput.value || "").trim();
    msg.hidden = true;
    saveBtn.disabled = true;
    fetch("/api/suggest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({
        name: cleaned,
        lat: latlng.lat,
        lng: latlng.lng,
        device_id: deviceId(),
      }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) {
            var detail = data && data.detail;
            throw new Error(typeof detail === "string" ? detail : "Could not save that.");
          }
          return data;
        });
      })
      .then(function (data) {
        try { localStorage.setItem("thorfinn_device_id", data.device_id); } catch (e) {}
        if (data.already_exists) {
          myPin.clearLayers();
          cardEl.textContent = "";
          cardEl.appendChild(el("div", { class: "pop" }, [
            el("div", { class: "card-head" }, [
              el("div", { class: "pop-title" }, ["Already a stop here"]),
              el("button", { class: "close-x", type: "button", onclick: closeStopCard }, ["\u00d7"]),
            ]),
            el("div", { class: "muted small" },
              ["This spot already has a verified stop: " + data.stop_name + "."]),
          ]));
          return;
        }
        myPin.clearLayers();
        L.marker([latlng.lat, latlng.lng], {
          title: "You suggested a stop here",
          interactive: false,
        }).addTo(myPin);
        var count = "number" === typeof data.distinct_user_count ? data.distinct_user_count : null;
        cardEl.textContent = "";
        var children = [
          el("div", { class: "card-head" }, [
            el("div", { class: "pop-title" }, ["Thanks! Your suggestion is in."]),
            el("button", { class: "close-x", type: "button", onclick: closeStopCard }, ["\u00d7"]),
          ]),
        ];
        if (count) children.push(el("div", { class: "suggest-ok" },
          [count + (count === 1 ? " person has " : " people have ") +
            "asked for a stop near here."]));
        children.push(el("div", { class: "muted small" },
          ["An admin will review it. If enough neighbours ask for the same spot, it will be promoted."]));
        cardEl.appendChild(el("div", { class: "pop" }, children));
      })
      .catch(function (err) {
        msg.hidden = false;
        msg.textContent = err.message;
        saveBtn.disabled = false;
      });
  }

  /* ---------- map click ---------- */

  map.on("click", function (e) {
    if (isLayerClick(e)) return;
    openSuggestCard(e.latlng);
  });

  /* ---------- load ---------- */

  function load() {
    return Promise.all([
      fetch("/api/stops").then(function (r) { return r.json(); }),
      fetch("/api/links").then(function (r) { return r.json(); }),
    ])
      .then(function (results) {
        stops = (results[0].stops || []).map(function (s) {
          byId[s.id] = s;
          return s;
        });
        links = results[1].links || [];
        renderNetwork();
        renderStops();
        fitAllStops([40, 40], 14);
      })
      .catch(function () {
        var errEl = document.getElementById("map-error");
        errEl.textContent = "Couldn't load the map data - check your connection and refresh.";
        errEl.hidden = false;
      });
  }

  function highlightRoutesClear() {
    hlLayer.clearLayers();
    legendEl.hidden = true;
  }

  load();
})();