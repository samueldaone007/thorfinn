/* ============================================================
   Public journey search: autocomplete, use-my-location, route
   results (cheapest vs fewest changes) and map highlighting.

   All rendered text goes through DOM build helpers (textContent),
   never innerHTML, so stop names can't inject HTML.
   ============================================================ */

(function () {
  "use strict";

  var el = T.el;
  var naira = T.naira;
  var haversineM = T.haversineM;
  var distText = T.distText;

  var stops = [];          // [{id, name, area, lat, lng}]
  var byName = {};         // lowercase name -> stop
  var routeData = null;
  var activeRoute = "cheapest";
  var routeLine = null;
  var youMarker = null;    // the "you are here" dot

  var fromInput = document.getElementById("from");
  var toInput = document.getElementById("to");
  var stopListEl = document.getElementById("stop-list");
  var resultsEl = document.getElementById("results");
  var noRouteEl = document.getElementById("no-route");
  var legsEl = document.getElementById("legs");
  var totalsEl = document.getElementById("totals");
  var tabsEl = document.getElementById("routes-tabs");
  var locNoteEl = document.getElementById("loc-note");

  var mapEl = document.getElementById("search-map");
  var map = L.map("search-map").setView(
    [parseFloat(mapEl.dataset.centerLat), parseFloat(mapEl.dataset.centerLng)], 12
  );
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  var markerLayer = L.layerGroup().addTo(map);
  var stopLayer = L.layerGroup().addTo(map);

  function loadStops() {
    return fetch("/api/stops")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        stops = data.stops || [];
        byName = {};
        stops.forEach(function (s) { byName[s.name.toLowerCase().trim()] = s; });
        stops.forEach(function (s) {
          var opt = el("option", { value: s.name });
          stopListEl.appendChild(opt);
        });
        document.getElementById("no-stops-note").hidden = stops.length > 0;
        renderStopDots();
      })
      .catch(function () {
        var noteEl = document.getElementById("no-stops-note");
        noteEl.textContent = "Couldn't load stops - check your connection and refresh.";
        noteEl.hidden = false;
      });
  }

  // Show every verified stop as a small dot on the map - the public "map of
  // stops". Each dot opens a popup with the stop's name and area.
  function renderStopDots() {
    stopLayer.clearLayers();
    stops.forEach(function (s) {
      var dot = L.circleMarker([s.lat, s.lng], {
        radius: 6,
        color: "#0b5394",
        weight: 1,
        fillColor: "#0b5394",
        fillOpacity: 0.9,
      });
      // Content builder returns a fresh DOM node per opening (safe: names are
      // added with textContent, never innerHTML).
      dot.bindPopup(function () {
        var d = document.createElement("div");
        var strong = document.createElement("strong");
        strong.textContent = s.name;
        d.appendChild(strong);
        if (s.area) {
          var small = document.createElement("div");
          small.textContent = "Area: " + s.area;
          d.appendChild(small);
        }
        return d;
      });
      stopLayer.addLayer(dot);
    });
  }

  /* ---------- form actions ---------- */

  function resolveName(input) {
    var stop = byName[(input.value || "").trim().toLowerCase()];
    return stop || null;
  }

  function note(text) {
    locNoteEl.textContent = text;
    locNoteEl.hidden = false;
  }

  // Free, key-less, CORS-enabled IP lookups tried one after another (at least
  // three providers). ipwho.is has proven the most accurate for this network,
  // so it goes first; geojs.io was removed entirely as too inaccurate. IP
  // geolocation is only city-level anyway - the ISPs gateway, never your exact
  // spot. A result only counts as "working" if it's near the network; far
  // answers (Kano, ~340 km) are skipped so the closest plausible fix wins.
  var IP_PROVIDERS = [
    {
      url: "https://ipwho.is/",
      parse: function (data) {
        if (!data || data.success === false) throw new Error("bad response");
        return {
          lat: data.latitude,
          lng: data.longitude,
          label: data.city || data.region || data.country || "",
        };
      },
    },
    {
      url: "https://ipapi.co/json/",
      parse: function (data) {
        if (!data) throw new Error("bad response");
        return {
          lat: data.latitude,
          lng: data.longitude,
          label: data.city || data.region || data.country_name || "",
        };
      },
    },
    {
      url: "https://freeipapi.com/api/json",
      parse: function (data) {
        return {
          lat: data.latitude,
          lng: data.longitude,
          label: data.cityName || data.regionName || data.countryName || "",
        };
      },
    },
  ];

  // A fix is only usable if it falls close to the network's own region. Kano
  // is ~340 km from every Abuja stop, so providers answering from that far
  // away get skipped in favour of more accurate ones.
  var NEAR_NETWORK_M = 200 * 1000;

  function ipLocate() {
    var idx = 0;
    var bestFar = null; // closest-to-Abuja answer we saw, kept as a last resort

    function distanceToNetwork(loc) {
      var best = Infinity;
      stops.forEach(function (s) {
        var d = haversineM(loc, s);
        if (d < best) best = d;
      });
      return best;
    }

    function attempt() {
      if (idx >= IP_PROVIDERS.length) {
        // Every provider answered from far away: return the closest one so the
        // caller's plausibility gate can explain it ("you look to be outside
        // the Abuja network") instead of silently dropping the feature.
        if (bestFar) {
          return Promise.resolve({
            lat: bestFar.lat,
            lng: bestFar.lng,
            label: bestFar.label,
          });
        }
        return Promise.reject(new Error("all IP lookups failed"));
      }
      var provider = IP_PROVIDERS[idx++];
      var controller = "AbortController" in window ? new AbortController() : null;
      var timer = controller
        ? setTimeout(function () { controller.abort(); }, 4000)
        : null;
      return fetch(provider.url, controller ? { signal: controller.signal } : {})
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(provider.parse)
        .then(function (loc) {
          var lat = parseFloat(loc.lat);
          var lng = parseFloat(loc.lng);
          if (!isFinite(lat) || !isFinite(lng)) throw new Error("bad coordinates");
          return { lat: lat, lng: lng, label: loc.label || "" };
        })
        .then(function (loc) {
          if (timer) clearTimeout(timer);
          var near = distanceToNetwork(loc);
          if (bestFar === null || near < bestFar._near) {
            loc._near = near;
            bestFar = loc;
          }
          if (near > NEAR_NETWORK_M) throw new Error("too far from the network");
          return loc;
        })
        .catch(function () {
          if (timer) clearTimeout(timer);
          return attempt();
        });
    }
    return attempt();
  }

  // Show a location pin, pick the nearest stop as the origin, and explain how
  // good the fix is. `approxMsg` is set for network/IP locations.
  function showLocation(lat, lng, accuracy, approxMsg) {
    console.log(
      "[Thorfinn] location:", lat, lng,
      "accuracy:", accuracy != null ? Math.round(accuracy) + "m" : "n/a",
      approxMsg ? "(approximate)" : ""
    );

    var poor = !!approxMsg || (accuracy != null && accuracy > 1000);
    var accText = approxMsg
      ? "approximate"
      : (accuracy != null
          ? (accuracy >= 1000
              ? "\u00b1" + Math.round(accuracy / 1000) + " km"
              : "\u00b1" + Math.round(accuracy) + " m")
          : "accuracy unknown");
    var coords = lat.toFixed(4) + ", " + lng.toFixed(4) + " (" + accText + ")";

    var nearest = null;
    var best = Infinity;
    stops.forEach(function (s) {
      var d = haversineM({ lat: lat, lng: lng }, s);
      if (d < best) { best = d; nearest = s; }
    });

    // Abuja metro is small (~40 km across). If we located ourselves far from
    // every stop the fix is not usable for choosing an origin - auto-picking
    // one would silently plan from the wrong city. Explain and leave the
    // fields alone instead. (Nigerian IP geolocation is unreliable and often
    // resolves to a distant city like Kano.)
    var OUTSIDE_M = 50 * 1000;
    if (!stops.length || !nearest || best > OUTSIDE_M) {
      var farLine = nearest
        ? "about " + distText(best) + " from " + nearest.name
        : "far from any stop";
      locNoteEl.classList.toggle("loc-note-warn", true);
      note("You look to be " + farLine +
        " - outside the Abuja network, so no origin was picked. " +
        "Location: " + coords + ". If you are really in Abuja, type a stop below.");
      if (approxMsg) locNoteEl.textContent += " " + approxMsg;
      return;
    }

    if (youMarker) { map.removeLayer(youMarker); youMarker = null; }
    youMarker = L.circleMarker([lat, lng], {
      radius: 8,
      color: "#ffffff",
      weight: 3,
      fillColor: approxMsg ? "#b26a00" : "#d35400",
      fillOpacity: 1,
    }).addTo(map);

    youMarker.bindPopup(
      (poor ? "Approximate location - not exact<br>" : "You are here<br>") + coords,
      { autoPan: false }
    );
    youMarker.openPopup();

    locNoteEl.classList.toggle("loc-note-warn", poor);
    fromInput.value = nearest.name;
    note("Using " + nearest.name + " - nearest stop, about " + distText(best) +
      " away. Location: " + coords + ".");
    if (approxMsg) locNoteEl.textContent += " " + approxMsg;
    else if (poor) locNoteEl.textContent += " Your device gave only a rough fix.";

    map.flyTo([lat, lng], poor ? 11 : 15);
  }

  document.getElementById("use-my-loc").addEventListener("click", function () {
    var btn = this;
    locNoteEl.hidden = true;
    locNoteEl.classList.remove("loc-note-warn");

    // Geolocation is only allowed on HTTPS or localhost (secure context).
    if (!window.isSecureContext) {
      note("Location needs HTTPS or localhost. Open the app at http://127.0.0.1:8000.");
      return;
    }
    if (!stops.length) {
      note("No stops are on the map yet.");
      return;
    }

    btn.disabled = true;

    function useNetworkEstimate(reason) {
      ipLocate()
        .then(function (loc) {
          btn.disabled = false;
          showLocation(loc.lat, loc.lng, null,
            "Estimated from your network" +
            (loc.label ? " (" + loc.label + ")" : "") +
            (reason ? ". " + reason : ""));
        })
        .catch(function () {
          btn.disabled = false;
          note((reason ? reason + " " : "") + "Could not determine your location.");
        });
    }

    if (!navigator.geolocation) {
      useNetworkEstimate("This browser has no GPS.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        var acc = pos.coords.accuracy;
        if (acc != null && acc > 2000) {
          useNetworkEstimate("Your device's GPS fix was too rough (" + distText(acc) + ").");
          return;
        }
        btn.disabled = false;
        showLocation(pos.coords.latitude, pos.coords.longitude, acc, null);
      },
      function () {
        useNetworkEstimate("Device location isn't available.");
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  });

  document.getElementById("swap").addEventListener("click", function () {
    var tmp = fromInput.value;
    fromInput.value = toInput.value;
    toInput.value = tmp;
  });

  document.getElementById("search-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var from = resolveName(fromInput);
    var to = resolveName(toInput);
    if (!from || !to) {
      showNoRoute("Please pick a stop from the suggestions for both fields.");
      return;
    }
    if (from.id === to.id) {
      showNoRoute("Start and destination are the same stop.");
      return;
    }
    findAndShow(from.id, to.id);
  });

  function findAndShow(fromId, toId) {
    resultsEl.hidden = true;
    noRouteEl.hidden = true;
    clearRouteLine();
    fetch("/api/route?from_id=" + fromId + "&to_id=" + toId)
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) {
            var msg = data && data.detail;
            throw new Error(typeof msg === "string" ? msg : "Could not find a route.");
          }
          return data;
        });
      })
      .then(render)
      .catch(function (err) { showNoRoute(err.message); });
  }

  /* ---------- rendering ---------- */

  function legOptions(leg) {
    return leg.options.map(function (opt, i) {
      return el("div", { class: "leg-opt" + (i === 0 ? " picked" : "") }, [
        el("span", { class: "badge" }, [opt.vehicle]),
        el("span", {}, [naira(opt.fare_min) + " \u2013 " + naira(opt.fare_max)]),
      ]);
    });
  }

  function render(data) {
    if (data.no_route) {
      showNoRoute(data.message || "No route found in that direction.");
      return;
    }

    routeData = data;
    var cheap = data.cheapest;
    var fewest = data.fewest_changes;
    var identical = JSON.stringify(cheap.legs) === JSON.stringify(fewest.legs);

    if (identical) {
      activeRoute = "cheapest";
      tabsEl.hidden = true;
      tabsEl.querySelector("#tab-cheap").classList.remove("active");
      tabsEl.querySelector("#tab-fewest").classList.remove("active");
    } else {
      tabsEl.hidden = false;
      activeRoute = "cheapest";
      setActiveTab();
    }

    resultsEl.hidden = false;
    noRouteEl.hidden = true;
    renderLegs();
    drawRoute();
  }

  function setActiveTab() {
    tabsEl.querySelector("#tab-cheap").classList.toggle("active", activeRoute === "cheapest");
    tabsEl.querySelector("#tab-fewest").classList.toggle("active", activeRoute === "fewest_changes");
  }

  document.getElementById("tab-cheap").addEventListener("click", function () {
    activeRoute = "cheapest"; setActiveTab(); renderLegs(); drawRoute();
  });
  document.getElementById("tab-fewest").addEventListener("click", function () {
    activeRoute = "fewest_changes"; setActiveTab(); renderLegs(); drawRoute();
  });

  function renderLegs() {
    legsEl.textContent = "";
    var route = routeData[activeRoute];
    route.legs.forEach(function (leg, index) {
      if (index > 0) {
        legsEl.appendChild(el("div", { class: "change " }, [
          el("span", { class: "badge badge-soft" }, ["change vehicle"]),
        ]));
      }
      var card = el("div", { class: "leg" }, [
        el("div", { class: "leg-head" }, [
          el("span", { class: "leg-num" }, ["" + (index + 1)]),
          el("span", {}, [leg.from.name + " \u2192 " + leg.to.name]),
        ]),
      ]);
      legOptions(leg).forEach(function (opt) { card.appendChild(opt); });
      var confirmed = leg.primary.last_confirmed
        ? "Confirmed " + leg.primary.last_confirmed.slice(0, 10)
        : "not yet confirmed";
      card.appendChild(el("div", { class: "muted small" }, [confirmed]));
      legsEl.appendChild(card);
    });

    totalsEl.textContent = "Total: " + naira(route.total_min) + " \u2013 " + naira(route.total_max) +
      (route.changes > 0 ? " \u00b7 " + route.changes + " change(s)" : " \u00b7 direct");
  }

  function drawRoute() {
    clearRouteLine();
    markerLayer.clearLayers();
    var route = routeData[activeRoute];
    var pts = [[route.legs[0].from.lat, route.legs[0].from.lng]];
    route.legs.forEach(function (leg) { pts.push([leg.to.lat, leg.to.lng]); });
    routeLine = L.polyline(pts, { color: "#0b5394", weight: 4, opacity: 0.9 }).addTo(map);

    // Popups render names with textContent (never innerHTML), so a stop name
    // can't inject markup no matter who typed it.
    function namePopup(name) {
      return function () {
        var strong = document.createElement("strong");
        strong.textContent = name;
        return strong;
      };
    }
    var first = pts[0];
    var last = pts[pts.length - 1];
    L.marker(first, { title: routeData.from.name }).addTo(markerLayer)
      .bindPopup(namePopup(routeData.from.name));
    L.marker(last, { title: routeData.to.name }).addTo(markerLayer)
      .bindPopup(namePopup(routeData.to.name));
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  }

  function clearRouteLine() {
    if (routeLine) {
      map.removeLayer(routeLine);
      routeLine = null;
    }
    markerLayer.clearLayers();
  }

  function showNoRoute(message) {
    resultsEl.hidden = true;
    noRouteEl.textContent = "";
    noRouteEl.appendChild(el("strong", {}, ["No route"]));
    noRouteEl.appendChild(el("div", { class: "muted" }, [message]));
    noRouteEl.hidden = false;
    clearRouteLine();
  }

  /* ---------- start ---------- */

  loadStops();
})();