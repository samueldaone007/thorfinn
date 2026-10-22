/* ============================================================
   Admin review of public stop suggestions (/admin/suggestions).
   Lists suggestion groups; approve creates the stop (name
   editable), reject declines it. CSRF via X-CSRF-Token header.
   ============================================================ */

(function () {
  "use strict";

  var listEl = document.getElementById("list");
  var emptyEl = document.getElementById("empty");
  var toastEl = document.getElementById("toast");
  var csrfToken = document.querySelector('input[name="csrf_token"]').value;

  var el = T.el;
  function toast(message, isError) { T.toast(toastEl, message, isError); }
  var api = T.apiWith(csrfToken);

  function statusBadge(status) {
    return el("span", { class: "badge st-" + status }, [status]);
  }

  function card(group) {
    var head = el("div", { class: "card-head" }, [
      el("div", {}, [
        el("strong", { class: "sugg-name" },
          [group.representative_name || "Unnamed stop"]),
        el("div", { class: "muted small" },
          ["suggested " + ((group.created_at || "").slice(0, 10) || "unknown date")]),
      ]),
      statusBadge(group.status),
    ]);

    var meta = el("div", { class: "sugg-meta muted small" }, [
      group.distinct_user_count + " distinct device(s)",
      " \u00b7 " + group.submission_count + " submission(s)",
      " \u00b7 near " + group.centre_lat.toFixed(5) + ", " + group.centre_lng.toFixed(5),
    ]);

    var actions;
    if (group.status === "pending" || group.status === "alerted") {
      var nameInput = el("input", {
        class: "tf", type: "text", maxlength: 200,
        value: group.representative_name || "",
      });
      actions = el("div", { class: "sugg-actions" }, [
        el("label", { class: "lab" }, ["Stop name (editable)"]),
        nameInput,
        el("div", { class: "pop-actions" }, [
          el("button", { class: "btn btn-sm btn-primary", type: "button",
            onclick: function () { approve(group, nameInput); } }, ["Approve"]),
          el("button", { class: "btn btn-sm btn-danger", type: "button",
            onclick: function () { reject(group); } }, ["Reject"]),
        ]),
      ]);
    } else {
      actions = el("div", { class: "muted small" }, ["Already handled."]);
    }

    return el("div", { class: "sugg-card" + (group.status === "alerted" ? " alerted" : "") },
      [head, meta, actions]);
  }

  function load() {
    return api("/admin/api/suggestions")
      .then(function (data) {
        var groups = data.groups || [];
        emptyEl.hidden = groups.length > 0;
        listEl.textContent = "";
        groups.forEach(function (group) { listEl.appendChild(card(group)); });
      })
      .catch(function (err) { toast(err.message, true); });
  }

  function approve(group, nameInput) {
    var name = nameInput.value.trim() || group.representative_name || "Unnamed stop";
    api("/admin/api/suggestions/" + group.id + "/approve", "POST", { name: name })
      .then(function () {
        toast("Stop added: " + name);
        return load();
      })
      .catch(function (err) { toast(err.message, true); });
  }

  function reject(group) {
    if (!window.confirm(
      "Reject the suggestion for \"" + (group.representative_name || "this stop") + "\"?"
    )) return;
    api("/admin/api/suggestions/" + group.id + "/reject", "POST")
      .then(function () {
        toast("Suggestion rejected.");
        return load();
      })
      .catch(function (err) { toast(err.message, true); });
  }

  load();
})();