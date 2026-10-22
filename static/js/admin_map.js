/* ============================================================
   Admin map: add / edit / delete stops, and click-to-create
   one-directional links with fare ranges.

   All user-supplied text is inserted with textContent / building
   DOM nodes (never innerHTML), which prevents XSS via stop names.
   ============================================================ */

(function () {
  "use strict";

  var mapEl = document.getElementById("map");
  var csrfToken = mapEl.dataset.csrf;

  var el = T.el;
  var isMapLayerClick = T.isLayerClick;
  var bearingDeg = T.bearingDeg;
  var midpoint = T.midpoint;
  var arrowIcon = T.arrowIcon;
  var api = T.apiWith(csrfToken);

  var map = L.map("map").setView(
    [parseFloat(mapEl.dataset.centerLat), parseFloat(mapEl.dataset.centerLng)],
    12
  );

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  /* ---------- state ---------- */

  var state = {
    stops: new Map(),   // id -> {..., marker}
    links: [],          // {id, from_stop_id, to_stop_id, vehicle, fare_min, fare_max}
    mode: "stop",       // "stop" (click map = new stop) or "link" (pick two stops)
    sourceId: null,     // first stop chosen while creating a link
  };

  var layerStops = L.layerGroup().addTo(map);
  var layerLinks = L.layerGroup().addTo(map);
  var justDragged = false;

  /* ---------- tiny helpers ---------- */

  var toastEl = document.getElementById("toast");
  function toast(message, isError) { T.toast(toastEl, message, isError); }

  function updateEmptyState() {
    document.getElementById("empty-state").hidden = state.stops.size !== 0;
  }

  function setModeHint(text) {
    document.getElementById("mode-hint").textContent = text;
  }

  function stopById(id) { return state.stops.get(id) || null; }

  /* ---------- map rendering ---------- */

  function stopIcon(selected) {
    var cls = "stop-dot" + (selected ? " selected" : "");
    return L.divIcon({
      className: "stop-wrap",
      html: '<div class="' + cls + '"></div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
  }

  function addStopMarker(stop) {
    var marker = L.marker([stop.lat, stop.lng], {
      icon: stopIcon(false),
      draggable: true,
    });

    marker.on("click", function () {
      if (justDragged) return;
      if (state.mode === "link") onMarkerPick(stop);
      else openStopPopup(stop, marker);
    });

    marker.on("dragstart", function () { justDragged = true; });
    marker.on("dragend", function (e) {
      var ll = e.target.getLatLng();
      setModeHint("Saving new position\u2026");
      api("/admin/api/stops/" + stop.id, "PATCH", { lat: ll.lat, lng: ll.lng })
        .then(refresh)
        .catch(function (err) { toast(err.message, true); refresh(); })
        .then(function () { setTimeout(function () { justDragged = false; }, 200); });
    });

    stop.marker = marker;
    state.stops.set(stop.id, stop);  // needed by addLinkLine / highlightSelection
    layerStops.addLayer(marker);
  }

  function addLinkLine(link) {
    var a = stopById(link.from_stop_id);
    var b = stopById(link.to_stop_id);
    if (!a || !b) return;

    var line = L.polyline(
      [[a.lat, a.lng], [b.lat, b.lng]],
      { color: "#c1121f", weight: 3, opacity: 0.9 }
    );
    line.on("click", function () { openLinkPopup(link); });
    layerLinks.addLayer(line);

    // Arrowhead halfway along, rotated to point in the travel direction.
    var arrow = L.marker(midpoint(a, b), {
      icon: arrowIcon(bearingDeg(a, b) - 90),
      interactive: false,
    });
    layerLinks.addLayer(arrow);
  }

  function clearLayers() {
    layerStops.clearLayers();
    layerLinks.clearLayers();
    state.stops.clear();
    state.links = [];
    state.sourceId = null;
  }

  function refresh() {
    return api("/admin/api/stops")
      .then(function (data) {
        clearLayers();
        (data.stops || []).forEach(addStopMarker);
        (data.links || []).forEach(addLinkLine);
        updateEmptyState();
      })
      .catch(function (err) { toast(err.message, true); });
  }

  /* ---------- mode switching ---------- */

  function setMode(mode) {
    state.mode = mode;
    state.sourceId = null;
    document.getElementById("btn-stop").classList.toggle("active", mode === "stop");
    document.getElementById("btn-link").classList.toggle("active", mode === "link");
    if (mode === "stop") setModeHint("Click the map to drop a new stop.");
    else setModeHint("Click the first stop (the source).");
    highlightSelection();
  }

  function highlightSelection() {
    state.stops.forEach(function (stop) {
      if (stop.marker) stop.marker.setIcon(stopIcon(stop.id === state.sourceId));
    });
  }

  function onMarkerPick(stop) {
    if (state.sourceId === null) {
      state.sourceId = stop.id;
      highlightSelection();
      setModeHint("Now click the destination stop.");
    } else if (state.sourceId === stop.id) {
      setModeHint("Pick a different stop as the destination.");
    } else {
      openLinkForm(stopById(state.sourceId), stop);
    }
  }

  /* ---------- stop popups ---------- */

  function openStopPopup(stop, marker) {
    if (!marker.getPopup()) marker.bindPopup(buildStopView(stop, marker), { autoPan: true });
    else marker.setPopupContent(buildStopView(stop, marker));
    marker.openPopup();
  }

  function buildStopView(stop, marker) {
    var linkCount = state.links.filter(
      function (l) { return l.from_stop_id === stop.id || l.to_stop_id === stop.id; }
    ).length;

    var children = [
      el("div", { class: "pop-title" }, [stop.name]),
    ];
    if (stop.area) children.push(el("div", { class: "muted small" }, ["Area: " + stop.area]));
    if (stop.landmark) children.push(el("div", { class: "muted small" }, ["Near: " + stop.landmark]));
    children.push(el("div", { class: "muted small" }, [linkCount + " link(s) in total."]));

    var row = el("div", { class: "pop-actions" }, [
      el("button", { class: "btn btn-sm", type: "button", onclick: function () {
        marker.setPopupContent(buildStopEdit(stop, marker));
      } }, ["Edit"]),
      el("button", { class: "btn btn-sm btn-danger", type: "button", onclick: function () {
        deleteStop(stop);
      } }, ["Delete"]),
    ]);
    children.push(row);
    return el("div", { class: "pop" }, children);
  }

  function buildStopEdit(stop, marker) {
    var name = el("input", { class: "tf", type: "text", maxlength: 200, value: stop.name });
    var landmark = el("input", { class: "tf", type: "text", maxlength: 200, value: stop.landmark || "" });
    var area = el("input", { class: "tf", type: "text", maxlength: 120, value: stop.area || "" });
    var msg = el("div", { class: "form-err", hidden: true });

    var cancelBtn = el("button", { class: "btn btn-sm", type: "button", onclick: function () {
      marker.setPopupContent(buildStopView(stop, marker));
    } }, ["Cancel"]);

    var saveBtn = el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: function () {
      var cleaned = name.value.trim();
      if (!cleaned) { msg.hidden = false; msg.textContent = "Name is required."; return; }
      saveBtn.disabled = true;
      api("/admin/api/stops/" + stop.id, "PATCH", {
        name: cleaned, landmark: landmark.value.trim(), area: area.value.trim(),
      }).then(refresh).catch(function (err) {
        msg.hidden = false; msg.textContent = err.message; saveBtn.disabled = false;
      });
    } }, ["Save"]);

    return el("div", { class: "pop" }, [
      el("label", { class: "lab" }, ["Name"]), name,
      el("label", { class: "lab" }, ["Landmark (optional)"]), landmark,
      el("label", { class: "lab" }, ["Area (optional)"]), area,
      msg,
      el("div", { class: "pop-actions" }, [cancelBtn, saveBtn]),
    ]);
  }

  function deleteStop(stop) {
    var linkCount = state.links.filter(
      function (l) { return l.from_stop_id === stop.id || l.to_stop_id === stop.id; }
    ).length;
    var warning = linkCount > 0
      ? "\nIt has " + linkCount + " link(s), which will be deleted too."
      : "";
    if (!window.confirm("Delete stop \"" + stop.name + "\"?" + warning)) return;
    api("/admin/api/stops/" + stop.id, "DELETE")
      .then(refresh)
      .catch(function (err) { toast(err.message, true); });
  }

  function openNewStopForm(latlng) {
    var name = el("input", { class: "tf", type: "text", maxlength: 200, autocomplete: "off" });
    var landmark = el("input", { class: "tf", type: "text", maxlength: 200, autocomplete: "off" });
    var area = el("input", { class: "tf", type: "text", maxlength: 120, autocomplete: "off" });
    var msg = el("div", { class: "form-err", hidden: true });

    var form = el("div", { class: "pop" }, [
      el("div", { class: "pop-title" }, ["New stop"]),
      el("label", { class: "lab" }, ["Name"]), name,
      el("label", { class: "lab" }, ["Landmark (optional)"]), landmark,
      el("label", { class: "lab" }, ["Area (optional)"]), area,
      msg,
      el("div", { class: "pop-actions" }, [
        el("button", { class: "btn btn-sm", type: "button", onclick: function () { map.closePopup(); } }, ["Cancel"]),
        el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: function () {
          var cleaned = name.value.trim();
          if (!cleaned) { msg.hidden = false; msg.textContent = "Name is required."; return; }
          msg.hidden = true;
          api("/admin/api/stops", "POST", {
            name: cleaned,
            landmark: landmark.value.trim(),
            area: area.value.trim(),
            lat: latlng.lat,
            lng: latlng.lng,
          })
            .then(function () { map.closePopup(); return refresh(); })
            .catch(function (err) {
              msg.hidden = false; msg.textContent = err.message;
            });
        } }, ["Save"]),
      ]),
    ]);
    map.openPopup(form, latlng, { autoPan: true });
    window.setTimeout(function () { name.focus(); }, 50);
  }

  /* ---------- link popups ---------- */

  function openLinkForm(from, to) {
    var vehicleS = el("select", { class: "tf" }, [
      el("option", { value: "bus" }, ["Bus"]),
      el("option", { value: "car" }, ["Car / taxi"]),
      el("option", { value: "keke" }, ["Keke"]),
      el("option", { value: "other" }, ["Other"]),
    ]);
    var fareMin = el("input", { class: "tf", type: "number", min: "1", value: "" });
    var fareMax = el("input", { class: "tf", type: "number", min: "1", value: "" });
    var reverseChk = el("input", { class: "chk", type: "checkbox" });
    var revRow = el("div", { class: "rev-fields", hidden: true }, [
      el("label", { class: "lab" }, ["Reverse fare min (N)"]),
      el("input", { class: "tf", type: "number", min: "1" }),
      el("label", { class: "lab" }, ["Reverse fare max (N)"]),
      el("input", { class: "tf", type: "number", min: "1" }),
    ]);
    reverseChk.addEventListener("change", function () {
      revRow.hidden = !reverseChk.checked;
    });
    var msg = el("div", { class: "form-err", hidden: true });

    function cancel() {
      state.sourceId = null;
      highlightSelection();
      setModeHint("Click the first stop (the source).");
    }

    var form = el("div", { class: "pop" }, [
      el("div", { class: "pop-title" }, [from.name + " \u2192 " + to.name]),
      el("label", { class: "lab" }, ["Vehicle"]), vehicleS,
      el("div", { class: "form-row" }, [
        el("div", {}, [el("label", { class: "lab" }, ["Fare min (N)"]), fareMin]),
        el("div", {}, [el("label", { class: "lab" }, ["Fare max (N)"]), fareMax]),
      ]),
      el("label", { class: "lab chk-lab" }, [
        reverseChk, " Also create the reverse direction",
      ]),
      revRow,
      msg,
      el("div", { class: "pop-actions" }, [
        el("button", { class: "btn btn-sm", type: "button", onclick: cancel }, ["Cancel"]),
        el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: function () {
          var fMin = parseInt(fareMin.value, 10);
          var fMax = parseInt(fareMax.value, 10);
          if (!(fMin >= 1) || !(fMax >= 1) || isNaN(fMin) || isNaN(fMax)) {
            msg.hidden = false; msg.textContent = "Enter valid positive fares.";
            return;
          }
          if (fMax < fMin) {
            msg.hidden = false; msg.textContent = "Max fare cannot be below min fare.";
            return;
          }
          var body = {
            from_stop_id: from.id,
            to_stop_id: to.id,
            vehicle: vehicleS.value,
            fare_min: fMin,
            fare_max: fMax,
            reverse: reverseChk.checked,
          };
          if (reverseChk.checked) {
            var rMin = parseInt(revRow.querySelectorAll(".tf")[0].value, 10);
            var rMax = parseInt(revRow.querySelectorAll(".tf")[1].value, 10);
            if (!(rMin >= 1) || !(rMax >= 1) || isNaN(rMin) || isNaN(rMax)) {
              msg.hidden = false; msg.textContent = "Enter valid positive reverse fares.";
              return;
            }
            if (rMax < rMin) {
              msg.hidden = false; msg.textContent = "Reverse max fare cannot be below min.";
              return;
            }
            body.reverse_fare_min = rMin;
            body.reverse_fare_max = rMax;
          }
          msg.hidden = true;
          api("/admin/api/links", "POST", body)
            .then(function () { map.closePopup(); return refresh(); })
            .catch(function (err) { msg.hidden = false; msg.textContent = err.message; });
        } }, ["Save link"]),
      ]),
    ]);
    map.openPopup(form, [to.lat, to.lng], { autoPan: true });
  }

  function openLinkPopup(link) {
    var a = stopById(link.from_stop_id);
    var b = stopById(link.to_stop_id);
    if (!a || !b) return;

    function openView() {
      var view = el("div", { class: "pop" }, [
        el("div", { class: "pop-title" }, [a.name + " \u2192 " + b.name]),
        el("div", { class: "link-meta" }, [
          el("span", { class: "badge" }, [link.vehicle]),
          el("span", {}, ["\u20A6" + link.fare_min + " \u2013 \u20A6" + link.fare_max]),
        ]),
        el("div", { class: "muted small" },
          ["Confirmed: " + (link.last_confirmed ? link.last_confirmed.slice(0, 10) : "unknown")]),
        el("div", { class: "pop-actions" }, [
          el("button", { class: "btn btn-sm", type: "button", onclick: openEdit }, ["Edit"]),
          el("button", { class: "btn btn-sm btn-danger", type: "button", onclick: function () {
            if (!window.confirm("Delete the link " + a.name + " \u2192 " + b.name + "?")) return;
            api("/admin/api/links/" + link.id, "DELETE").then(refresh).catch(function (err) {
              toast(err.message, true);
            });
          } }, ["Delete"]),
        ]),
      ]);
      map.openPopup(view, midpoint(a, b), { autoPan: true });
    }

    function openEdit() {
      var vehicleS = el("select", { class: "tf" }, [
        el("option", { value: "bus" }, ["Bus"]),
        el("option", { value: "car" }, ["Car / taxi"]),
        el("option", { value: "keke" }, ["Keke"]),
        el("option", { value: "other" }, ["Other"]),
      ]);
      vehicleS.value = link.vehicle;
      var fareMin = el("input", { class: "tf", type: "number", min: "1", value: link.fare_min });
      var fareMax = el("input", { class: "tf", type: "number", min: "1", value: link.fare_max });
      var msg = el("div", { class: "form-err", hidden: true });

      var form = el("div", { class: "pop" }, [
        el("div", { class: "pop-title" }, ["Edit link: " + a.name + " \u2192 " + b.name]),
        el("label", { class: "lab" }, ["Vehicle"]), vehicleS,
        el("div", { class: "form-row" }, [
          el("div", {}, [el("label", { class: "lab" }, ["Fare min (N)"]), fareMin]),
          el("div", {}, [el("label", { class: "lab" }, ["Fare max (N)"]), fareMax]),
        ]),
        msg,
        el("div", { class: "pop-actions" }, [
          el("button", { class: "btn btn-sm", type: "button", onclick: openView }, ["Cancel"]),
          el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: function () {
            var fMin = parseInt(fareMin.value, 10);
            var fMax = parseInt(fareMax.value, 10);
            if (!(fMin >= 1) || !(fMax >= 1) || isNaN(fMin) || isNaN(fMax) || fMax < fMin) {
              msg.hidden = false; msg.textContent = "Enter valid positive fares (max >= min).";
              return;
            }
            msg.hidden = true;
            api("/admin/api/links/" + link.id, "PATCH", {
              vehicle: vehicleS.value, fare_min: fMin, fare_max: fMax,
            }).then(function () { map.closePopup(); return refresh(); }).catch(function (err) {
              msg.hidden = false; msg.textContent = err.message;
            });
          } }, ["Save"]),
        ]),
      ]);
      map.openPopup(form, midpoint(a, b), { autoPan: true });
    }

    openView();
  }

  /* ---------- map click ---------- */

  map.on("click", function (e) {
    if (justDragged || isMapLayerClick(e)) return;
    if (state.mode === "stop") {
      openNewStopForm(e.latlng);
    } else {
      // Clicking empty ground while adding a link cancels the picked source.
      state.sourceId = null;
      highlightSelection();
      setModeHint("Click the first stop (the source).");
    }
  });

  /* ---------- wire up ---------- */

  document.getElementById("btn-stop").addEventListener("click", function () { setMode("stop"); });
  document.getElementById("btn-link").addEventListener("click", function () { setMode("link"); });

  document.getElementById("verify-map").addEventListener("click", function () {
    if (!window.confirm("Mark the entire map as verified today? This re-confirms every stop and link.")) return;
    api("/admin/api/verify-all", "POST")
      .then(function (data) {
        toast("Map verified: " + data.stops_verified + " stops and " +
          data.links_verified + " links re-confirmed.");
        return refresh();
      })
      .catch(function (err) { toast(err.message, true); });
  });

  setMode("stop");
  refresh();
})();